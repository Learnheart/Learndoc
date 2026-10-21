// Changeset lifecycle: run claude, validate, keep previews, accept (write + commit) or cancel.
// Records live in memory and, while open, in .learndoc/changesets/<id>.json.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyChangeset, diffLessons, excludeGroups, summarizeChanges } from '../delta/changeset.mjs';
import { resolveSelection } from '../delta/selection.mjs';
import { selectDiagnostics } from '../lib/diagnostics.mjs';
import * as git from '../lib/git.mjs';
import { CONFIG_FILE, COURSE_FILE, SKILL_ROOT, STATE_DIR, formatJson, lessonFile, readJson } from '../lib/project.mjs';
import { buildContextPack } from './context.mjs';
import { evaluateAnswer, evaluateChangeset, focusWarnings, newDiagnostics } from './edit-validation.mjs';
import { runClaude } from './spawner.mjs';

const MODES = ['replace', 'insert', 'ask'];
const TERMINAL = new Set(['accepted', 'cancelled', 'answered']);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;
export const DEFAULT_MODEL = 'sonnet';
const DEFAULT_MAX_RELATED = 8;
const MAX_DIAGNOSTICS = 20;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const cliSchema = (name) => fs.readFileSync(path.join(SKILL_ROOT, 'schemas', `${name}.schema.json`), 'utf8');
const SCHEMAS = { changeset: cliSchema('changeset'), answer: cliSchema('answer') };

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const newBlockId = () => `b-${Array.from({ length: 8 }, () => ID_CHARS[crypto.randomInt(ID_CHARS.length)]).join('')}`;

