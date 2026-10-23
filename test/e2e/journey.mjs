#!/usr/bin/env node
// Real-browser user journey against a running learndoc edit server (headless Chrome over CDP).
//
//   node test/e2e/journey.mjs <projectDir> [--out <dir>] [--lesson <id>] [--steps a,b,c,d,e,f]
//
// Uses the project's live server from .learndoc/server.json (starts one with `serve --no-open`
// when none is healthy). Drives the editor with real mouse/keyboard events, screenshots every step
// into --out (default <projectDir>/.learndoc/e2e) and prints one JSON line per check. Steps b, c and
// d call the real `claude -p` through the server. Exit 0 when every check passed, 1 otherwise.
//
//   a  open lesson: render, math, widgets, editor, no console errors
// Button labels and toasts come from runtime/editor/i18n.js for the project's language.
//
//   b  select a sentence → Edit → preview → Before/After/Diff → accept → commit of the lesson only
//   c  select → Insert after → preview → select inside the inserted block → Refine → cancel → unchanged
//   d  select → Ask → note beside the block; survives reload (closed, its passage marked;
//      clicking the mark opens it); delete → gone from the page and the notes file
//   e  History → entry scrolls to the changed blocks → View diff → close → restore to before (b)
//      → file equals the pre-(b) content, new commit
//   f  ⌘/Ctrl+K opens the prompt, Esc closes it, Alt+drag selects ≥ 2 blocks
//   g  whole-lesson chat: × drops a draft unsent; a request → preview (no selection tags) → cancel → unchanged
//   h  History → tick one entry → delete → gone, lesson unchanged → delete all → only the first entry
//      (rewrites git history: runs only with --scratch, on a disposable copy of a project)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChromeBrowser, findChrome } from '../../lib/chrome.mjs';
import { makeT, warningText } from '../../runtime/editor/i18n.js';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLAUDE_TIMEOUT_MS = 360000; // spawner 150 s + one automatic retry + slack
const MOD = { alt: 1, ctrl: 2, meta: 4 };
const CMD = process.platform === 'darwin' ? MOD.meta : MOD.ctrl;

const INSTRUCTIONS = {
  b: 'Viết lại câu này đơn giản hơn, thêm một ví dụ đời thường',
  c1: 'Thêm một ví dụ cụ thể về agent đặt vé máy bay',
  c2: 'Rút gọn ví dụ còn 3 câu',
  d: 'Khác biệt giữa agent và chatbot là gì?',
  g: 'Ở mọi tiêu đề mục cấp 2 trong bài, bỏ số thứ tự ở đầu tiêu đề (giữ nguyên phần chữ).',
  g2: 'Riêng tiêu đề mục "Nguồn tham khảo" thì giữ lại số thứ tự như cũ.',
};

// ---------- args ----------

function parseArgs(argv) {
  const opts = { project: null, out: null, lesson: null, steps: 'abcdefg', scratch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--lesson') opts.lesson = argv[++i];
    else if (a === '--steps') opts.steps = argv[++i].replace(/[^a-h]/g, '');
    else if (a === '--scratch') opts.scratch = true;
    else if (!opts.project) opts.project = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!opts.project) throw new Error('usage: journey.mjs <projectDir> [--out dir] [--lesson id] [--steps abcdefgh] [--scratch]');
  opts.project = path.resolve(opts.project);
  opts.out = path.resolve(opts.out ?? path.join(opts.project, '.learndoc', 'e2e'));
  return opts;
}

// ---------- logging ----------

const results = [];
let logFile = null;
function log(entry) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
  console.log(line);
  if (logFile) fs.appendFileSync(logFile, `${line}\n`);
}
function check(step, name, ok, details = {}) {
  results.push({ step, name, ok: !!ok });
  log({ step, check: name, ok: !!ok, ...details });
  return !!ok;
}
const BLOCK_ID = /\bb-[a-z0-9]{4,12}\b/;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Regex source for a UI string with a number/hash argument, e.g. t('count_insert', N) → "\d+ chèn".
const pattern = (t, key, arg) => escapeRe(t(key, '\u0000')).replace('\u0000', arg);
function must(step, name, ok, details) {
  if (!check(step, name, ok, details)) throw new Error(`${step}: ${name}`);
}

// ---------- project helpers ----------

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return (r.stdout || r.stderr).trim();
};

// Files changed by `rev`, relative to the project root even when the project sits inside a larger
// repo. Files outside the project keep their repo-relative path, so they never match a project path.
function commitFiles(project, rev) {
  const prefix = git(project, 'rev-parse', '--show-prefix');
  return git(project, 'show', '--name-only', '--format=', rev)
    .split('\n')
    .filter(Boolean)
    .map((f) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f));
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function ensureServer(project) {
  const file = path.join(project, '.learndoc', 'server.json');
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
  let info = read();
  // A copied project carries the original's server.json; never drive another project's server.
  const ours = async (i) => (await health(i.port))?.projectRoot === fs.realpathSync(project);
  if (!info || !(await ours(info))) {
    const r = spawnSync(process.execPath, [path.join(SKILL, 'bin/learndoc.mjs'), 'serve', '--no-open'], { cwd: project, encoding: 'utf8' });
    log({ step: 'setup', serve: r.stdout.trim(), stderr: r.stderr.trim() || undefined });
    info = read();
  }
  if (!info) throw new Error('no .learndoc/server.json after serve');
  const h = await health(info.port);
  if (!h) throw new Error(`server on port ${info.port} is not healthy`);
  if (h.projectRoot !== fs.realpathSync(project)) throw new Error(`server on port ${info.port} serves ${h.projectRoot}, not ${project}`);
  return { ...info, health: h };
}

function pickLesson(project, wanted) {
  if (wanted) return wanted;
  const course = JSON.parse(fs.readFileSync(path.join(project, 'course.json'), 'utf8'));
  const lessons = course.modules.flatMap((m) => m.lessons);
  const done = lessons.find((l) => l.status === 'done' && fs.existsSync(path.join(project, 'lessons', `${l.id}.json`)));
  if (!done) throw new Error('no done lesson in course.json');
  return done.id;
}

// ---------- page driver ----------

class Page {
  constructor(browser, out) {
    this.browser = browser;
    this.out = out;
    this.shot = 0;
    this.changesetViews = new Map(); // id -> last GET /api/changesets/:id body
  }

  async init() {
    this.session = await this.browser.sessionPromise;
    await this.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    // Headless Chrome otherwise holds every mouseMoved after the first key event for ~5 s.
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Remember every changeset view the page polls, for usage/cost and diagnostics.
    this.browser.cdp.on('Network.loadingFinished', ({ requestId }) => {
      const url = this.browser.requests.get(requestId);
      if (!url || !/\/api\/changesets\/[^/?]+$/.test(new URL(url).pathname)) return;
      this.send('Network.getResponseBody', { requestId })
        .then(({ body }) => {
          const view = JSON.parse(body);
          if (view?.id) this.changesetViews.set(view.id, view);
        })
        .catch(() => {});
    });
  }

