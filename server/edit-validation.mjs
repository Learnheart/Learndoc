// Validation of claude's output before a changeset becomes `ready` (or an ask `answered`).
// project = { root, config, course }

import { applyChangeset } from '../delta/changeset.mjs';
import { FIELD_KINDS } from '../shared/render.mjs';
import { checkLesson } from '../lib/check.mjs';
import { otherLessons } from '../lib/project.mjs';
import { loadChunkIndexes } from '../lib/refs.mjs';
import { schemaDiagnostics, validateBlock, validateLesson } from '../lib/validate.mjs';

const problem = (code, message, blockId) => ({ code, severity: 'error', message, subject: blockId ? { id: blockId } : {}, supportedFixes: [] });

// Warnings carry a stable `code` (and `blockId` when they concern a block) for the UI to localize;
// `message` is the English fallback.
const warning = (code, blockId, message) => ({ code, ...(blockId && { blockId }), message });

export const focusWarnings = (focus) => focus.warnings.map(({ code, blockId }) =>
  warning(code, blockId, `the selection in ${blockId} could not be located; the whole block was used`));

const ANSWER_ID = 'b-answer';

// The answer is checked as a prose block: its HTML, math and links as part of the lesson (so in-lesson
// #anchor links resolve), its sources against learndoc.json and the chunk indexes like any block's.
// An answer without sources is allowed, so the block checks only run when it has some.
export async function evaluateAnswer(value, lesson, project) {
  const schema = schemaDiagnostics('answer', value, 'answer');
  if (schema.length) return { diagnostics: schema };
  const block = { id: ANSWER_ID, type: 'prose', html: value.answer, sources: value.sources };
  const file = 'answer';
  const content = checkLesson({ ...lesson, blocks: [...lesson.blocks, block] }, { root: project.root, file, course: project.course })
    .filter((d) => d.subject?.id === ANSWER_ID);
  const blockSchema = value.sources.length ? schemaDiagnostics('block', block, file) : [];
  const semantic = value.sources.length && !blockSchema.length
    ? await validateBlock(block, { root: project.root, file, config: project.config, indexes: loadChunkIndexes(project.root, project.config), unverified: new Set() })
    : [];
  return { diagnostics: [...content, ...blockSchema, ...semantic].filter((d) => d.severity === 'error') };
}

// -> { diagnostics, changeset, applied, warnings }. `changeset` is the round as stored: insert ids
// pinned (so re-applying gives the same ids) and group ids namespaced by round (`r2:g-notation`).
// `originalIds`: block ids of the lesson before the first round; blocks inserted by earlier rounds
// of this changeset get no outside_focus warning.
export async function evaluateChangeset(value, current, { focus, maxRelated, round, newId, originalIds, project }) {
  const schema = schemaDiagnostics('changeset', value, 'changeset');
  if (schema.length) return { diagnostics: schema };
  if (Boolean(value.changes) === Boolean(value.needsConfirmation)) {
    return { diagnostics: [problem('changeset/shape', 'return exactly one of "changes" and "needsConfirmation"')] };
  }
  if (value.needsConfirmation) return { diagnostics: [] };

  const changeset = { ...value, changes: value.changes.map((c) => storedChange(c, round)) };
  const { lesson, applied, errors } = applyChangeset(current, changeset, { newId });
  for (const a of applied) if (a.op === 'insert') changeset.changes[a.index].blockId = a.blockId;

  const diagnostics = [
    ...errors.map((e) => problem(`changeset/${e.code}`, `changes[${e.index}] (${e.op}): ${e.message}`, e.blockId)),
    ...ruleDiagnostics(changeset, applied, maxRelated),
    ...referencedAnchorDiagnostics(current, lesson, project.root),
  ];
  const warnings = outsideFocusWarnings(focus, applied.filter((a) => originalIds.has(a.blockId)));
  if (!diagnostics.length) {
    for (const d of await newDiagnostics(current, lesson, project)) {
      if (d.severity === 'error') diagnostics.push(d);
      else warnings.push(diagnosticWarning(d));
    }
  }
  return { diagnostics, changeset, applied, warnings };
}