// Git blob id of the file's current content: equals `git rev-parse HEAD:<file>` while the file is
// committed and clean, and also changes on uncommitted edits.
function fileRev(file) {
  const content = fs.readFileSync(file);
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

const lessonRel = (id) => `lessons/${id}.json`;

export class Store {
  constructor({ root }) {
    this.root = root;
    this.records = new Map();
    this.running = new Map(); // id -> { cancel } of the claude call in flight
    this.dir = path.join(root, STATE_DIR, 'changesets');
  }

  // ---------- project files ----------

  config() {
    return this.readProjectJson(CONFIG_FILE);
  }

  course() {
    return this.readProjectJson(COURSE_FILE);
  }

  project() {
    return { root: this.root, config: this.config(), course: this.course() };
  }

  readProjectJson(name) {
    const { value, diagnostic } = readJson(path.join(this.root, name), { root: this.root });
    if (diagnostic) throw new HttpError(500, 'project_invalid', diagnostic.message);
    return value;
  }

  // 404 unless the lesson is listed in course.json and its file exists.
  lesson(lessonId) {
    const listed = this.course().modules.some((m) => m.lessons.some((l) => l.id === lessonId));
    const file = lessonFile(this.root, lessonId);
    if (!listed || !fs.existsSync(file)) throw new HttpError(404, 'not_found', `no lesson "${lessonId}"`);
    const { value, diagnostic } = readJson(file, { root: this.root });
    if (diagnostic) throw new HttpError(500, 'lesson_invalid', diagnostic.message);
    return { lesson: value, rev: fileRev(file), file };
  }

  // ---------- persistence ----------

  load() {
    if (!fs.existsSync(this.dir)) return;
    for (const name of fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'))) {
      let rec;
      try {
        rec = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
      } catch {
        continue; // a corrupt state file only loses that changeset
      }
      this.records.set(rec.id, rec);
      if (rec.status === 'running') {
        Object.assign(rec, { status: 'failed', error: 'interrupted by a server restart' });
        this.save(rec);
      }
    }
  }

  save(rec) {
    const file = path.join(this.dir, `${rec.id}.json`);
    if (!this.isOpen(rec)) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    writeAtomic(file, JSON.stringify(rec), 0o600);
  }

  // ---------- queries ----------

  get(id) {
    const rec = this.records.get(id);
    if (!rec) throw new HttpError(404, 'not_found', `no changeset "${id}"`);
    return rec;
  }

  // A failed changeset without any preview holds nothing, so it does not lock the lesson either.
  isOpen(rec) {
    if (TERMINAL.has(rec.status)) return false;
    return !(rec.status === 'failed' && rec.rounds.length === 0);
  }

  openFor(lessonId) {
    return [...this.records.values()].find((r) => r.lessonId === lessonId && this.isOpen(r)) ?? null;
  }

  preview(rec) {
    let lesson = rec.base;
    for (const round of rec.rounds) lesson = applyChangeset(lesson, round.changeset, { newId: newBlockId }).lesson;
    return lesson;
  }

  view(id) {
    const rec = this.get(id);
    const preview = this.preview(rec);
    const changes = diffLessons(rec.base, preview, rec.rounds.map((r) => r.applied));
    return {
      id: rec.id, lessonId: rec.lessonId, mode: rec.mode, status: rec.status, round: rec.round,
      summary: rec.summary, counts: summarizeChanges(rec.base, changes), changes, warnings: rec.warnings,
      focus: rec.focus, preview,
      ...(rec.needsConfirmation && { needsConfirmation: rec.needsConfirmation }),
      ...(rec.answer && { answer: rec.answer }),
      ...(rec.error && { error: rec.error }),
      ...(rec.diagnostics?.length && { diagnostics: rec.diagnostics }),
      usage: rec.usage,
    };
  }

  // A notes file that cannot be parsed reads as empty (and is replaced by the next note).
  notes(lessonId) {
    const file = this.notesFile(lessonId);
    if (!fs.existsSync(file)) return [];
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      console.warn(`learndoc: ignoring unreadable ${file}: ${error.message}`);
      return [];
    }
  }

  notesFile(lessonId) {
    return path.join(this.root, STATE_DIR, 'notes', `${lessonId}.json`);
  }

  // ---------- commands ----------

  startEdit({ lessonId, mode, instruction, selection, model }) {
    if (!MODES.includes(mode)) throw new HttpError(400, 'bad_request', `mode must be one of ${MODES.join(', ')}`);
    requireInstruction(instruction);
    requireSelection(selection);
    const { lesson, rev } = this.lesson(lessonId);
    const open = this.openFor(lessonId);
    if (open) throw new HttpError(409, 'changeset_open', `lesson "${lessonId}" already has an open changeset (${open.id})`);
    const config = this.config();
    const rec = {
      id: `cs-${crypto.randomBytes(6).toString('hex')}`, lessonId, mode, status: 'running', round: 1,
      model: checkModel(model ?? config.editModel ?? DEFAULT_MODEL), baseRev: rev, base: lesson,
      createdAt: new Date().toISOString(), maxRelated: config.edit?.maxRelated ?? DEFAULT_MAX_RELATED,
      rounds: [], request: null, focus: null, summary: '', warnings: [], usage: { costUsd: 0, durationMs: 0 },
    };
    this.records.set(rec.id, rec);
    this.launch(rec, { mode, instruction, focus: resolveSelection(lesson, selection) });
    return rec.id;
  }

  refine(id, { instruction, selection, model } = {}) {
    const rec = this.get(id);
    if (rec.mode === 'ask') throw new HttpError(400, 'bad_request', 'an ask cannot be refined');
    if (!this.canUsePreview(rec)) throw new HttpError(409, 'not_ready', `changeset is ${rec.status}`);
    requireInstruction(instruction);
    if (selection !== undefined) requireSelection(selection);
    if (model !== undefined) rec.model = checkModel(model);
    const preview = this.preview(rec);
    const focus = resolveSelection(preview, selection ?? { focusBlockIds: this.changedBlockIds(rec, preview), ranges: [] });
    rec.round += 1;
    this.launch(rec, { mode: 'replace', instruction, focus });
    return rec.id;
  }

  confirm(id) {
    const rec = this.get(id);
    if (rec.status !== 'needs_confirmation') throw new HttpError(409, 'not_ready', `changeset is ${rec.status}`);
    const { scope } = rec.needsConfirmation;
    rec.maxRelated = Math.max(rec.maxRelated, scope.length);
    this.launch(rec, { ...rec.request, confirmedScope: scope });
    return rec.id;
  }

  // Cancelling a finished changeset (accepted, cancelled, answered) changes nothing.
  cancel(id) {
    const rec = this.get(id);
    if (TERMINAL.has(rec.status)) return;
    this.running.get(id)?.cancel();
    rec.status = 'cancelled';
    this.save(rec);
  }

  cancelAll() {
    for (const handle of this.running.values()) handle.cancel();
  }

  async accept(id, { excludeGroups: groups = [] } = {}) {
    const rec = this.get(id);
    if (rec.mode === 'ask') throw new HttpError(400, 'bad_request', 'an ask has nothing to accept');
    if (!this.canUsePreview(rec)) throw new HttpError(409, 'not_ready', `changeset is ${rec.status}`);
    const lesson = await this.buildAcceptedLesson(rec, groups);
    // Re-checked after the awaits: another request may have accepted, refined or cancelled meanwhile.
    if (!this.canUsePreview(rec)) throw new HttpError(409, 'not_ready', `changeset is ${rec.status}`);
    const { file } = this.lesson(rec.lessonId);
    if (fileRev(file) !== rec.baseRev) throw new HttpError(409, 'stale', 'the lesson changed on disk after this changeset started');
    const summary = rec.rounds.map((r) => r.summary).filter(Boolean).at(-1) || 'edit';
    // commit is null when the accepted lesson equals the file (a no-op accept).
    const commit = withRollback(file, () => {
      writeAtomic(file, formatJson(lesson));
      return git.commitPaths(this.root, [lessonRel(rec.lessonId)], `learndoc: ${oneLine(summary)}`);
    });
    rec.status = 'accepted';
    this.save(rec);
    return { lesson, rev: fileRev(file), commit };
  }

  // The base lesson with every round applied minus the excluded groups; 422 when what is left
  // does not apply cleanly or is invalid.
  async buildAcceptedLesson(rec, groups) {
    let lesson = rec.base;
    for (const round of rec.rounds) {
      const result = applyChangeset(lesson, excludeGroups(round.changeset, groups), { newId: newBlockId });
      if (result.errors.length) throw new HttpError(422, 'invalid', `excluding those groups breaks the changeset: ${result.errors[0].message}`);
      lesson = result.lesson;
    }
    if (groups.length) {
      const broken = (await newDiagnostics(rec.base, lesson, this.project())).find((d) => d.severity === 'error');
      if (broken) throw new HttpError(422, 'invalid', `excluding those groups leaves the lesson invalid: ${broken.message}`);
    }
    return lesson;
  }

  // -> [{ commit, date, summary, restorable }]; a commit that created the lesson file has no
  // earlier version to restore.
  history(lessonId) {
    this.lesson(lessonId);
    const rel = lessonRel(lessonId);
    const added = git.commitsAdding(this.root, rel);
    return git.log(this.root, rel).map((c) => ({ ...c, restorable: !added.has(c.commit) }));
  }

  // Restores the lesson file as it was before `commit`, as a new commit (null when nothing changed).
  restoreBefore(lessonId, commit) {
    const { file } = this.lesson(lessonId);
    const rel = lessonRel(lessonId);
    if (typeof commit !== 'string' || !git.log(this.root, rel, { limit: 1000 }).some((c) => c.commit === commit)) {
      throw new HttpError(400, 'bad_request', 'commit must be a full hash from this lesson\'s history');
    }
    if (git.commitsAdding(this.root, rel).has(commit)) {
      throw new HttpError(409, 'history/no-parent', `the lesson did not exist before ${commit.slice(0, 7)}, so there is no earlier version to restore`);
    }
    if (this.openFor(lessonId)) throw new HttpError(409, 'changeset_open', 'the lesson has an open changeset');
    let created;
    try {
      created = withRollback(file, () => git.revert(this.root, rel, `${commit}^`, `learndoc: restore before ${commit.slice(0, 7)}`));
    } catch (error) {
      throw new HttpError(409, 'cannot_restore', `cannot restore the lesson from before ${commit.slice(0, 7)}: ${error.message}`);
    }
    const { lesson, rev } = this.lesson(lessonId);
    return { lesson, rev, commit: created };
  }

  canUsePreview(rec) {
    return rec.rounds.length > 0 && (rec.status === 'ready' || rec.status === 'failed');
  }

  changedBlockIds(rec, preview) {
    return diffLessons(rec.base, preview, []).filter((c) => c.op !== 'delete').map((c) => c.blockId);
  }

  // ---------- running claude ----------

  launch(rec, request) {
    Object.assign(rec, { status: 'running', request, focus: request.focus, error: undefined, diagnostics: undefined, needsConfirmation: undefined });
    this.save(rec);
    this.execute(rec, request).catch((error) => this.finish(rec, { status: 'failed', error: error.message }));
  }

  async execute(rec, request) {
    const project = this.project();
    const current = this.preview(rec);
    const pack = (retry) => buildContextPack({
      root: this.root, config: project.config, lesson: current, mode: request.mode, instruction: request.instruction,
      focus: request.focus, maxRelated: rec.maxRelated, previousSummaries: rec.rounds.map((r) => r.summary),
      confirmedScope: request.confirmedScope, retry,
    });
    const evaluate = (value) => (request.mode === 'ask'
      ? evaluateAnswer(value, current, project)
      : evaluateChangeset(value, current, {
        focus: request.focus, maxRelated: rec.maxRelated, round: rec.rounds.length + 1, newId: newBlockId,
        originalIds: new Set(rec.base.blocks.map((b) => b.id)), project,
      }));

    let retry;
    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = await this.call(rec, await pack(retry), request.mode === 'ask' ? 'answer' : 'changeset');
      if (rec.status === 'cancelled') return;
      if (!outcome.ok) return this.finish(rec, { status: 'failed', error: `${outcome.error.code}: ${outcome.error.message}` });
      const result = await evaluate(outcome.value);
      if (!result.diagnostics.length) return this.complete(rec, request, outcome.value, result);
      retry = { output: outcome.value, diagnostics: selectDiagnostics(result.diagnostics, MAX_DIAGNOSTICS).diagnostics };
    }
    this.finish(rec, { status: 'failed', error: 'the edit did not pass validation', diagnostics: retry.diagnostics });
  }

  async call(rec, prompt, schema) {
    const handle = runClaude({ prompt, model: rec.model, schemaText: SCHEMAS[schema], skillDir: SKILL_ROOT, cwd: this.root });
    this.running.set(rec.id, handle);
    try {
      const outcome = await handle.done;
      rec.usage.costUsd += outcome.costUsd ?? 0;
      rec.usage.durationMs += outcome.durationMs ?? 0;
      return outcome;
    } finally {
      this.running.delete(rec.id);
    }
  }

  finish(rec, fields) {
    if (rec.status === 'cancelled') return;
    Object.assign(rec, fields);
    this.save(rec);
  }

  complete(rec, request, value, result) {
    if (rec.status === 'cancelled') return;
    const selectionWarnings = focusWarnings(request.focus);
    if (request.mode === 'ask') {
      this.addNote(rec, request, value);
      return this.finish(rec, { status: 'answered', answer: value, summary: '', warnings: selectionWarnings });
    }
    if (value.needsConfirmation) {
      return this.finish(rec, { status: 'needs_confirmation', needsConfirmation: value.needsConfirmation, summary: value.summary ?? '' });
    }
    rec.rounds.push({ instruction: request.instruction, focus: request.focus, changeset: result.changeset, applied: result.applied, summary: value.summary ?? '' });
    this.finish(rec, { status: 'ready', summary: value.summary ?? '', warnings: [...selectionWarnings, ...result.warnings] });
  }

  addNote(rec, request, value) {
    const notes = this.notes(rec.lessonId);
    notes.push({
      id: rec.id, blockId: request.focus.focusBlockIds[0] ?? null, question: request.instruction,
      answer: value.answer, sources: value.sources, createdAt: new Date().toISOString(),
    });
    fs.mkdirSync(path.dirname(this.notesFile(rec.lessonId)), { recursive: true });
    writeAtomic(this.notesFile(rec.lessonId), formatJson(notes));
  }
}

function requireInstruction(instruction) {
  if (typeof instruction !== 'string' || !instruction.trim()) throw new HttpError(400, 'bad_request', 'instruction is required');
}

function requireSelection(s) {
  const valid = Boolean(s) && typeof s === 'object' && Array.isArray(s.focusBlockIds ?? []) && Array.isArray(s.ranges ?? []);
  if (!valid) throw new HttpError(400, 'bad_request', 'selection needs focusBlockIds and ranges arrays');
}

// Model names become a CLI argument, so they must never look like a flag.
function checkModel(model) {
  if (typeof model !== 'string' || !MODEL_RE.test(model)) throw new HttpError(400, 'bad_request', `invalid model ${JSON.stringify(model)}`);
  return model;
}

const oneLine = (text) => text.replace(/\s+/g, ' ').trim().slice(0, 200);

function writeAtomic(file, content, mode = 0o644) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

// Runs `fn` (which writes `file` and commits); on any failure the previous content is put back.
function withRollback(file, fn) {
  const previous = fs.readFileSync(file);
  try {
    return fn();
  } catch (error) {
    writeAtomic(file, previous);
    throw error;
  }
}
