// learndoc import: converts an existing HTML course into a learndoc project without any LLM call.
// Pages are read in headless Chrome (scripts disabled, network blocked) by lib/import/extract-page.js,
// converted to lessons that record their page in `origin` (path and sha256), checked with the finalize gates
// and committed once.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChromeBrowser, findChrome } from './chrome.mjs';
import { diagnostic, selectDiagnostics } from './diagnostics.mjs';
import { runFinalize, sha256, UsageError } from './finalize.mjs';
import { commitPaths } from './git.mjs';
import { extractPage } from './import/extract-page.js';
import { PROFILE_FILE, resolveProfile } from './import/profile.mjs';
import {
  CONFIG_FILE, COURSE_FILE, formatJson, readJson, relativePath, SKILL_ROOT, STATE_DIR,
} from './project.mjs';
import { anchorSlug, slugify } from './refs.mjs';
import { decodeEntities, escapeAttr } from '../shared/html.mjs';
import { FIELD_KINDS, resolveBoxTypes, segmentField } from '../shared/render.mjs';

const readSchemaFile = (name) => JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'schemas', name), 'utf8'));
const WHITELIST = readSchemaFile('html-whitelist.json');
const CONFIG_SCHEMA = readSchemaFile('config.schema.json');
const LESSON_SCHEMA = readSchemaFile('lesson.schema.json');
const LANGUAGE = new RegExp(CONFIG_SCHEMA.properties.language.pattern);
const SLUG = new RegExp(CONFIG_SCHEMA.$defs.slug.pattern);
const REPORT_DIR = `${STATE_DIR}/import`;
const DEMO_DIR = `${REPORT_DIR}/demos`;
const INDEX_PAGE = 'index.html';
const GLOBALS_TIMEOUT_MS = 5000;
const PAGE_TIMEOUT_MS = 30000;
// Every request from the import Chrome goes to an unreachable proxy — loopback included — so no page,
// frame, socket or redirect reaches the network; file:// pages still load.
const OFFLINE_ARGS = ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'];
// WebRTC sends UDP (STUN) outside the proxy, so page scripts — which run on the course.globals page — get no
// WebRTC or media-device APIs at all.
const NO_WEBRTC = `(() => {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription']) {
    Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false });
  }
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, writable: false, configurable: false });
})();`;
const MAX_LESSON_ID = 64; // the slug limit

const naturalOrder = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const count = (map, key, n = 1) => { map[key] = (map[key] || 0) + n; };

// ---------------------------------------------------------------- source files and lesson order

function listSourceFiles(sourceDir, profile) {
  const include = new RegExp(profile.files.include, 'i');
  const exclude = profile.files.exclude.map((source) => new RegExp(source, 'i'));
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = relativePath(sourceDir, full);
        if (include.test(rel) && !exclude.some((re) => re.test(rel))) files.push(rel);
      }
    }
  };
  walk(sourceDir);
  return files.sort(naturalOrder);
}