// Insert ids are the server's, so any id claude put on an insert is dropped.
function storedChange({ blockId, group, ...change }, round) {
  return {
    ...change,
    ...(change.op !== 'insert' && { blockId }),
    ...(group && { group: `r${round}:${group}` }),
  };
}

// The same validation and check functions finalize runs on a lesson file.
async function lessonDiagnostics(lesson, { root, config, course }) {
  const ctx = { root, file: `lessons/${lesson.id}.json`, config, course, indexes: loadChunkIndexes(root, config) };
  const validation = await validateLesson(lesson, ctx);
  if (validation.some((d) => d.code.startsWith('schema/'))) return validation;
  return [...validation, ...checkLesson(lesson, ctx)];
}

// Diagnostics of `next` that `base` did not already have: problems present before an edit are
// not the edit's fault.
export async function newDiagnostics(base, next, project) {
  const key = (d) => `${d.code}|${d.message}`;
  const before = new Set((await lessonDiagnostics(base, project)).map(key));
  return (await lessonDiagnostics(next, project)).filter((d) => !before.has(key(d)));
}

function ruleDiagnostics(changeset, applied, maxRelated) {
  const out = [];
  changeset.changes.forEach((c, i) => {
    if (c.role === 'related' && !c.reason?.trim()) out.push(problem('changeset/related-reason', `changes[${i}]: a related change needs a reason`, c.blockId));
  });
  const related = changeset.changes.filter((c) => c.role === 'related').length;
  if (related > maxRelated) {
    out.push(problem('changeset/too-many-related', `${related} related changes exceed maxRelated (${maxRelated}); return needsConfirmation instead`));
  }
  for (const { op, blockId, before, after } of applied) {
    if (op !== 'replace') continue;
    if (before.type === 'heading' && after.anchor !== before.anchor) {
      out.push(problem('changeset/anchor-changed', `${blockId}: a heading keeps its anchor "${before.anchor}"`, blockId));
    }
    if (before.type === 'widget' && (after.type !== 'widget' || after.widget !== before.widget)) {
      out.push(problem('changeset/widget-changed', `${blockId}: only the props of a widget block may change`, blockId));
    }
  }
  return out;
}

// Anchors that other lessons link to (`lesson:<id>#anchor`) must survive the edit.
function referencedAnchorDiagnostics(current, next, root) {
  const anchorsOf = (lesson) => new Map(lesson.blocks.filter((b) => b.type === 'heading').map((b) => [b.anchor, b.id]));
  const before = anchorsOf(current);
  const after = anchorsOf(next);
  const linkRe = new RegExp(`lesson:${current.id}#([a-z0-9-]+)`, 'g');
  const out = [];
  for (const other of otherLessons(root, current.id)) {
    for (const block of other.blocks ?? []) {
      for (const [, anchor] of JSON.stringify(block).matchAll(linkRe)) {
        if (!before.has(anchor) || after.has(anchor)) continue;
        out.push(problem('anchor/referenced', `heading #${anchor} (${before.get(anchor)}) is linked from lesson ${other.id} block ${block.id}; keep it`, before.get(anchor)));
      }
    }
  }
  return out;
}

const diagnosticWarning = ({ code, message, subject }) => warning(code, subject?.id, message);

// A primary block whose source changed outside the resolved range(s) of the selection.
function outsideFocusWarnings(focus, applied) {
  const warnings = [];
  for (const a of applied.filter((x) => x.op === 'replace' && x.role === 'primary')) {
    const ranges = focus.ranges.filter((r) => r.blockId === a.blockId);
    if (!ranges.length || ranges.some((r) => r.whole)) continue;
    const outside = Object.keys(FIELD_KINDS[a.before.type] ?? {}).some((field) => {
      const before = a.before[field] ?? '';
      const after = a.after[field] ?? '';
      const r = ranges.find((x) => x.field === field);
      if (!r) return before !== after;
      const head = before.slice(0, r.start);
      const tail = before.slice(r.end);
      return !(after.length >= head.length + tail.length && after.startsWith(head) && after.endsWith(tail));
    });
    if (outside) warnings.push(warning('outside_focus', a.blockId, `${a.blockId}: text outside the selection changed`));
  }
  return warnings;
}