  async send(method, params = {}, timeoutMs = 15000) {
    const t0 = Date.now();
    try {
      return await this.browser.cdp.send(method, params, this.session, timeoutMs);
    } finally {
      if (process.env.JOURNEY_DEBUG && Date.now() - t0 > 1000) log({ debug: 'slow cdp', method, type: params.type, ms: Date.now() - t0 });
    }
  }

  eval(expr, opts) {
    return this.browser.evaluate(expr, { awaitPromise: true, ...opts });
  }

  // Evaluates `fn` (a function source taking `arg`) in the page.
  call(fn, arg) {
    return this.eval(`(${fn})(${JSON.stringify(arg ?? null)})`);
  }

  async waitFor(fn, arg, { timeoutMs = 15000, intervalMs = 150, label = 'condition' } = {}) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      last = await this.call(fn, arg).catch((e) => ({ __error: e.message }));
      if (last && !last.__error) return last;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}${last?.__error ? `: ${last.__error}` : ''}`);
  }

  // Waits until the page stops scrolling (the editor scrolls smoothly to changes).
  async settle() {
    let last = null;
    let stable = 0;
    for (let i = 0; i < 60 && stable < 3; i++) {
      const y = await this.eval('scrollY');
      stable = y === last ? stable + 1 : 0;
      last = y;
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(this.out, `${String(++this.shot).padStart(2, '0')}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  async mouse(type, x, y, { modifiers = 0, buttons } = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, modifiers, button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
      buttons: buttons ?? (type === 'mousePressed' ? 1 : 0), clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }

  async drag(from, to, { modifiers = 0, steps = 8 } = {}) {
    await this.mouse('mouseMoved', from.x, from.y, { modifiers });
    await this.mouse('mousePressed', from.x, from.y, { modifiers });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.mouse('mouseMoved', x, y, { modifiers, buttons: 1 });
    }
    await this.mouse('mouseReleased', to.x, to.y, { modifiers });
  }

  async click(point) {
    await this.mouse('mouseMoved', point.x, point.y);
    await this.mouse('mousePressed', point.x, point.y);
    await this.mouse('mouseReleased', point.x, point.y);
  }

  // Clicks the first visible element matching `selector` whose own label (first text node,
  // or full text when exact) equals `text`; viewport coordinates from the page.
  async clickButton(selector, text, label = text) {
    const point = await this.waitFor((a) => {
      const label = (el) => (el.childNodes[0]?.textContent ?? el.textContent).trim();
      const el = [...document.querySelectorAll(a.selector)].find((b) => !b.disabled && b.offsetParent !== null
        && (a.text === null || label(b) === a.text || b.textContent.trim() === a.text));
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, { selector, text }, { label: `button ${label}` });
    await this.click(point);
  }

  async key(key, { code, keyCode, modifiers = 0, text } = {}) {
    const base = { key, code: code ?? key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async type(text) {
    await this.send('Input.insertText', { text });
  }

  // Finds a text span in a field (sentence or phrase) and drags across it with the mouse.
  // pick: { blockId? | nth prose index, mode: 'sentence'|'phrase', inside?: css for section }
  async selectText(pick) {
    await this.settle();
    const target = await this.call((p) => {
      const sections = [...document.querySelectorAll(p.sectionSelector)]
        .filter((s) => !p.exclude?.includes(s.dataset.blockId));
      const section = p.blockId ? sections.find((s) => s.dataset.blockId === p.blockId) : sections[p.nth ?? 0];
      if (!section) return { error: `no section for ${JSON.stringify(p)}` };
      const field = section.querySelector('[data-field="html"]') ?? section.querySelector('[data-field]');
      // First plain text node (not math, not link, not chrome) long enough to hold a sentence.
      const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest('.math, a, [data-chrome], code') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent;
        if (text.trim().length < 25) continue;
        const lead = text.length - text.trimStart().length;
        let start = lead;
        let end;
        if (p.mode === 'phrase') {
          // A few words from the start of the run.
          const words = text.slice(start).split(/(\s+)/);
          end = start + words.slice(0, 15).join('').trimEnd().length;
        } else {
          const m = text.slice(start).match(/^[^.!?]{15,}?[.!?](?=\s|$)/);
          end = start + (m ? m[0].length : text.trimEnd().length - start);
        }
        section.scrollIntoView({ block: 'center', behavior: 'instant' });
        if (p.scrollOnly) return { scrolled: true };
        const r = document.createRange();
        r.setStart(node, start);
        r.setEnd(node, start + 1);
        const a = r.getClientRects()[0];
        r.setStart(node, end - 1);
        r.setEnd(node, end);
        const rects = r.getClientRects();
        const b = rects[rects.length - 1];
        return {
          blockId: section.dataset.blockId,
          expected: text.slice(start, end),
          from: { x: a.left + 1, y: a.top + a.height / 2 },
          to: { x: b.right - 1, y: b.top + b.height / 2 },
        };
      }
      return { error: `no selectable text run in ${section.dataset.blockId}` };
    }, pick);
    if (target.error) throw new Error(target.error);
    if (!pick.scrollOnly) await this.settle();
    await this.drag(target.from, target.to);
    await new Promise((r) => setTimeout(r, 150));
    target.selected = await this.eval('getSelection().toString()');
    return target;
  }

  toolbar() {
    return this.waitFor(() => {
      const el = document.querySelector('.ld-ed-toolbar:not([hidden])');
      return el && [...el.querySelectorAll('button')].map((b) => (b.childNodes[0]?.textContent ?? '').trim());
    }, null, { label: 'floating toolbar' });
  }

  prompt() {
    return this.waitFor(() => {
      const el = document.querySelector('.ld-ed-prompt');
      if (!el) return null;
      return {
        mode: el.querySelector('.ld-ed-prompt-head strong')?.textContent,
        chip: el.querySelector('.ld-ed-chip')?.textContent,
        quote: el.querySelector('.ld-ed-quote')?.textContent ?? null,
        focused: document.activeElement === el.querySelector('textarea'),
        model: el.querySelector('select')?.value,
      };
    }, null, { label: 'prompt popover' });
  }

  async submitPrompt(instruction) {
    await this.type(instruction);
    await this.key('Enter', { code: 'Enter', keyCode: 13 });
  }

  // Waits for the toast and returns its text (toasts fade after 4 s, so poll quickly).
  toast(pattern) {
    return this.waitFor((re) => {
      const el = document.querySelector('.ld-ed-toast.is-visible');
      return el && (re === null || new RegExp(re).test(el.textContent)) ? { text: el.textContent, error: el.classList.contains('is-error') } : null;
    }, pattern ?? null, { label: `toast /${pattern ?? 'any'}/`, intervalMs: 80, timeoutMs: 20000 });
  }

  // After a submit: spinner, then the preview bar, a note, or a failure dialog.
  async waitClaude(step, expect) {
    if (expect.round) expect = { ...expect, roundLabel: this.t('round', expect.round) };
    const running = await this.waitFor(() => !!document.querySelector('.ld-ed-running'), null, { label: 'spinner', intervalMs: 50, timeoutMs: 10000 })
      .catch(() => false);
    check(step, 'spinner shown while claude runs', running);
    if (running) log({ step, screenshot: await this.screenshot(`${step}-running`) });
    const t0 = Date.now();
    const outcome = await this.waitFor((exp) => {
      const dialog = document.querySelector('dialog.ld-ed-dialog[open]');
      if (dialog) return { kind: 'dialog', text: dialog.innerText };
      if (exp.kind === 'preview') {
        const s = document.querySelector('.ld-ed-summary');
        const text = s?.querySelector('.ld-ed-summary-text')?.innerText ?? '';
        if (s && (!exp.roundLabel || text.includes(exp.roundLabel))) return { kind: 'preview', text };
      } else if (exp.kind === 'note') {
        const notes = document.querySelector(`section[data-block-id="${exp.blockId}"] .ld-ed-notes`);
        if (notes && !document.querySelector('.ld-ed-running')) return { kind: 'note', text: notes.innerText };
      }
      return null;
    }, expect, { timeoutMs: CLAUDE_TIMEOUT_MS, intervalMs: 500, label: `claude result (${expect.kind})` });
    outcome.waitedMs = Date.now() - t0;
    return outcome;
  }

  async openLesson(url) {
    await this.browser.navigate(url, 30000);
    return this.waitFor(() => {
      if (!window.learndoc) return null;
      const handles = document.querySelectorAll('main.ld-lesson > section .ld-handle').length;
      const topbtn = [...document.querySelectorAll('.ld-ed-topbtn')].map((b) => b.textContent);
      return handles > 0 && topbtn.length > 0 ? { handles, topbtn } : null;
    }, null, { label: 'editor boot', timeoutMs: 20000 });
  }

  // A user finding a resumed preview clicks Cancel; returns the cancelled changeset id or null.
  async cancelOpen(lessonId) {
    const state = await this.eval(`fetch('/api/lessons/${lessonId}').then(r => r.json())`);
    const open = state.openChangeset;
    if (!open) return null;
    if (open.status === 'running') {
      await this.waitFor(() => !document.querySelector('.ld-ed-running'), null, { timeoutMs: CLAUDE_TIMEOUT_MS, label: 'resumed changeset to finish' });
    }
    const dialog = await this.eval('!!document.querySelector("dialog.ld-ed-dialog[open]")');
    if (dialog) await this.key('Escape', { code: 'Escape', keyCode: 27 });
    else await this.clickButton('.ld-ed-actions button', this.t('cancel'));
    await this.toast(escapeRe(this.t('cancelled')));
    return open;
  }

  warningTexts() {
    return this.eval(`[...document.querySelectorAll('.ld-ed-warning, .ld-ed-warnings li')].map(e => e.textContent.trim())`);
  }

  blockIds() {
    return this.eval('[...document.querySelectorAll("main.ld-lesson > section.ld-block")].map(s => s.dataset.blockId)');
  }
}

// ---------- steps ----------

// Summary without block ids; every server warning shown in the UI language (no raw server text).
async function checkTexts(step, page, summary, view) {
  check(step, 'summary has no block ids', !BLOCK_ID.test(summary ?? ''), { summary });
  const shown = await page.warningTexts();
  const codes = (view?.warnings ?? []).map((w) => w.code);
  if (!codes.length && !shown.length) {
    log({ step, warnings: 'none shown' });
    return;
  }
  const localized = (view?.warnings ?? []).map((w) => ({ code: w.code, known: page.t.known(`warn:${w.code}`), text: warningText(w, page.t) }));
  const ok = localized.every((w) => w.known && shown.some((s) => s.includes(w.text))) && shown.every((s) => !BLOCK_ID.test(s));
  check(step, `warnings localized (${page.t.lang}), no block ids`, ok, { codes, shown, expected: localized });
}

async function stepA(ctx) {
  const { page, lessonUrl } = ctx;
  const problemsBefore = ctx.browser.problems.length;
  const editor = await page.openLesson(lessonUrl);
  const info = await page.eval(`(async () => {
    await window.learndoc.ready;
    const self = await window.learndoc.selfTest();
    const math = [...document.querySelectorAll('span.math')];
    // Mount points only: the widget block's <section> is also .ld-widget (see runtime/lesson.js).
    const widgets = [...document.querySelectorAll('.ld-widget[data-widget]')];
    return {
      title: document.querySelector('main.ld-lesson h1')?.textContent,
      blocks: document.querySelectorAll('main.ld-lesson > section.ld-block').length,
      types: [...new Set([...document.querySelectorAll('main.ld-lesson > section.ld-block')].map(s => s.dataset.type))],
      math: math.length, mathRendered: math.filter(s => s.querySelector('.katex')).length,
      widgets: widgets.map(w => ({ name: w.dataset.widget, mounted: w.dataset.mounted === '1' })),
      selfTest: self.widgets.filter(w => w.error || !w.mount),
      toc: document.querySelectorAll('nav.ld-toc a').length,
      desktop: matchMedia('(hover: hover) and (pointer: fine)').matches, width: innerWidth,
      desktopOnlyToast: document.querySelector('.ld-ed-toast')?.textContent ?? null,
    };
  })()`);
  log({ step: 'a', screenshot: await page.screenshot('a-lesson') });
  check('a', 'page renders blocks', info.blocks > 0, { title: info.title, blocks: info.blocks, types: info.types, toc: info.toc });
  check('a', 'math rendered by KaTeX', info.math === info.mathRendered, { math: info.math, rendered: info.mathRendered });
  check('a', 'widgets mounted and self-test clean', info.widgets.every((w) => w.mounted) && info.selfTest.length === 0, { widgets: info.widgets, selfTestFailures: info.selfTest });
  check('a', 'editor loaded (handles + topbar buttons)', editor.handles === info.blocks && !info.desktopOnlyToast, { ...editor, desktop: info.desktop, width: info.width, toast: info.desktopOnlyToast });
  const problems = ctx.browser.problems.slice(problemsBefore);
  check('a', 'no console errors / failed loads', problems.length === 0, { problems });
}

async function stepB(ctx) {
  const { page, lessonFile, project, lessonId } = ctx;
  const { t } = page;
  ctx.preB = fs.readFileSync(lessonFile, 'utf8');
  const rel = `lessons/${lessonId}.json`;
  // baseline: the lesson's last commit before (b); firstCommit: its first (generated) version.
  ctx.baseline = git(project, 'log', '-1', '--format=%H', '--', rel) || null;
  ctx.firstCommit = git(project, 'log', '--reverse', '--format=%H', '--', rel).split('\n')[0] || null;
  if (ctx.baseline) {
    const atBaseline = spawnSync('git', ['show', `${ctx.baseline}:./${rel}`], { cwd: project, encoding: 'utf8' }).stdout;
    log({ step: 'b', baseline: git(project, 'log', '-1', '--format=%h %s', ctx.baseline), first: git(project, 'log', '-1', '--format=%h %s', ctx.firstCommit), workingTreeEqualsBaseline: atBaseline === ctx.preB });
  }
  const shaBefore = sha(lessonFile);
  const headBefore = git(project, 'rev-parse', '--verify', '-q', 'HEAD') || null;
  const sel = await page.selectText({ sectionSelector: 'main.ld-lesson > section.ld-prose', nth: 0, mode: 'sentence' });
  ctx.bBlock = sel.blockId;
  check('b', 'native selection equals the dragged sentence', sel.selected.trim() === sel.expected.trim(), { blockId: sel.blockId, expected: sel.expected, selected: sel.selected });
  const tools = await page.toolbar();
  log({ step: 'b', screenshot: await page.screenshot('b-toolbar') });
  const actions = [t('replace'), t('insert'), t('ask')];
  must('b', `floating toolbar shows ${actions.join(' / ')}`, actions.every((x) => tools.includes(x)), { toolbar: tools });
  const selected = await page.eval('[...document.querySelectorAll(".ld-block.is-selected")].map(s => s.dataset.blockId)');
  check('b', 'selected block outlined', selected.length === 1 && selected[0] === sel.blockId, { selected });
  await page.clickButton('.ld-ed-toolbar button', t('replace'));
  const prompt = await page.prompt();
  log({ step: 'b', screenshot: await page.screenshot('b-prompt') });
  must('b', 'prompt popover shows scope chip + quote', prompt.mode === t('replace') && prompt.chip?.includes(t('blocks', 1)) && prompt.quote?.includes(sel.expected.trim().slice(0, 20)), prompt);
  await page.submitPrompt(INSTRUCTIONS.b);
  const outcome = await page.waitClaude('b', { kind: 'preview' });
  log({ step: 'b', screenshot: await page.screenshot('b-preview') });
  must('b', 'preview ready (summary bar)', outcome.kind === 'preview', outcome);
  const view = [...page.changesetViews.values()].at(-1);
  log({ step: 'b', changeset: view && { id: view.id, status: view.status, summary: view.summary, counts: view.counts, warnings: view.warnings, usage: view.usage, changes: view.changes?.map((c) => ({ op: c.op, blockId: c.blockId, role: c.role, group: c.group })) } });
  const counts = new RegExp(['count_replace', 'count_insert', 'count_delete', 'count_move'].map((k) => pattern(t, k, '\\d+')).join('|'));
  check('b', 'summary bar shows counts', counts.test(outcome.text), { summary: outcome.text });
  await checkTexts('b', page, view?.summary ?? outcome.text, view);
  for (const [mode, label] of [['old', t('viewOld')], ['new', t('viewNew')], ['diff', t('viewDiff')]]) {
    await page.clickButton('.ld-ed-seg', label);
    const state = await page.waitFor((m) => {
      const pressed = document.querySelector('.ld-ed-seg[aria-pressed="true"]')?.textContent;
      if (pressed !== m) return null;
      return {
        pressed,
        changes: document.querySelectorAll('main.ld-lesson > section.is-change').length,
        ins: document.querySelectorAll('main.ld-lesson ins.ld-ins').length,
        del: document.querySelectorAll('main.ld-lesson del.ld-del').length,
      };
    }, label, { label: `view ${label}` });
    log({ step: 'b', screenshot: await page.screenshot(`b-view-${mode}`) });
    check('b', `view ${label}`, state.changes > 0 && (mode !== 'diff' || state.ins + state.del > 0), state);
  }
  await page.clickButton('.ld-ed-actions button', t('accept'));
  const toast = await page.toast(pattern(t, 'accepted', '[0-9a-f]{7}'));
  log({ step: 'b', screenshot: await page.screenshot('b-accepted') });
  check('b', 'toast with commit hash', !toast.error, toast);
  const shaAfter = sha(lessonFile);
  check('b', 'lesson file changed on disk', shaAfter !== shaBefore, { shaBefore, shaAfter });
  const head = git(project, 'rev-parse', 'HEAD');
  const stat = git(project, 'log', '-1', '--stat', '--format=%H %s');
  const files = commitFiles(project, 'HEAD');
  ctx.bCommit = head;
  const subject = git(project, 'log', '-1', '--format=%s');
  check('b', 'commit message has no block ids', !BLOCK_ID.test(subject), { subject });
  check('b', 'new commit contains only the lesson file', head !== headBefore && files.length === 1 && files[0] === `lessons/${lessonId}.json` && toast.text.includes(head.slice(0, 7)), { stat, files });
  const bar = await page.eval('!!document.querySelector(".ld-ed-summary") || document.querySelectorAll("main.ld-lesson > section.is-change").length');
  check('b', 'preview chrome gone after accept', !bar, { leftover: bar });
}

async function stepC(ctx) {
  const { page, lessonFile } = ctx;
  const { t } = page;
  const shaBefore = sha(lessonFile);
  const idsBefore = await page.blockIds();
  const textBefore = await page.eval('document.querySelector("main.ld-lesson").innerText');
  const sel = await page.selectText({ sectionSelector: 'main.ld-lesson > section.ld-prose', exclude: [ctx.bBlock], nth: 1, mode: 'sentence' });
  check('c', 'native selection in another block', sel.selected.trim() === sel.expected.trim() && sel.blockId !== ctx.bBlock, { blockId: sel.blockId, selected: sel.selected });
  await page.toolbar();
  await page.clickButton('.ld-ed-toolbar button', t('insert'));
  const prompt = await page.prompt();
  check('c', 'insert prompt opened', prompt.mode === t('insert'), prompt);
  await page.submitPrompt(INSTRUCTIONS.c1);
  const first = await page.waitClaude('c', { kind: 'preview' });
  log({ step: 'c', screenshot: await page.screenshot('c-insert-preview') });
  must('c', 'insert preview ready', first.kind === 'preview', first);
  const inserted = await page.eval('[...document.querySelectorAll("main.ld-lesson > section.is-inserted")].map(s => ({ id: s.dataset.blockId, type: s.dataset.type, text: s.innerText.slice(0, 300) }))');
  must('c', 'inserted block shown with insert styling', inserted.length >= 1, { inserted, summary: first.text });
  const v1 = [...page.changesetViews.values()].at(-1);
  await checkTexts('c', page, v1?.summary ?? first.text, v1);
  log({ step: 'c', round1: v1 && { id: v1.id, summary: v1.summary, counts: v1.counts, warnings: v1.warnings, usage: v1.usage } });
  const target = inserted.find((s) => s.type === 'prose' || s.type === 'box') ?? inserted[0];
  const sel2 = await page.selectText({ sectionSelector: 'main.ld-lesson > section.is-inserted', blockId: target.id, mode: 'sentence' });
  const tools = await page.toolbar();
  log({ step: 'c', screenshot: await page.screenshot('c-refine-toolbar') });
  must('c', `selection inside preview offers ${t('refine')}`, tools.length === 1 && tools[0] === t('refine'), { toolbar: tools, selected: sel2.selected, blockId: sel2.blockId });
  await page.clickButton('.ld-ed-toolbar button', t('refine'));
  const p2 = await page.prompt();
  check('c', 'refine prompt shows the preview quote', p2.mode === t('refine') && !!p2.quote, p2);
  await page.submitPrompt(INSTRUCTIONS.c2);
  const second = await page.waitClaude('c', { kind: 'preview', round: 2 });
  log({ step: 'c', screenshot: await page.screenshot('c-refine-preview') });
  check('c', 'round 2 preview ready', second.kind === 'preview', second);
  const v2 = page.changesetViews.get(v1?.id);
  await checkTexts('c', page, v2?.summary ?? second.text, v2);
  log({ step: 'c', round2: v2 && { id: v2.id, round: v2.round, summary: v2.summary, counts: v2.counts, warnings: v2.warnings, usage: v2.usage } });
  if (second.kind === 'dialog') await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await page.clickButton('.ld-ed-actions button', t('cancel'));
  const toast = await page.toast(escapeRe(t('cancelled')));
  log({ step: 'c', screenshot: await page.screenshot('c-cancelled') });
  check('c', 'cancel toast', !toast.error, toast);
  check('c', 'lesson file unchanged (sha)', sha(lessonFile) === shaBefore, { shaBefore, shaAfter: sha(lessonFile) });
  const idsAfter = await page.blockIds();
  const textAfter = await page.eval('document.querySelector("main.ld-lesson").innerText');
  const leftover = await page.eval('document.querySelectorAll(".is-change, .is-inserted, .ld-ed-summary").length');
  check('c', 'DOM restored to the original lesson', JSON.stringify(idsAfter) === JSON.stringify(idsBefore) && textAfter === textBefore && leftover === 0, { idsBefore: idsBefore.length, idsAfter: idsAfter.length, textEqual: textAfter === textBefore, leftover });
}

async function stepD(ctx) {
  const { page, lessonFile, lessonId } = ctx;
  const shaBefore = sha(lessonFile);
  const sel = await page.selectText({ sectionSelector: 'main.ld-lesson > section.ld-prose, main.ld-lesson > section.ld-box', nth: 2, mode: 'phrase' });
  check('d', 'phrase selected', sel.selected.trim() === sel.expected.trim(), { blockId: sel.blockId, selected: sel.selected });
  await page.toolbar();
  await page.clickButton('.ld-ed-toolbar button', page.t('ask'));
  const prompt = await page.prompt();
  check('d', 'ask prompt opened', prompt.mode === page.t('ask'), prompt);
  await page.submitPrompt(INSTRUCTIONS.d);
  const outcome = await page.waitClaude('d', { kind: 'note', blockId: sel.blockId });
  log({ step: 'd', screenshot: await page.screenshot('d-note') });
  must('d', 'answer note beside the block', outcome.kind === 'note' && outcome.text.includes(INSTRUCTIONS.d), { text: outcome.text.slice(0, 600), waitedMs: outcome.waitedMs });
  const view = [...page.changesetViews.values()].at(-1);
  log({ step: 'd', changeset: view && { id: view.id, status: view.status, usage: view.usage, answerSources: view.answer?.sources } });
  check('d', 'lesson unchanged after ask', sha(lessonFile) === shaBefore);
  await page.openLesson(`${ctx.base}/lessons/${lessonId}`); // reload without the token: cookie auth
  // After a reload notes start closed; the asked phrase is marked and clicking it opens its note.
  const mark = await page.waitFor((blockId) => {
    // The asked block's mark: a project may already have notes on other blocks.
    const range = [...(CSS.highlights.get('ld-asked') ?? [])]
      .find((r) => r.startContainer.parentElement?.closest('section[data-block-id]')?.dataset.blockId === blockId);
    if (!range) return null;
    range.startContainer.parentElement.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = range.getClientRects()[0];
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, open: document.querySelectorAll('.ld-ed-note').length };
  }, sel.blockId, { label: 'asked passage marked' }).catch((e) => ({ error: e.message }));
  check('d', 'asked passage marked, note closed after reload', !mark.error && mark.open === 0, mark);
  if (!mark.error) await page.click(mark);
  const after = await page.waitFor((a) => {
    const n = document.querySelector(`section[data-block-id="${a.blockId}"] .ld-ed-note`);
    return n && n.innerText.includes(a.q) ? { text: n.innerText.slice(0, 200), button: document.querySelector('.ld-ed-topbtn:not([hidden])')?.textContent } : null;
  }, { blockId: sel.blockId, q: INSTRUCTIONS.d }, { label: 'note after reload' }).catch((e) => ({ error: e.message }));
  log({ step: 'd', screenshot: await page.screenshot('d-note-after-reload') });
  check('d', 'note persists after reload', !after.error, after);
  const notesFile = path.join(ctx.project, '.learndoc', 'notes', `${lessonId}.json`);
  check('d', 'note stored in .learndoc/notes', fs.existsSync(notesFile), { notesFile });
  check('d', 'lesson unchanged after reload', sha(lessonFile) === shaBefore);
  const stored = () => JSON.parse(fs.readFileSync(notesFile, 'utf8')).filter((n) => n.question === INSTRUCTIONS.d).length;
  const count = stored();
  await page.clickButton(`section[data-block-id="${sel.blockId}"] .ld-ed-note-x`, '×', 'delete note');
  await page.clickButton('dialog.ld-ed-dialog button', page.t('delete'));
  const removed = await page.waitFor((a) => (document.querySelector(`section[data-block-id="${a}"] .ld-ed-note`) ? null : true), sel.blockId, { label: 'note removed' }).catch((e) => ({ error: e.message }));
  check('d', 'deleted note leaves the page and the notes file', removed === true && stored() === count - 1, { removed, before: count, after: stored() });
}