// Source-relative path of a link or file reference made from `fromRel`, or null when it leaves the source.
function sourcePath(sourceDir, fromRel, href) {
  let url;
  try {
    url = new URL(href, pathToFileURL(path.join(sourceDir, fromRel)));
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  const rel = relativePath(sourceDir, fileURLToPath(url));
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : { rel, hash: decodeURIComponent(url.hash.slice(1)) };
}

// Loads a source page. -> false when it redirects (meta refresh, or it ended up at another URL); the browser
// is then sent to about:blank so a pending refresh cannot land in the next navigation.
async function openPage(browser, sourceDir, rel, timeoutMs = PAGE_TIMEOUT_MS) {
  const url = pathToFileURL(path.join(sourceDir, rel)).href;
  await browser.navigate(url, timeoutMs);
  const { href, refresh } = await browser.evaluate('({ href: location.href, refresh: Boolean(document.querySelector(\'meta[http-equiv="refresh" i]\')) })');
  if (!refresh && href.split('#')[0] === url) return true;
  await browser.navigate('about:blank');
  return false;
}

// Lesson records from page globals (course.globals), evaluated with page scripts enabled.
// -> [{ rel, record: { key, module, title } }]
async function orderFromGlobals(browser, sourceDir, profile) {
  const { page, expr, lessonFields: fields } = profile.course.globals;
  await browser.setScriptsEnabled(true);
  try {
    if (!await openPage(browser, sourceDir, page, GLOBALS_TIMEOUT_MS)) throw new Error(`${page} redirects`);
    const records = await browser.evaluate(`(${expr})`, { timeoutMs: GLOBALS_TIMEOUT_MS });
    if (!Array.isArray(records) || !records.length) throw new Error(`${expr} did not evaluate to a non-empty array`);
    return records.map((record) => ({
      rel: sourcePath(sourceDir, page, String(record[fields.file] ?? ''))?.rel ?? null,
      record: {
        key: record[fields.key] == null ? null : String(record[fields.key]),
        module: record[fields.module] == null ? null : String(record[fields.module]),
        title: typeof record[fields.title] === 'string' ? record[fields.title] : null,
      },
    }));
  } finally {
    await browser.setScriptsEnabled(false);
  }
}

// Lesson pages in the order index.html links to them. -> [{ rel }]
async function orderFromIndexLinks(browser, sourceDir) {
  if (!fs.existsSync(path.join(sourceDir, INDEX_PAGE))) throw new Error(`${INDEX_PAGE} not found`);
  if (!await openPage(browser, sourceDir, INDEX_PAGE)) throw new Error(`${INDEX_PAGE} redirects`);
  const hrefs = await browser.evaluate('[...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"))');
  const links = hrefs.map((href) => sourcePath(sourceDir, INDEX_PAGE, href)?.rel).filter((rel) => rel && /\.html?$/i.test(rel));
  if (!links.length) throw new Error(`${INDEX_PAGE} links to no lesson page`);
  return links.map((rel) => ({ rel }));
}

// Follows course.order, falling back globals → index-links → filename. Files that the order does not
// mention follow in natural filename order. -> { lessons: [{ rel, record? }], order }
async function lessonOrder(browser, sourceDir, files, profile, warnings) {
  const readers = { globals: () => orderFromGlobals(browser, sourceDir, profile), 'index-links': () => orderFromIndexLinks(browser, sourceDir) };
  const chain = ['globals', 'index-links'];
  let listed = [];
  let order = 'filename';
  for (const candidate of profile.course.order === 'filename' ? [] : chain.slice(chain.indexOf(profile.course.order))) {
    try {
      listed = await readers[candidate]();
      order = candidate;
      break;
    } catch (error) {
      warnings.push(diagnostic({
        code: 'import/order-fallback',
        severity: 'warning',
        message: `course order "${candidate}" is not usable (${error.message}); trying the next one`,
        subject: { order: candidate },
        supportedFixes: candidate === 'globals' ? ['check course.globals.page and course.globals.expr in the profile'] : [`link every lesson from ${INDEX_PAGE}`],
      }));
    }
  }
  const known = new Set(files);
  const seen = new Set();
  const lessons = listed.filter((entry) => known.has(entry.rel) && !seen.has(entry.rel) && seen.add(entry.rel));
  for (const rel of files) if (!seen.has(rel)) lessons.push({ rel });
  return { lessons, order };
}

// An <html lang> value in learndoc.json form (pt_BR → pt-BR), or 'en' when it is not usable.
function normalizeLanguage(lang) {
  const [primary, ...rest] = String(lang || '').trim().replace(/_/g, '-').split('-');
  const language = [primary.toLowerCase(), ...rest].join('-');
  return LANGUAGE.test(language) ? language : 'en';
}

async function courseTitle(browser, sourceDir, profile) {
  const { title } = profile.course;
  if (typeof title === 'string') return title;
  if (fs.existsSync(path.join(sourceDir, title.from)) && await openPage(browser, sourceDir, title.from)) {
    const text = await browser.evaluate(
      `(document.querySelector(${JSON.stringify(title.selector)})?.textContent || document.title || '').replace(/\\s+/g, ' ').trim()`,
    );
    if (text) return text;
  }
  return path.basename(sourceDir);
}

// ---------------------------------------------------------------- extraction

// -> the extracted page, or null (with a warning) when the page redirects or has no content.
async function extractLessonPage(browser, sourceDir, rel, options, warnings) {
  const skip = (code, message, supportedFixes) => {
    warnings.push(diagnostic({ code, severity: 'warning', message: `${rel}: ${message}; the page is not imported`, subject: { file: rel }, supportedFixes }));
    return null;
  };
  const before = browser.problems.length;
  if (!await openPage(browser, sourceDir, rel)) {
    return skip('import/redirected', 'the page redirects (meta refresh) to another address', ['import the page it redirects to', 'exclude the page with files.exclude']);
  }
  const page = await browser.evaluate(`(${extractPage.toString()})(${JSON.stringify(options)})`, { timeoutMs: PAGE_TIMEOUT_MS * 2 });
  for (const problem of browser.problems.slice(before)) {
    warnings.push(diagnostic({
      code: 'import/page-load',
      severity: 'warning',
      message: `${rel}: ${problem.url ? `${problem.url} failed to load (${problem.message})` : problem.message}`,
      subject: { file: rel },
      supportedFixes: ['check that the file referenced by the page exists in the source folder'],
    }));
  }
  if (!page.blocks.length) {
    return skip('import/empty-page', 'no content found with scripts disabled; the page may be built by JavaScript',
      ['check lesson.root in the profile', 'convert script-built pages by hand']);
  }
  return page;
}

// Profile keys whose CSS selector the browser rejects. Checked once, before any page is read.
async function invalidSelectors(browser, profile) {
  const selectors = [
    ['lesson.root', profile.lesson.root], ['lesson.header', profile.lesson.header], ['lesson.lede', profile.lesson.lede],
    ['lesson.kicker', profile.lesson.kicker], ['lesson.chips', profile.lesson.chips],
    ['demos.selector', profile.demos.selector], ['demos.title', profile.demos.title], ['demos.hint', profile.demos.hint],
    ['demos.chrome', profile.demos.chrome], ['quiz.selector', profile.quiz.selector], ['quiz.answer', profile.quiz.answer],
    ...(typeof profile.course.title === 'object' ? [['course.title.selector', profile.course.title.selector]] : []),
  ];
  return browser.evaluate(`${JSON.stringify(selectors)}.filter(([, selector]) => {
    try { document.querySelector(selector); return false; } catch { return true; }
  })`);
}

// ---------------------------------------------------------------- conversion helpers

function lessonIds(lessons) {
  const used = new Set();
  return lessons.map(({ rel }) => {
    const base = slugify(rel.replace(/\.html?$/i, '')).slice(0, MAX_LESSON_ID).replace(/-+$/, '') || 'lesson';
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base.slice(0, MAX_LESSON_ID - String(n).length - 1)}-${n}`;
    used.add(id);
    return id;
  });
}

// Gives every heading a unique anchor (its source id when that is a valid slug); anchors never look like
// page references (lib/refs.mjs anchorSlug). -> { anchors, bySourceId }
function assignAnchors(blocks) {
  const anchors = new Set();
  const bySourceId = new Map();
  for (const block of blocks) {
    if (block.type !== 'heading') continue;
    const slug = slugify(block.text);
    // Long headings are cut at a word boundary within 48 characters.
    const fromText = anchorSlug(slug.length > 48 ? slug.slice(0, 48).replace(/-[^-]*$/, '') || slug.slice(0, 48) : slug) || 'section';
    const base = SLUG.test(block.sourceId ?? '') ? anchorSlug(block.sourceId) : fromText;
    let anchor = base;
    for (let n = 2; anchors.has(anchor); n++) anchor = `${base}-${n}`;
    anchors.add(anchor);
    block.anchor = anchor;
    if (block.sourceId) bySourceId.set(block.sourceId, anchor);
  }
  return { anchors, bySourceId };
}

// Rewrites the extractor's href="RAW:…" links: https kept, links to imported lessons → lesson:<id>[#anchor],
// in-page anchors kept when they name a heading; everything else is unwrapped (counted by reason).
function resolveLinks(html, ctx) {
  return html.replace(/<a href="RAW:([^"]*)">([\s\S]*?)<\/a>/g, (_, raw, inner) => {
    const href = decodeEntities(raw);
    const link = (target) => `<a href="${escapeAttr(target)}">${inner}</a>`;
    const unwrap = (reason) => { count(ctx.linksUnwrapped, reason); return inner; };
    if (/^https:\/\//i.test(href)) return link(href);
    if (/^http:\/\//i.test(href)) return unwrap('http');
    const target = href.startsWith('#') ? { rel: ctx.rel, hash: href.slice(1) } : sourcePath(ctx.sourceDir, ctx.rel, href);
    if (!target) return unwrap(/^[a-z][a-z0-9+.-]*:/i.test(href) ? 'scheme' : 'outside-source');
    const lesson = ctx.lessonsByRel.get(target.rel);
    if (!lesson) return unwrap('not-a-lesson');
    const anchor = target.hash ? lesson.bySourceId.get(target.hash) ?? (lesson.anchors.has(target.hash) ? target.hash : null) : null;
    if (target.hash && !anchor) count(ctx.linksUnwrapped, 'anchor-dropped');
    if (lesson.id === ctx.lessonId) return anchor ? link(`#${anchor}`) : unwrap('same-page');
    return link(`lesson:${lesson.id}${anchor ? `#${anchor}` : ''}`);
  });
}

// ---------------------------------------------------------------- assets and demos

const ASSET_NAME_CHARS = /[^A-Za-z0-9._-]/g;

// Plans the copy of a figure image into assets/: never outside the source (symlinks resolved), never onto an
// existing file (names are unique case-insensitively, existing assets/ files included).
// -> 'assets/<name>' or null (with a warning) when the image cannot be imported.
function planAsset(ctx, rel, src, dropped) {
  const warn = (code, message) => {
    ctx.warnings.push(diagnostic({
      code,
      severity: 'warning',
      message: `${rel}: image ${JSON.stringify(src)} ${message}; the figure is dropped`,
      subject: { file: rel, src },
      supportedFixes: ['copy the image into the source folder and reference it by a relative path'],
    }));
    count(dropped, `figure:${code.split('/')[1]}`);
    return null;
  };
  if (/^(https?:|data:)/i.test(src)) return warn('import/asset-remote', 'is not a local file');
  let decoded;
  try {
    decoded = decodeURIComponent(src.split(/[?#]/)[0]);
  } catch {
    return warn('import/asset-outside', 'has an invalid URL escape');
  }
  if (decoded.startsWith('/') || path.isAbsolute(decoded)) return warn('import/asset-outside', 'is outside the source folder');
  let real;
  try {
    real = fs.realpathSync(path.resolve(ctx.sourceDir, path.dirname(rel), decoded));
  } catch {
    return warn('import/asset-missing', 'does not exist');
  }
  if (!real.startsWith(ctx.realSourceDir + path.sep)) return warn('import/asset-outside', 'is outside the source folder');
  if (!fs.statSync(real).isFile()) return warn('import/asset-missing', 'does not exist');
  if (!ctx.assets.has(real)) {
    const clean = path.basename(real).replace(ASSET_NAME_CHARS, '-').replace(/^[.-]/, '_');
    const ext = path.extname(clean);
    let name = clean;
    for (let n = 2; ctx.assetNames.has(name.toLowerCase()); n++) name = `${clean.slice(0, clean.length - ext.length)}-${n}${ext}`;
    ctx.assetNames.add(name.toLowerCase());
    ctx.assets.set(real, name);
  }
  return `assets/${ctx.assets.get(real)}`;
}

const IIFE_START = /\(\s*(?:\(\s*\)\s*=>|function\s*\w*\s*\(\s*\))\s*\{/g;

// The inline script driving a demo: the IIFE that mentions its id, else all inline scripts when one mentions
// it, else ''.
function demoScript(html, demoId) {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
  const mentions = [`"${demoId}"`, `'${demoId}'`, `\`${demoId}\``].map((quoted) => scripts.indexOf(quoted)).filter((at) => at >= 0);
  if (!mentions.length) return '';
  const at = Math.min(...mentions);
  let start = -1;
  for (const match of scripts.matchAll(IIFE_START)) if (match.index < at) start = match.index;
  if (start < 0) return scripts;
  let depth = 0;
  for (let i = scripts.indexOf('{', start); i < scripts.length; i++) {
    if (scripts[i] === '{') depth += 1;
    else if (scripts[i] === '}' && --depth === 0) {
      const tail = /^[^\n;]*;?/.exec(scripts.slice(i + 1))[0];
      return scripts.slice(start, i + 1 + tail.length);
    }
  }
  return scripts;
}

// The first profile candidate whose conditions all hold. -> { widget, reason } | null
function demoCandidate(profile, demo, js) {
  const words = `${demo.title} ${demo.hintText}`;
  for (const candidate of profile.demos.candidates) {
    const reasons = [];
    if (candidate.words !== undefined) {
      if (!new RegExp(candidate.words, 'i').test(words)) continue;
      reasons.push(`title/hint match /${candidate.words}/`);
    }
    if (candidate.js !== undefined) {
      if (!new RegExp(candidate.js, 'i').test(js)) continue;
      reasons.push(`script matches /${candidate.js}/`);
    }
    if (candidate.maxControls !== undefined) {
      if (demo.controls > candidate.maxControls) continue;
      reasons.push(`${demo.controls} control(s) ≤ ${candidate.maxControls}`);
    }
    return { widget: candidate.widget, reason: reasons.join('; ') || 'listed without conditions' };
  }
  return null;
}

// A pending demo plus the files that keep its markup and script for a later widget conversion.
// -> { pending, files: [{ file, text }] }
function demoJob(demo, { id, html, profile, blockId: block, stems }) {
  const base = `${id}--${demo.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  let stem = base;
  for (let n = 2; stems.has(stem); n++) stem = `${base}-${n}`;
  stems.add(stem);
  const js = demoScript(html, demo.id);
  const htmlFile = `${DEMO_DIR}/${stem}.html`;
  const jsFile = js ? `${DEMO_DIR}/${stem}.js` : null;
  return {
    pending: {
      lesson: id,
      blockId: block,
      demoId: demo.id,
      title: demo.title,
      hintText: demo.hintText,
      htmlFile,
      jsFile,
      controls: demo.controls,
      svgs: demo.svgs,
      canvases: demo.canvases,
      candidate: demoCandidate(profile, demo, js),
      status: 'pending',
    },
    files: [{ file: htmlFile, text: `${demo.outerHTML}\n` }, ...(jsFile ? [{ file: jsFile, text: `${js}\n` }] : [])],
  };
}

// ---------------------------------------------------------------- lesson conversion

function mathCount(lesson) {
  let n = 0;
  const scan = (value, kind) => { n += segmentField(value, kind).segments.filter((s) => s.type === 'math').length; };
  scan(lesson.title, 'plain');
  if (lesson.lede) scan(lesson.lede, 'plain');
  for (const block of lesson.blocks) {
    if (block.type === 'math') n += 1;
    for (const [field, kind] of Object.entries(FIELD_KINDS[block.type])) {
      if (kind !== 'raw' && typeof block[field] === 'string') scan(block[field], kind);
    }
  }
  return n;
}

function blockId(seen, ...parts) {
  for (let n = 0; ; n++) {
    const id = `b-${sha256(parts.join('\u0000') + (n ? `#${n}` : '')).slice(0, 8)}`;
    if (!seen.has(id)) {
      seen.add(id);
      return id;
    }
  }
}

const firstSentence = (text) => (/^.*?[.?!](\s|$)/.exec(text)?.[0] ?? text).trim().slice(0, 300);
const sameNumber = (a, b) => /^\d+$/.test(a) && /^\d+$/.test(b) && Number(a) === Number(b);

// The lesson id a prereq reference (e.g. "3" or "03") names: by globals key, by exact id, or by the numeric
// prefix of an id ("03-…"); numbers compare by value. -> id or null
function lessonForReference(entries, reference) {
  const byKey = entries.find((entry) => entry.record?.key === reference)
    ?? entries.find((entry) => entry.record?.key != null && sameNumber(entry.record.key, reference));
  if (byKey) return byKey.id;
  const byId = entries.find((entry) => entry.id === reference)
    ?? entries.find((entry) => sameNumber(/^(\d+)-/.exec(entry.id)?.[1] ?? '', reference));
  return byId?.id ?? null;
}

// A lesson's number: its numeric globals key, else its numeric id or id prefix ("03-…"). -> number or null
function lessonNumber(entry) {
  const digits = /^\d+$/.test(entry.record?.key ?? '') ? entry.record.key : /^(\d+)(-|$)/.exec(entry.id)?.[1];
  return digits === undefined ? null : Number(digits);
}

// Without a `ref`, every number in the chip is a reference. A keyword-anchored ref (e.g. "Bài\\s*(\\d+)") is
// recommended: it skips numbers that are not lessons ("Mục 10–12"), and continuation still collects lists.
const DEFAULT_PREREQ_REF = '\\d+';
// Hyphen, Unicode hyphen, non-breaking hyphen, figure dash, en dash, em dash, minus.
const RANGE_END = /^\s*[-\u2010\u2011\u2012\u2013\u2014\u2212]\s*(\d+)/;
// After a reference: an optional parenthetical, a separator, then another number ("…(rank), 05 (SVD)").
const CONTINUATION = /^\s*(?:\([^)]*\)\s*)?(?:,|;|\/|&|và|and)\s*(\d+)/i;

// The lessons a prereq chip names. Each match of `ref` (its first group, else the whole match) names a lesson,
// and so does each continuation number after it; a number followed by "-NN", "–NN" or "—NN" is a range naming
// every lesson numbered within it — unless it ends past the last lesson ("Bài 05 – 2023 edition" names 05).
// Unknown references are ignored. -> ids, deduplicated, in order of mention
export function prereqIds(chipText, ref, entries) {
  const text = chipText.normalize('NFC');
  const ids = [];
  const highest = Math.max(...entries.map(lessonNumber).filter((n) => n !== null));
  const pattern = new RegExp((ref ?? DEFAULT_PREREQ_REF).normalize('NFC'), 'gi');
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (!match[0]) {
      pattern.lastIndex += 1;
      continue;
    }
    let at = match.index + match[0].length;
    const take = (value) => {
      const end = /^\d+$/.test(value) ? RANGE_END.exec(text.slice(at)) : null;
      if (!end || Number(end[1]) > highest) {
        ids.push(lessonForReference(entries, value));
        return;
      }
      at += end[0].length;
      const [low, high] = [Number(value), Number(end[1])];
      ids.push(...entries.map((entry) => ({ id: entry.id, n: lessonNumber(entry) }))
        .filter(({ n }) => n !== null && n >= low && n <= high)
        .sort((a, b) => a.n - b.n)
        .map(({ id }) => id));
    };
    take(match[1] ?? match[0]);
    for (let next = CONTINUATION.exec(text.slice(at)); next; next = CONTINUATION.exec(text.slice(at))) {
      at += next[0].length;
      take(next[1]);
    }
    pattern.lastIndex = at;
  }
  return [...new Set(ids.filter(Boolean))];
}

// Header chips → meta.duration, or a muted prose line; prereq chips also yield prereq lessons (their text,
// which may say more than the lesson references, stays as prose).
function applyChips(page, profile, entries) {
  const meta = {};
  const prereq = [];
  const prose = [];
  for (const chip of page.chips) {
    const rule = profile.lesson.chipRules.find((entry) => new RegExp(entry.label, 'i').test(chip.label || chip.text));
    if (rule?.to === 'meta.duration') {
      meta.duration = chip.text.replace(/^[^:]*:\s*/, '');
      continue;
    }
    if (rule?.to === 'prereq') prereq.push(...prereqIds(chip.text, rule.ref, entries));
    prose.push(chip.html);
  }
  return { meta, prereq, prose };
}

// One extracted page → { lesson, courseEntry, pendingDemos, files, report }. Writes nothing:
// demo files come back in `files`, images are planned in ctx.assets.
function convertPage(entry, ctx) {
  const { page, id, rel } = entry;
  const dropped = { ...page.stats.dropped };
  const linksUnwrapped = {};
  const linkCtx = { ...ctx, rel, lessonId: id, linksUnwrapped };
  const chips = applyChips(page, ctx.profile, ctx.entries);
  const raw = [
    ...(chips.prose.length ? [{ type: 'prose', html: `<p class="muted">${chips.prose.join('<br>')}</p>` }] : []),
    ...page.blocks,
  ];
  const seen = new Set();
  const stems = new Set();
  const blocks = [];
  const pendingDemos = [];
  const files = [];
  for (const block of raw) {
    const out = { id: '', type: block.type };
    if (block.type === 'heading') Object.assign(out, { level: block.level, anchor: block.anchor, text: block.text });
    else if (block.type === 'prose') out.html = resolveLinks(block.html, linkCtx);
    else if (block.type === 'box') Object.assign(out, { variant: block.variant, title: block.title, html: resolveLinks(block.html, linkCtx) });
    else if (block.type === 'math') out.latex = block.latex;
    else if (block.type === 'code') Object.assign(out, { language: block.language, code: block.code });
    else if (block.type === 'quiz') Object.assign(out, { question: block.question, answer: resolveLinks(block.answer, linkCtx) });
    else if (block.type === 'figure') {
      if (block.svg !== undefined) out.svg = block.svg;
      else {
        const src = planAsset(ctx, rel, block.imgSrc, dropped);
        if (!src) continue;
        out.src = src;
      }
      Object.assign(out, { alt: block.alt, caption: block.caption });
    }
    const key = out.text ?? out.title ?? out.html ?? out.latex ?? out.code ?? out.caption ?? out.question ?? '';
    out.id = blockId(seen, id, block.type, key);
    blocks.push(out);
    if (block.demo !== undefined) {
      const job = demoJob(page.demos[block.demo], { id, html: entry.html, profile: ctx.profile, blockId: out.id, stems });
      pendingDemos.push(job.pending);
      files.push(...job.files);
    }
  }
  const lesson = {
    schemaVersion: 1,
    id,
    title: page.title || path.basename(rel),
    ...(page.lede ? { lede: page.lede } : {}),
    ...(Object.keys(chips.meta).length ? { meta: chips.meta } : {}),
    origin: { file: relativePath(ctx.root, path.join(ctx.sourceDir, rel)), sha256: sha256(fs.readFileSync(path.join(ctx.sourceDir, rel))) },
    blocks,
  };
  const prereq = [...new Set(chips.prereq)].filter((target) => target !== id);
  const courseEntry = {
    id,
    title: entry.record?.title || lesson.title,
    ...(page.lede ? { summary: firstSentence(page.lede) } : {}),
    prereq,
    status: 'done',
  };
  if (page.kicker) count(dropped, 'header:kicker');
  const blockCounts = {};
  for (const block of blocks) count(blockCounts, block.type);
  const report = {
    id,
    file: rel,
    blocks: blockCounts,
    math: { source: page.measure.math, output: mathCount(lesson) },
    svg: { source: page.measure.svg, output: blocks.filter((b) => b.type === 'figure' && b.svg).length, inDemos: page.measure.svgInDemos },
    demos: pendingDemos.length,
    dropped,
    approx: page.stats.approx,
    linksUnwrapped,
  };
  return { lesson, courseEntry, pendingDemos, files, report };
}

// Course modules from course.modules (matched against the globals module key, else the source path);
// unmatched lessons go to an "Other" module, and without modules every lesson is in one module.
function buildModules(profile, title, entries) {
  if (!profile.course.modules.length) return [{ id: 'lessons', title, lessons: entries.map((e) => e.courseEntry) }];
  const modules = profile.course.modules.map((module) => ({ id: module.id, title: module.title, match: new RegExp(module.match), lessons: [] }));
  const other = { id: 'other', title: 'Other', lessons: [] };
  for (const entry of entries) {
    const value = entry.record?.module ?? entry.rel;
    (modules.find((module) => module.match.test(value)) ?? other).lessons.push(entry.courseEntry);
  }
  return [...modules, other].filter((module) => module.lessons.length).map(({ id, title: moduleTitle, lessons }) => ({ id, title: moduleTitle, lessons }));
}

// ---------------------------------------------------------------- phases

// -> { user: parsed profile | null, profile: resolved | null, diagnostics }
function loadProfile(cwd, profileFile) {
  const file = profileFile ? path.resolve(cwd, profileFile) : path.join(cwd, PROFILE_FILE);
  if (profileFile && !fs.existsSync(file)) throw new UsageError(`profile ${profileFile} does not exist`);
  if (!fs.existsSync(file)) return { user: null, ...resolveProfile({}, 'default profile') };
  const { value, diagnostic: problem } = readJson(file, { root: cwd });
  if (problem) return { user: null, profile: null, diagnostics: [problem] };
  return { user: value, ...resolveProfile(value, relativePath(cwd, file)) };
}

// Refuses the source folder itself, a folder inside it, and folders that already hold a project. -> diagnostics
function checkTarget(root, sourceDir) {
  if (fs.realpathSync(root) === fs.realpathSync(sourceDir)) {
    return [diagnostic({
      code: 'import/target-is-source',
      message: `import writes a new project and cannot run inside the source folder ${sourceDir}`,
      subject: { project: root, source: sourceDir },
      supportedFixes: ['run import in a new, empty folder'],
    })];
  }
  if (fs.realpathSync(root).startsWith(fs.realpathSync(sourceDir) + path.sep)) {
    return [diagnostic({
      code: 'import/target-inside-source',
      message: `import cannot write the new project inside the source folder ${sourceDir}`,
      subject: { project: root, source: sourceDir },
      supportedFixes: ['run import in a new, empty folder outside the source folder'],
    })];
  }
  const existing = [CONFIG_FILE, COURSE_FILE, 'lessons'].filter((name) => fs.existsSync(path.join(root, name)));
  if (!existing.length) return [];
  return [diagnostic({
    code: 'import/target-exists',
    message: `${root} already holds a learndoc project (${existing.join(', ')}); import only writes into a folder without one`,
    subject: { project: root, existing },
    supportedFixes: ['run import in a new, empty folder'],
  })];
}

// Orders and reads every page with one headless Chrome (scripts disabled, network cut off). Pages that
// redirect or have no content are skipped. -> { problems } for invalid profile selectors, else
// { order, title, language, entries: [{ id, rel, record, page, html }] }
async function extractAll({ chromePath, env, sourceDir, files, profile, warnings }) {
  let browser = null;
  try {
    browser = new ChromeBrowser(chromePath, { env, extraArgs: OFFLINE_ARGS });
    await browser.blockUrls(['http://*', 'https://*', 'ws://*', 'wss://*']);
    await browser.addInitScript(NO_WEBRTC);
    const invalid = await invalidSelectors(browser, profile);
    if (invalid.length) {
      return {
        problems: invalid.map(([key, selector]) => diagnostic({
          code: 'import/profile-invalid',
          message: `profile ${key} ${JSON.stringify(selector)} is not a valid CSS selector`,
          subject: { path: key, selector },
          supportedFixes: [`fix ${key} in the profile`],
        })),
      };
    }
    await browser.setScriptsEnabled(false);
    const { lessons, order } = await lessonOrder(browser, sourceDir, files, profile, warnings);
    const title = await courseTitle(browser, sourceDir, profile);
    const options = { profile, whitelist: WHITELIST, codeLanguage: LESSON_SCHEMA.$defs.code.properties.language.pattern };
    const kept = [];
    for (const lesson of lessons) {
      const page = await extractLessonPage(browser, sourceDir, lesson.rel, options, warnings);
      if (page) kept.push({ rel: lesson.rel, record: lesson.record ?? null, page, html: fs.readFileSync(path.join(sourceDir, lesson.rel), 'utf8') });
    }
    const ids = lessonIds(kept);
    const entries = kept.map((entry, i) => ({ id: ids[i], ...entry }));
    const language = profile.language ?? normalizeLanguage(entries[0]?.page.lang);
    return { order, title, language, entries };
  } finally {
    await browser?.close();
  }
}

// Converts and writes the project files. -> { paths (to commit), pendingDemos, assets, profileText }
function writeProject({ root, sourceDir, extracted, profile, user, warnings }) {
  const { entries, title, language } = extracted;
  // Untitled boxes take their variant's label in the course language (or the profile's fallback title).
  const boxTypes = resolveBoxTypes({ language, boxTypes: profile.boxes.boxTypes });
  for (const block of entries.flatMap((entry) => entry.page.blocks)) {
    if (block.type === 'box') block.title ??= profile.boxes.fallbackTitles[block.variant] ?? boxTypes[block.variant]?.label ?? block.variant;
  }
  const assetsDir = path.join(root, 'assets');
  const existingAssets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).map((name) => name.toLowerCase()) : [];
  const lessonsByRel = new Map(entries.map((entry) => [entry.rel, { id: entry.id, ...assignAnchors(entry.page.blocks) }]));
  const ctx = {
    root, sourceDir, realSourceDir: fs.realpathSync(sourceDir), profile, warnings, entries, lessonsByRel,
    assets: new Map(), assetNames: new Set(existingAssets),
  };
  const paths = [CONFIG_FILE, COURSE_FILE, 'lessons'];
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const pendingDemos = [];
  for (const entry of entries) {
    Object.assign(entry, convertPage(entry, ctx));
    write(`lessons/${entry.id}.json`, formatJson(entry.lesson));
    for (const { file, text } of entry.files) write(file, text);
    pendingDemos.push(...entry.pendingDemos);
  }
  for (const [from, name] of ctx.assets) {
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.copyFileSync(from, path.join(assetsDir, name), fs.constants.COPYFILE_EXCL);
    paths.push(`assets/${name}`);
  }
  const config = {
    schemaVersion: 1,
    language,
    features: { math: true },
    ...(Object.keys(profile.boxes.boxTypes).length ? { boxTypes: profile.boxes.boxTypes } : {}),
  };
  write(CONFIG_FILE, formatJson(config));
  write(COURSE_FILE, formatJson({ schemaVersion: 1, title, modules: buildModules(profile, title, entries) }));
  // A given profile is kept as written, so the project records how it was imported.
  const profileText = user ? formatJson(user) : null;
  if (profileText) {
    write(PROFILE_FILE, profileText);
    paths.push(PROFILE_FILE);
  }
  return { paths, pendingDemos, assets: ctx.assets.size, profileText };
}

// Finalize gates for the config, the course and every lesson, then one commit of `paths`.
// -> { projectGates, commit, errors }
async function gateAndCommit({ root, env, entries, paths, message, warnings }) {
  const errors = [];
  const gate = async (file, shouldCommit) => {
    const { receipt } = await runFinalize({ file, cwd: root, env, commit: shouldCommit });
    if (receipt.status === 'fail') errors.push(...receipt.diagnostics.filter((entry) => entry.severity === 'error'));
    return receipt;
  };
  const projectGates = [await gate(CONFIG_FILE), await gate(COURSE_FILE)];
  for (const entry of entries) entry.receipt = await gate(`lessons/${entry.id}.json`, false);
  let commit = null;
  try {
    commit = commitPaths(root, paths, message);
  } catch (error) {
    warnings.push(diagnostic({
      code: 'import/commit-failed',
      severity: 'warning',
      message: `the imported project could not be committed: ${error.message}`,
      subject: { project: root },
      supportedFixes: ['configure git user.name and user.email, then commit the project files'],
    }));
  }
  return { projectGates, commit, errors };
}

// Writes .learndoc/import/report.json. -> { file, totals }
function writeReport({ root, sourceDir, order, profileText, commit, entries, projectGates, pendingDemos, assets }) {
  const lessons = entries.map((entry) => ({
    ...entry.report,
    status: entry.receipt.status,
    gates: entry.receipt.gates,
    diagnostics: entry.receipt.diagnostics,
  }));
  const pass = lessons.filter((lesson) => lesson.status === 'pass').length;
  const totals = {
    lessons: lessons.length,
    pass,
    fail: lessons.length - pass,
    blocks: {},
    math: { source: 0, output: 0 },
    svg: { source: 0, output: 0, inDemos: 0 },
    demos: pendingDemos.length,
    demosWithCandidate: pendingDemos.filter((demo) => demo.candidate).length,
    assets,
  };
  for (const lesson of lessons) {
    for (const [type, n] of Object.entries(lesson.blocks)) count(totals.blocks, type, n);
    for (const key of ['source', 'output']) totals.math[key] += lesson.math[key];
    for (const key of ['source', 'output', 'inDemos']) totals.svg[key] += lesson.svg[key];
  }
  const file = path.join(root, REPORT_DIR, 'report.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, formatJson({
    schemaVersion: 1,
    source: sourceDir,
    order,
    profileSha: profileText ? sha256(profileText) : null,
    generatedAt: new Date().toISOString(),
    commit,
    totals,
    project: Object.fromEntries(projectGates.map((receipt) => [
      relativePath(root, receipt.target.path),
      { status: receipt.status, diagnostics: receipt.diagnostics },
    ])),
    lessons,
    pendingDemos,
  }));
  return { file, totals };
}

// -> { exitCode, receipt }. Throws UsageError when `source` is not a directory or --profile is missing.
export async function runImport({ source, cwd = process.cwd(), profileFile, env = process.env }) {
  const started = Date.now();
  const sourceDir = path.resolve(cwd, source);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) throw new UsageError(`${source} is not a directory`);
  const root = path.resolve(cwd);
  const fail = (diagnostics) => receiptFor({ ok: false, started, diagnostics });

  const targetProblems = checkTarget(root, sourceDir);
  if (targetProblems.length) return fail(targetProblems);
  const { user, profile, diagnostics: profileProblems } = loadProfile(cwd, profileFile);
  if (!profile) return fail(profileProblems);
  const chromePath = findChrome({ env });
  if (!chromePath) {
    return fail([diagnostic({
      code: 'import/chrome-missing',
      message: 'import reads the pages in headless Chrome, and no Chrome or Chromium executable was found',
      subject: {},
      supportedFixes: ['install Google Chrome or Chromium', 'set LEARNDOC_CHROME to the browser executable'],
    })]);
  }
  const files = listSourceFiles(sourceDir, profile);
  if (!files.length) {
    return fail([diagnostic({
      code: 'import/no-pages',
      message: `no file in ${sourceDir} matches files.include ${JSON.stringify(profile.files.include)}`,
      subject: { source: sourceDir },
      supportedFixes: ['adjust files.include / files.exclude in the profile'],
    })]);
  }

  const warnings = [];
  const extracted = await extractAll({ chromePath, env, sourceDir, files, profile, warnings });
  if (extracted.problems) return fail(extracted.problems);
  if (!extracted.entries.length) {
    return fail([diagnostic({
      code: 'import/no-pages',
      message: `every page in ${sourceDir} was skipped (see the warnings); nothing to import`,
      subject: { source: sourceDir },
      supportedFixes: ['check lesson.root and files.include in the profile'],
    }), ...warnings]);
  }
  const written = writeProject({ root, sourceDir, extracted, profile, user, warnings });
  const { entries } = extracted;
  const gated = await gateAndCommit({
    root,
    env,
    entries,
    paths: written.paths,
    message: `learndoc: import ${entries.length} lessons from ${path.basename(sourceDir)}`,
    warnings,
  });
  const report = writeReport({ root, sourceDir, order: extracted.order, entries, ...written, ...gated });
  return receiptFor({
    ok: gated.projectGates.every((receipt) => receipt.status === 'pass') && report.totals.fail === 0,
    started,
    diagnostics: [...gated.errors, ...warnings],
    lessons: { total: report.totals.lessons, pass: report.totals.pass, fail: report.totals.fail },
    pendingDemos: { total: report.totals.demos, withCandidate: report.totals.demosWithCandidate },
    report: report.file,
    commit: gated.commit,
  });
}

function receiptFor({ ok, started, diagnostics, lessons = { total: 0, pass: 0, fail: 0 }, pendingDemos = { total: 0, withCandidate: 0 }, report = null, commit = null }) {
  return {
    exitCode: ok ? 0 : 1,
    receipt: {
      schemaVersion: 1,
      ok,
      command: 'import',
      status: ok ? 'pass' : 'fail',
      lessons,
      pendingDemos,
      report,
      commit,
      ...selectDiagnostics(diagnostics),
      durationMs: Date.now() - started,
    },
  };
}
