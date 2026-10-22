// finalize: validate → render → check → browser-check for learndoc.json, course.json or a lesson,
// returning one compact receipt.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { checkCourse, checkLesson } from './check.mjs';
import { ChromeBrowser, findChrome } from './chrome.mjs';
import { diagnostic, hasErrors, selectDiagnostics } from './diagnostics.mjs';
import { EXPORT_DIR, exportSite } from './export.mjs';
import { commitPaths } from './git.mjs';
import { renderLessonPage } from './page.mjs';
import {
  bootstrapProject, CONFIG_FILE, COURSE_FILE, findProjectRoot, formatJson, readJson, relativePath, STATE_DIR,
} from './project.mjs';
import { ensureChunks } from './refs.mjs';
import { createStaticHandler } from './static-server.mjs';
import { validateConfig, validateCourse, validateLesson } from './validate.mjs';

const STAGES = ['validate', 'render', 'check', 'browser-check'];
const READY_TIMEOUT_MS = 15000;

export class UsageError extends Error {}

// -> 'config' | 'course' | 'lesson'
function targetKind(file) {
  const base = path.basename(file);
  if (base === CONFIG_FILE) return 'config';
  if (base === COURSE_FILE) return 'course';
  if (path.basename(path.dirname(file)) === 'lessons' && base.endsWith('.json')) return 'lesson';
  throw new UsageError(`finalize accepts learndoc.json, course.json or lessons/<id>.json, not ${file}`);
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const SELF_TEST = `(async () => {
  const deadline = Date.now() + ${READY_TIMEOUT_MS};
  while (!(window.learndoc && window.learndoc.ready)) {
    if (Date.now() > deadline) return { notReady: 'window.learndoc.ready was not defined within ${READY_TIMEOUT_MS / 1000} s' };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const ready = await Promise.race([
    Promise.resolve(window.learndoc.ready).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()))),
  ]);
  if (!ready) return { notReady: 'window.learndoc.ready did not resolve within ${READY_TIMEOUT_MS / 1000} s' };
  const result = await window.learndoc.selfTest();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return result;
})()`;

const PROBLEM_CODES = {
  console: 'browser/console-error',
  log: 'browser/console-error',
  exception: 'browser/exception',
  network: 'browser/resource-failed',
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Serves the rendered page (held in memory, never written) at /lessons/<id> next to the skill and
// project static dirs, then loads it in headless Chrome. -> { status, diagnostics }
async function browserCheck({ root, lessonId, html, subject, env }) {
  const chromePath = findChrome({ env });
  if (!chromePath) {
    return {
      status: 'skipped',
      diagnostics: [diagnostic({
        code: 'browser/chrome-missing',
        severity: 'warning',
        message: 'browser-check skipped: no Chrome or Chromium executable found',
        subject,
        supportedFixes: ['install Google Chrome or Chromium', 'set LEARNDOC_CHROME to the browser executable'],
      })],
    };
  }
  const serveStatic = createStaticHandler({ projectRoot: root });
  const server = http.createServer((req, res) => {
    if (serveStatic(req, res)) return;
    if (new URL(req.url, 'http://localhost').pathname === `/lessons/${encodeURIComponent(lessonId)}`) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    res.writeHead(404).end();
  });
  const diagnostics = [];
  const fail = (fields) => diagnostics.push(diagnostic({ subject, ...fields }));
  let browser = null;
  try {
    const port = await listen(server);
    browser = new ChromeBrowser(chromePath, { env });
    await browser.navigate(`http://127.0.0.1:${port}/lessons/${encodeURIComponent(lessonId)}`);
    const result = await browser.evaluate(SELF_TEST, { awaitPromise: true, timeoutMs: READY_TIMEOUT_MS + 30000 });
    if (result?.notReady) {
      fail({
        code: 'browser/not-ready',
        message: `browser-check: ${result.notReady}`,
        supportedFixes: ['make sure /static/runtime/lesson.js loads without errors'],
      });
    } else {
      for (const widget of result?.widgets || []) {
        if (widget.mount === true && widget.update === true && widget.destroy === true && !widget.error) continue;
        fail({
          code: 'browser/widget-lifecycle',
          message: `browser-check: widget "${widget.name}" failed its lifecycle test${widget.error ? `: ${widget.error}` : ''}`,
          evidence: { mount: widget.mount, update: widget.update, destroy: widget.destroy },
          supportedFixes: ['fix the widget props', 'for a project widget, fix mount/update/destroy in widgets/<name>.js (destroy must empty the element)'],
        });
      }
    }
  } catch (error) {
    fail({
      code: 'browser/failed',
      message: `browser-check could not complete: ${error.message.split('\n')[0]}`,
      evidence: { detail: error.message.slice(0, 2000) },
      supportedFixes: ['rerun finalize; if it persists, check that Chrome starts headless on this machine'],
    });
  } finally {
    for (const problem of browser?.problems || []) {
      const network = problem.kind === 'network';
      fail({
        code: PROBLEM_CODES[problem.kind],
        message: `browser-check: ${network ? `failed to load ${problem.url} (${problem.message})` : problem.message}`,
        evidence: { ...(problem.url ? { url: problem.url } : {}), ...(problem.line ? { line: problem.line } : {}) },
        supportedFixes: network
          ? ['fix the asset or widget path', 'make sure the referenced file exists']
          : ['fix the widget or content that raised this error in the browser console'],
      });
    }
    await browser?.close();
    server.close();
  }
  return { status: diagnostics.length ? 'fail' : 'pass', diagnostics };
}

function loadJsonInto(file, root, diagnostics) {
  const { value, diagnostic: problem } = readJson(file, { root });
  if (problem) diagnostics.push(problem);
  return value;
}

// -> { exitCode, receipt }. Throws UsageError for an unsupported or missing target.
// `commit: false` leaves committing a passing lesson to the caller (import commits once for all lessons).
export async function runFinalize({ file, cwd = process.cwd(), env = process.env, commit: shouldCommit = true }) {
  const started = Date.now();
  const targetPath = path.resolve(cwd, file);
  const kind = targetKind(targetPath);
  if (!fs.existsSync(targetPath)) throw new UsageError(`${file} does not exist`);
  const target = { kind, path: targetPath, sha256: sha256(fs.readFileSync(targetPath)) };
  const gates = Object.fromEntries(STAGES.map((stage) => [stage, 'not-run']));
  if (kind !== 'lesson') gates.render = gates['browser-check'] = 'skipped';
  const diagnostics = [];
  let failedStage = null;
  let lesson;
  const finalStatus = () => {
    if (failedStage) return 'fail';
    if (kind === 'lesson' && gates['browser-check'] === 'skipped') return 'skipped';
    return 'pass';
  };
  // Commits the project files a passing lesson depends on, so its generated version can be restored.
  // -> commit hash, or null when nothing changed or the commit failed (reported as a warning)
  const commitLesson = () => {
    try {
      return commitPaths(root, [CONFIG_FILE, COURSE_FILE, relativePath(root, targetPath)], `learndoc: finalize ${lesson.id}`);
    } catch (error) {
      diagnostics.push(diagnostic({
        code: 'project/commit-failed',
        severity: 'warning',
        message: `the lesson passed but could not be committed: ${error.message}`,
        subject: { file: relativePath(root, targetPath) },
        supportedFixes: ['configure git user.name and user.email, then rerun finalize'],
      }));
      return null;
    }
  };
  const finish = () => {
    const status = finalStatus();
    let commit = null;
    if (kind === 'lesson' && status !== 'fail') {
      // Stored in canonical form, so later edits diff cleanly.
      const canonical = formatJson(lesson);
      if (canonical !== fs.readFileSync(targetPath, 'utf8')) fs.writeFileSync(targetPath, canonical);
      target.sha256 = sha256(canonical);
      if (shouldCommit) commit = commitLesson();
    }
    if (kind !== 'config' && status !== 'fail') refreshExport();
    // The lesson's standalone page is its only rendered copy.
    const page = kind === 'lesson' && status !== 'fail' ? path.join(root, EXPORT_DIR, `${encodeURIComponent(lesson.id)}.html`) : null;
    const artifact = page && fs.existsSync(page) ? { path: page, sha256: sha256(fs.readFileSync(page)) } : null;
    const receipt = {
      schemaVersion: 1,
      ok: status === 'pass',
      command: 'finalize',
      status,
      target,
      gates,
      ...(failedStage ? { failedStage } : {}),
      ...selectDiagnostics(diagnostics),
      ...(artifact ? { artifact } : {}),
      ...(kind === 'lesson' ? { commit } : {}),
      ...(failedStage === 'validate' || failedStage === 'check' ? {
        nextAction: {
          action: 'edit-in-place',
          file: targetPath,
          constraint: "Apply each diagnostic's supportedFixes (or the fix its message names) to the existing file; keep block ids and unaffected content unchanged; do not rewrite the whole file.",
          then: 'finalize-once',
        },
      } : {}),
      durationMs: Date.now() - started,
    };
    return { exitCode: { pass: 0, fail: 1, skipped: 2 }[status], receipt };
  };
  // The standalone pages in html/ follow every passing lesson or course; a failure only warns.
  const refreshExport = () => {
    try {
      exportSite(root);
    } catch (error) {
      diagnostics.push(diagnostic({
        code: 'export/failed',
        severity: 'warning',
        message: `the standalone pages in html/ could not be updated: ${error.message}`,
        subject: { project: root },
        supportedFixes: ['make sure the project directory is writable, then rerun finalize'],
      }));
    }
  };
  const gate = (stage, stageDiagnostics) => {
    diagnostics.push(...stageDiagnostics);
    gates[stage] = hasErrors(stageDiagnostics) ? 'fail' : 'pass';
    if (gates[stage] === 'fail') failedStage = stage;
    return !failedStage;
  };

  const root = findProjectRoot(path.dirname(targetPath));
  const expected = root && {
    config: path.join(root, CONFIG_FILE),
    course: path.join(root, COURSE_FILE),
    lesson: path.join(root, 'lessons', path.basename(targetPath)),
  }[kind];
  if (!root || expected !== targetPath) {
    gate('validate', [diagnostic({
      code: 'project/layout',
      message: root
        ? `${relativePath(root, targetPath)} is not where learndoc expects it (${relativePath(root, expected)})`
        : `no ${CONFIG_FILE} found in ${path.dirname(targetPath)} or any parent directory`,
      subject: { file: targetPath },
      supportedFixes: root ? [`move the file to ${relativePath(root, expected)}`] : [`write ${CONFIG_FILE} at the project root first`],
    })]);
    return finish();
  }

  const validation = [];
  try {
    bootstrapProject(root);
  } catch (error) {
    validation.push(diagnostic({
      code: 'project/bootstrap-failed',
      severity: 'warning',
      message: `could not prepare ${STATE_DIR}/ or git: ${error.message}`,
      subject: { project: root },
      supportedFixes: ['make sure git is installed and the project directory is writable'],
    }));
  }
  const config = loadJsonInto(path.join(root, CONFIG_FILE), root, validation);
  if (config !== undefined) validation.push(...validateConfig(config));
  const configValid = config !== undefined && !hasErrors(validation);
  let indexes = {};
  if (configValid) {
    const chunked = await ensureChunks(root, config);
    indexes = chunked.indexes;
    validation.push(...chunked.diagnostics);
  }
  let course;
  if (kind !== 'config') {
    course = loadJsonInto(path.join(root, COURSE_FILE), root, validation);
    if (course !== undefined && configValid) validation.push(...validateCourse(course, { config, indexes }));
  }
  const lessonPath = relativePath(root, targetPath);
  if (kind === 'lesson') {
    lesson = loadJsonInto(targetPath, root, validation);
    if (lesson !== undefined && configValid) {
      const courseUsable = course !== undefined && !hasErrors(validation);
      validation.push(...await validateLesson(lesson, { root, file: lessonPath, config, course: courseUsable ? course : undefined, indexes }));
    }
  }
  if (!gate('validate', validation)) return finish();

  if (kind === 'lesson') {
    let html;
    try {
      html = renderLessonPage({ root, config, course, lesson, editable: false });
      gate('render', []);
    } catch (error) {
      gate('render', [diagnostic({
        code: 'render/failed',
        message: `rendering ${lessonPath} failed: ${error.message}`,
        subject: { file: lessonPath },
        supportedFixes: ['fix the block named in the error'],
      })]);
      return finish();
    }
    if (!gate('check', [...checkCourse(course, { root }), ...checkLesson(lesson, { root, file: lessonPath, course })])) return finish();
    const checked = await browserCheck({ root, lessonId: lesson.id, html, subject: { file: lessonPath }, env });
    diagnostics.push(...checked.diagnostics);
    gates['browser-check'] = checked.status;
    if (checked.status === 'fail') failedStage = 'browser-check';
    return finish();
  }
  gate('check', kind === 'course' ? checkCourse(course, { root }) : []);
  return finish();
}