async function stepE(ctx) {
  const { page, lessonFile, project } = ctx;
  if (!ctx.bCommit) {
    // Standalone: restore before the newest edit commit of this lesson.
    const rel = `lessons/${ctx.lessonId}.json`;
    ctx.bCommit = git(project, 'log', '-1', '--format=%H', '--invert-grep', '--grep=^learndoc: restore before', '--', rel);
    const parent = spawnSync('git', ['show', `${ctx.bCommit}^:./${rel}`], { cwd: project, encoding: 'utf8' });
    ctx.preB = parent.status === 0 ? parent.stdout : null;
    log({ step: 'e', standalone: true, commit: ctx.bCommit, hasParentVersion: ctx.preB !== null, gitShowParent: parent.stderr.trim() || undefined });
  }
  const { t } = page;
  const headBefore = git(project, 'rev-parse', 'HEAD');
  await page.clickButton('.ld-ed-topbtn', t('history'));
  const entries = await page.waitFor((loading) => {
    const d = document.querySelector('.ld-ed-drawer:not([hidden])');
    const items = d && [...d.querySelectorAll('.ld-ed-history > li')];
    if (!items?.length || items[0].textContent.includes(loading.loading)) return null;
    return items.map((li) => ({
      text: li.innerText, button: [...li.querySelectorAll('button')].some((b) => b.textContent === loading.restore),
    }));
  }, { loading: t('loading'), restore: t('restoreBefore') }, { label: 'history drawer' });
  log({ step: 'e', screenshot: await page.screenshot('e-history') });
  const short = ctx.bCommit.slice(0, 7);
  must('e', 'history lists the accepted change with a restore button', entries.some((x) => x.text.includes(short) && x.button), { entries });
  const firstCommit = ctx.firstCommit ?? git(project, 'log', '--reverse', '--format=%H', '--', `lessons/${ctx.lessonId}.json`).split('\n')[0];
  if (firstCommit) {
    const first = entries.find((x) => x.text.includes(firstCommit.slice(0, 7)));
    check('e', 'first (generated) entry shown without a restore button', first && !first.button, { first: first ?? null });
  }
  const entryButton = (a) => {
    const li = [...document.querySelectorAll('.ld-ed-history > li')].find((x) => x.querySelector('code')?.textContent === a.short);
    const button = a.text ? [...li.querySelectorAll('button')].find((b) => b.textContent === a.text) : li.querySelector('.ld-ed-history-entry');
    const r = button.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  await page.click(await page.call(entryButton, { short }));
  const jumped = await page.waitFor(() => [...document.querySelectorAll('section.is-flash')].map((s) => s.dataset.blockId).join(',') || null, null, { label: 'changed blocks flashed' }).catch((e) => ({ error: e.message }));
  check('e', 'clicking the entry scrolls to the changed blocks', !jumped.error, { jumped });
  await page.click(await page.call(entryButton, { short, text: t('viewCommitDiff') }));
  const diff = await page.waitFor((s) => {
    const bar = document.querySelector('.ld-ed-summary');
    if (!bar || !document.querySelector('.ld-ed-drawer').hidden) return null;
    return { names: bar.innerText.includes(`commit ${s}`), changes: document.querySelectorAll('section.is-change').length };
  }, short, { label: 'commit diff' }).catch((e) => ({ error: e.message }));
  log({ step: 'e', screenshot: await page.screenshot('e-diff') });
  check('e', 'View diff shows the commit in the page', !diff.error && diff.changes > 0 && diff.names, diff);
  await page.clickButton('.ld-ed-summary button', t('closeDiff'));
  const closed = await page.waitFor(() => (!document.querySelector('.ld-ed-summary') && !document.querySelector('section.is-change')) || null, null, { label: 'diff closed' }).catch((e) => ({ error: e.message }));
  check('e', 'closing the diff shows the lesson again', closed === true, { closed });
  await page.clickButton('.ld-ed-topbtn', t('history'));
  await page.waitFor((s) => [...document.querySelectorAll('.ld-ed-drawer:not([hidden]) .ld-ed-history > li')].some((li) => li.innerText.includes(s)) || null, short, { label: 'history drawer again' });
  const point = await page.call(entryButton, { short, text: t('restoreBefore') });
  await page.click(point);
  const dialog = await page.waitFor(() => document.querySelector('dialog.ld-ed-dialog[open]')?.innerText, null, { label: 'restore dialog' });
  log({ step: 'e', screenshot: await page.screenshot('e-confirm') });
  check('e', 'confirm dialog', dialog.includes(t('restoreTitle')), { dialog });
  await page.clickButton('dialog.ld-ed-dialog button', t('restore'));
  const toast = await page.toast(null);
  log({ step: 'e', screenshot: await page.screenshot('e-restored') });
  check('e', 'restore toast', !toast.error && new RegExp(pattern(t, 'reverted', '[0-9a-f]{7}')).test(toast.text), toast);
  const now = fs.readFileSync(lessonFile, 'utf8');
  const same = ctx.preB !== null && (now === ctx.preB || JSON.stringify(JSON.parse(now)) === JSON.stringify(JSON.parse(ctx.preB)));
  check('e', 'file equals the pre-(b) content', same, { bytesEqual: now === ctx.preB });
  if (ctx.baseline) {
    const rel = `lessons/${ctx.lessonId}.json`;
    const atBaseline = spawnSync('git', ['show', `${ctx.baseline}:./${rel}`], { cwd: project, encoding: 'utf8' }).stdout;
    check('e', 'file equals the commit before (b)', now === atBaseline, { baseline: ctx.baseline.slice(0, 7) });
  }
  const head = git(project, 'rev-parse', 'HEAD');
  check('e', 'new restore commit', head !== headBefore, { log: git(project, 'log', '-3', '--format=%h %s') });
  const files = head !== headBefore ? commitFiles(project, 'HEAD') : [];
  check('e', 'restore commit contains only the lesson file', files.length === 1 && files[0] === `lessons/${ctx.lessonId}.json`, { files });
}

async function stepF(ctx) {
  const { page } = ctx;
  await page.eval('getSelection().removeAllRanges(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
  const sel = await page.selectText({ sectionSelector: 'main.ld-lesson > section.ld-prose', nth: 0, mode: 'phrase' });
  await page.toolbar();
  await page.key('k', { code: 'KeyK', keyCode: 75, modifiers: CMD });
  const prompt = await page.prompt().catch((e) => ({ error: e.message }));
  log({ step: 'f', screenshot: await page.screenshot('f-shortcut') });
  check('f', `${CMD === MOD.meta ? '⌘' : 'Ctrl'}+K opens the prompt (${page.t('replace')})`, prompt.mode === page.t('replace'), { ...prompt, selected: sel.selected });
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  const closed = await page.waitFor(() => !document.querySelector('.ld-ed-prompt'), null, { label: 'prompt closed' }).catch(() => false);
  check('f', 'Esc closes the prompt', closed);
  const unselected = () => !document.querySelector('.ld-block.is-selected') && !document.querySelector('.ld-ed-toolbar:not([hidden])');
  check('f', 'Esc also drops the selection', await page.waitFor(unselected, null, { label: 'selection cleared', timeoutMs: 3000 }).catch(() => false));
  await page.selectText({ sectionSelector: 'main.ld-lesson > section.ld-prose', nth: 0, mode: 'phrase' });
  await page.toolbar();
  await page.clickButton('.ld-ed-toolbar button', page.t('ask'));
  await page.prompt();
  await page.type('draft I no longer want to send');
  await page.clickButton('.ld-ed-prompt-x', null, 'close (×)');
  const dismissed = await page.waitFor(() => !document.querySelector('.ld-ed-prompt'), null, { label: 'prompt closed' }).catch(() => false);
  const quiet = await page.eval('!document.querySelector(".ld-ed-running")');
  log({ step: 'f', screenshot: await page.screenshot('f-close-button') });
  check('f', '× closes the prompt without sending', dismissed && quiet);
  check('f', '× also drops the selection', await page.waitFor(unselected, null, { label: 'selection cleared', timeoutMs: 3000 }).catch(() => false));
  await page.eval('getSelection().removeAllRanges()');
  const box = await page.call(() => {
    const sections = [...document.querySelectorAll('main.ld-lesson > section.ld-block')];
    const first = sections.find((s) => s.dataset.type === 'prose') ?? sections[0];
    first.scrollIntoView({ block: 'start', behavior: 'instant' });
    scrollBy(0, -40);
    const i = sections.indexOf(first);
    const a = first.getBoundingClientRect();
    const b = sections[Math.min(i + 2, sections.length - 1)].getBoundingClientRect();
    return {
      from: { x: a.left + a.width * 0.6, y: a.top + 6 },
      to: { x: a.left + a.width * 0.75, y: Math.min(b.top + 10, innerHeight - 10) },
    };
  });
  await page.drag(box.from, box.to, { modifiers: MOD.alt, steps: 12 });
  const selected = await page.waitFor(() => {
    const ids = [...document.querySelectorAll('.ld-block.is-selected')].map((s) => s.dataset.blockId);
    return ids.length ? ids : null;
  }, null, { label: '.is-selected', timeoutMs: 5000 }).catch(() => []);
  const toolbar = await page.eval('[...document.querySelectorAll(".ld-ed-toolbar:not([hidden]) button")].map(b => b.childNodes[0].textContent)');
  log({ step: 'f', screenshot: await page.screenshot('f-alt-drag') });
  check('f', 'Alt+drag selects ≥ 2 blocks', selected.length >= 2, { selected, toolbar, nativeSelection: await page.eval('getSelection().toString()') });
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
}

async function stepG(ctx) {
  const { page, lessonFile } = ctx;
  const { t } = page;
  const shaBefore = sha(lessonFile);
  const panel = () => page.waitFor(() => {
    const el = document.querySelector('.ld-ed-chat:not([hidden])');
    return el && { focused: document.activeElement === el.querySelector('textarea'), draft: el.querySelector('textarea').value, chip: el.querySelector('.ld-ed-chip')?.textContent };
  }, null, { label: 'chat panel' });
  await page.clickButton('.ld-ed-topbtn', t('chat'));
  const opened = await panel();
  check('g', `${t('chat')} opens the chat with its input focused`, opened.focused && opened.chip === t('wholeLesson'), opened);
  await page.type('draft I no longer want to send');
  await page.clickButton('.ld-ed-chat .ld-ed-prompt-x', null, 'chat ×');
  const closed = await page.waitFor(() => !!document.querySelector('.ld-ed-chat[hidden]'), null, { label: 'chat closed' }).catch(() => false);
  check('g', '× closes the chat without sending', closed && !(await page.eval('!!document.querySelector(".ld-ed-running")')));
  await page.clickButton('.ld-ed-topbtn', t('chat'));
  const reopened = await panel();
  check('g', 'the closed draft is gone', reopened.draft === '' && reopened.focused, reopened);

  await page.type(INSTRUCTIONS.g);
  await page.key('Enter', { code: 'Enter', keyCode: 13, text: '\r' });
  const outcome = await page.waitClaude('g', { kind: 'preview' });
  log({ step: 'g', screenshot: await page.screenshot('g-chat-preview') });
  must('g', 'whole-lesson preview ready', outcome.kind === 'preview', outcome);
  const view = [...page.changesetViews.values()].at(-1);
  log({ step: 'g', view: view && { id: view.id, mode: view.mode, summary: view.summary, counts: view.counts, warnings: view.warnings, usage: view.usage } });
  check('g', 'changeset is whole-lesson with changes in several blocks', view?.mode === 'lesson' && (view.changes?.length ?? 0) >= 2, { mode: view?.mode, changes: view?.changes?.length });
  await checkTexts('g', page, view?.summary ?? outcome.text, view);
  const chat = await page.eval('[...document.querySelectorAll(".ld-ed-chat-msg")].map(m => ({ role: m.className.replace("ld-ed-chat-msg is-", ""), text: m.innerText.slice(0, 200) }))');
  check('g', 'chat shows the request and Claude\'s summary', chat.some((m) => m.role === 'user') && chat.some((m) => m.role === 'claude' && view && m.text.startsWith(view.summary.slice(0, 120))), { chat });
  check('g', 'no "in selection" tags on a whole-lesson preview', (await page.eval('document.querySelectorAll(".ld-ed-tag.is-primary").length')) === 0);
  check('g', 'the chat input has the focus again', await page.eval('document.activeElement === document.querySelector(".ld-ed-chat textarea")'));
  await page.type(INSTRUCTIONS.g2);
  await page.key('Enter', { code: 'Enter', keyCode: 13, text: '\r' });
  const refined = await page.waitClaude('g', { kind: 'preview', round: 2 });
  log({ step: 'g', screenshot: await page.screenshot('g-chat-refined') });
  const v2 = page.changesetViews.get(view?.id);
  check('g', 'a second message refines the open preview, still whole-lesson (round 2)', refined.kind === 'preview' && v2?.round === 2 && v2?.mode === 'lesson', { round: v2?.round, summary: v2?.summary, counts: v2?.counts });
  await page.clickButton('.ld-ed-actions button', t('cancel'));
  await page.toast(escapeRe(t('cancelled')));
  check('g', 'lesson file unchanged after cancel (sha)', sha(lessonFile) === shaBefore);
  const last = await page.eval('[...document.querySelectorAll(".ld-ed-chat-msg")].at(-1)?.innerText');
  check('g', 'chat notes the cancel', last === t('cancelled'), { last });
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  check('g', 'Esc closes the chat', await page.waitFor(() => !!document.querySelector('.ld-ed-chat[hidden]'), null, { label: 'chat closed' }).catch(() => false));
}

async function stepH(ctx) {
  const { page, project, lessonFile, lessonId } = ctx;
  const { t } = page;
  must('h', 'run with --scratch (this step rewrites git history)', ctx.scratch);
  const rel = `lessons/${lessonId}.json`;
  const original = fs.readFileSync(lessonFile, 'utf8');
  for (const n of [1, 2]) {
    fs.writeFileSync(lessonFile, original + '\n'.repeat(n));
    git(project, 'commit', '--quiet', '-m', `learndoc: e2e change ${n}`, '--', rel);
  }
  const content = fs.readFileSync(lessonFile, 'utf8');
  const entries = () => git(project, 'log', '--format=%s', '--', rel).split('\n').filter(Boolean);
  const before = entries();
  const drawer = () => page.waitFor((loading) => {
    const d = document.querySelector('.ld-ed-drawer:not([hidden])');
    const items = d && [...d.querySelectorAll('.ld-ed-history > li')];
    if (!items?.length || items[0].textContent.includes(loading)) return null;
    return items.map((li) => ({ text: li.innerText.split('\n')[0], tick: !!li.querySelector('.ld-ed-history-tick') }));
  }, t('loading'), { label: 'history drawer' });
  const deleteDialog = async (label) => {
    await page.eval('document.querySelector(".ld-ed-toast")?.classList.remove("is-visible")'); // not the previous toast
    await page.clickButton('.ld-ed-history-bulk button', label);
    await page.clickButton('dialog.ld-ed-dialog button', t('delete'));
    const toast = await page.toast(escapeRe(t('historyDeleted', 999, '\u0000')).replace('999', '\\d+').replace('\u0000', '.+'));
    return toast;
  };

  await page.clickButton('.ld-ed-topbtn', t('history'));
  const listed = await drawer();
  check('h', 'every entry but the first has a tick box', listed.slice(0, -1).every((e) => e.tick) && !listed.at(-1).tick, { listed });
  const point = await page.call((text) => {
    const li = [...document.querySelectorAll('.ld-ed-history > li')].find((x) => x.innerText.includes(text));
    const box = li.querySelector('.ld-ed-history-tick');
    box.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = box.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, 'e2e change 1');
  await page.click(point);
  const label = await page.eval('document.querySelector(".ld-ed-history-bulk button").textContent');
  check('h', 'the selected count shows on the delete button', label === t('deleteSelected', 1), { label });
  const one = await deleteDialog(t('deleteSelected', 1));
  await drawer();
  log({ step: 'h', screenshot: await page.screenshot('h-deleted-one') });
  const afterOne = entries();
  check('h', 'one entry deleted (toast, git log)', !one.error && afterOne.length === before.length - 1 && !afterOne.includes('learndoc: e2e change 1'), { toast: one, before, after: afterOne });
  check('h', 'lesson file unchanged', fs.readFileSync(lessonFile, 'utf8') === content);

  const all = await deleteDialog(t('deleteAll'));
  const remaining = await drawer();
  log({ step: 'h', screenshot: await page.screenshot('h-deleted-all') });
  check('h', 'delete all leaves only the first entry', !all.error && entries().length === 1 && remaining.length === 1 && !remaining[0].tick, { toast: all, remaining, log: entries() });
  check('h', 'lesson file unchanged and committed', fs.readFileSync(lessonFile, 'utf8') === content && git(project, 'status', '--porcelain', '--', rel) === '');
  await page.clickButton('.ld-ed-drawer-head button', t('close'));
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.out, { recursive: true });
  logFile = path.join(opts.out, 'journey.jsonl');
  fs.writeFileSync(logFile, '');
  const server = await ensureServer(opts.project);
  const lessonId = pickLesson(opts.project, opts.lesson);
  const base = `http://127.0.0.1:${server.port}`;
  const lessonUrl = `${base}/lessons/${lessonId}?t=${server.token}`;
  log({ step: 'setup', project: opts.project, lessonId, port: server.port, pid: server.pid, out: opts.out });
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found (set LEARNDOC_CHROME)');
  const browser = new ChromeBrowser(chrome);
  const page = new Page(browser, opts.out);
  const ctx = { browser, page, project: opts.project, lessonId, base, lessonUrl, lessonFile: path.join(opts.project, 'lessons', `${lessonId}.json`), scratch: opts.scratch };
  const steps = { a: stepA, b: stepB, c: stepC, d: stepD, e: stepE, f: stepF, g: stepG, h: stepH };
  try {
    await page.init();
    await page.openLesson(lessonUrl);
    const state = await page.eval(`fetch('/api/lessons/${lessonId}').then(r => r.json())`);
    page.t = makeT(state.config?.language);
    log({ step: 'setup', language: page.t.lang });
    const leftover = await page.cancelOpen(lessonId);
    if (leftover) log({ step: 'setup', cancelledOpenChangeset: leftover });
    for (const name of opts.steps) {
      const started = Date.now();
      log({ step: name, start: true });
      try {
        await steps[name](ctx);
      } catch (error) {
        check(name, 'step completed', false, { error: error.message });
        log({ step: name, screenshot: await page.screenshot(`${name}-error`).catch(() => null) });
        // Leave the page in a usable state for the next step.
        await page.openLesson(lessonUrl).catch(() => {});
        const open = await page.cancelOpen(lessonId).catch((e) => ({ error: e.message }));
        if (open) log({ step: name, recoveryCancelled: open });
      }
      log({ step: name, done: true, ms: Date.now() - started });
    }
  } finally {
    const costs = [...page.changesetViews.values()].map((v) => ({ id: v.id, mode: v.mode, status: v.status, costUsd: v.usage?.costUsd, durationMs: v.usage?.durationMs }));
    log({ step: 'summary', passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => `${r.step}: ${r.name}`), consoleProblems: browser.problems, claudeCalls: costs, totalCostUsd: costs.reduce((n, c) => n + (c.costUsd ?? 0), 0) });
    await browser.close();
  }
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

main().catch((error) => {
  log({ step: 'fatal', error: error.stack ?? String(error) });
  process.exitCode = 1;
});
