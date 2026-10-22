// Standalone pages: html/index.html and html/<id>.html that open from disk (file://) without the
// server, plus a double-click launcher that starts the edit server. Styles, KaTeX and figure images
// are written once into html/_assets/ and linked; the runtime modules are inlined into each page,
// because browsers do not load module scripts from file://. The html/ folder is self-contained.
// Rewritten after every finalize, accept, restore and server start.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { escapeAttr, escapeHtml } from '../shared/html.mjs';
import { localized } from '../shared/render.mjs';
import { jsonScript, renderIndexPage, renderLessonPage } from './page.mjs';
import { CONFIG_FILE, COURSE_FILE, lessonFile, resolveWidget, SKILL_ROOT } from './project.mjs';

export const EXPORT_DIR = 'html';
const ASSETS = '_assets';
const GENERATOR = '<meta name="generator" content="learndoc export">';
const RUNTIME = path.join(SKILL_ROOT, 'runtime');
const KATEX_DIR = path.join(RUNTIME, 'vendor', 'katex');

// The edit server listens on a port derived from the project path, so a standalone page knows
// where to look for it. serve falls back to a random port when this one is taken.
const PORT_BASE = 41000;
const PORT_SPAN = 8000;

const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

export function preferredPort(root) {
  return PORT_BASE + (createHash('sha256').update(realpath(root)).digest().readUInt32BE(0) % PORT_SPAN);
}

const LAUNCHER_NAME = { vi: 'Mở khoá học', en: 'Open course' };
const LAUNCHER_EXT = { darwin: '.command', win32: '.cmd' };

export const launcherName = (language, platform = process.platform) => `${localized(LAUNCHER_NAME, language).normalize('NFC')}${LAUNCHER_EXT[platform] ?? '.sh'}`;

const EDIT_TEXT = {
  vi: {
    button: 'Sửa',
    title: 'Chế độ sửa chưa bật',
    body: (launcher) => `Mở thư mục khoá học (thư mục chứa thư mục <code>html</code>) và double-click file <strong>${escapeHtml(launcher)}</strong>. Trình duyệt sẽ mở trang có chế độ sửa; lần sau bấm Sửa trên trang này sẽ vào thẳng.`,
    retry: 'Vẫn mở trình sửa',
    close: 'Đóng',
  },
  en: {
    button: 'Edit',
    title: 'Editing is not running',
    body: (launcher) => `Open the course folder (the one containing the <code>html</code> folder) and double-click <strong>${escapeHtml(launcher)}</strong>. The browser opens the editable page; after that, Edit on this page goes straight there.`,
    retry: 'Open the editor anyway',
    close: 'Close',
  },
};

// ---------- inlining ----------

const inlineScript = (source) => source.replace(/<\/(script)/gi, '<\\/$1');
const dataUrl = (type, bytes) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

// Module specifiers the runtime uses: relative ones and the server's /static/ paths.
function resolveSpecifier(from, specifier) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) return path.resolve(path.dirname(from), specifier);
  if (specifier.startsWith('/static/')) return path.join(SKILL_ROOT, specifier.slice('/static/'.length));
  return null;
}

const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g;

// An ES module's source with every local import replaced by the data: URL of that module, so the
// whole graph loads without fetching anything. -> source text
function inlineModuleSource(file, cache, stack = []) {
  if (stack.includes(file)) throw new Error(`import cycle: ${[...stack, file].map((f) => path.basename(f)).join(' -> ')}`);
  return fs.readFileSync(file, 'utf8').replace(IMPORT_RE, (match, keyword, quote, specifier) => {
    const dep = resolveSpecifier(file, specifier);
    return dep ? `${keyword}${quote}${moduleDataUrl(dep, cache, [...stack, file])}${quote}` : match;
  });
}

function moduleDataUrl(file, cache, stack = []) {
  if (!cache.has(file)) cache.set(file, dataUrl('text/javascript', inlineModuleSource(file, cache, stack)));
  return cache.get(file);
}

// KaTeX's stylesheet loads fonts/<name>.woff2 relative to itself.
function katexFiles() {
  const fonts = fs.readdirSync(path.join(KATEX_DIR, 'fonts')).filter((name) => name.endsWith('.woff2'));
  return [
    [`${ASSETS}/katex.min.css`, path.join(KATEX_DIR, 'katex.min.css')],
    [`${ASSETS}/katex.min.js`, path.join(KATEX_DIR, 'katex.min.js')],
    ...fonts.map((name) => [`${ASSETS}/fonts/${name}`, path.join(KATEX_DIR, 'fonts', name)]),
  ];
}

// An image inside the project, by its project-relative src; null for anything else.
function projectImage(root, src) {
  const file = path.resolve(root, src);
  const inside = realpath(file).startsWith(realpath(root) + path.sep);
  return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()) && inside && fs.existsSync(file) ? file : null;
}

// Opens the server's page when something answers on the port, else explains the launcher.
function editScript({ language, launcher }) {
  const text = localized(EDIT_TEXT, language);
  const help = '<div class="ld-edit-help" role="dialog" aria-modal="false">'
    + `<strong>${escapeHtml(text.title)}</strong><p>${text.body(launcher)}</p>`
    + `<div class="ld-edit-help-actions"><a class="ld-edit-retry" href="#">${escapeHtml(text.retry)}</a>`
    + `<button type="button" class="ld-edit-close">${escapeHtml(text.close)}</button></div></div>`;
  return `<script>(() => {
  const HELP = ${jsonScript(help)};
  document.addEventListener('click', async (event) => {
    const close = event.target.closest && event.target.closest('.ld-edit-close');
    if (close) return close.closest('.ld-edit-help').remove();
    const link = event.target.closest && event.target.closest('.ld-edit-open, .ld-edit-retry');
    if (!link) return;
    event.preventDefault();
    const open = document.querySelector('.ld-edit-open');
    if (link.classList.contains('ld-edit-retry')) return void (location.href = open.href);
    const up = await fetch(new URL('/api/health', open.href), { mode: 'no-cors', cache: 'no-store' }).then(() => true, () => false);
    if (up) return void (location.href = open.href);
    if (!document.querySelector('.ld-edit-help')) open.closest('.ld-topbar').insertAdjacentHTML('afterend', HELP);
  });
})();</script>`;
}

// `files` collects what the pages link to: html/-relative path -> source file.
function fileTarget({ root, config, files }) {
  const language = config.language;
  const base = `http://127.0.0.1:${preferredPort(root)}`;
  const launcher = launcherName(language);
  const modules = new Map();
  const lessonModule = inlineScript(inlineModuleSource(path.join(RUNTIME, 'lesson.js'), modules));
  files.set(`${ASSETS}/style.css`, path.join(RUNTIME, 'style.css'));
  const lessonFileName = (id) => `${encodeURIComponent(id)}.html`;
  return {
    home: 'index.html',
    lessonHref: lessonFileName,
    linkBase: (target) => {
      const at = target.indexOf('#');
      return at < 0 ? lessonFileName(target) : `${lessonFileName(target.slice(0, at))}${target.slice(at)}`;
    },
    // Outside the project or missing: left pointing at the project, as the server would have it.
    assetUrl: (src) => {
      const file = projectImage(root, src);
      if (!file) return `../${src}`;
      files.set(`${ASSETS}/media/${src}`, file);
      return `${ASSETS}/media/${src.split('/').map(encodeURIComponent).join('/')}`;
    },
    styles: (math) => {
      if (math) for (const [name, file] of katexFiles()) files.set(name, file);
      return [GENERATOR, ...(math ? [`<link rel="stylesheet" href="${ASSETS}/katex.min.css">`] : []), `<link rel="stylesheet" href="${ASSETS}/style.css">`];
    },
    katexScript: () => `<script src="${ASSETS}/katex.min.js"></script>`,
    // Only the widgets this lesson uses: nothing replaces blocks in a standalone page.
    widgetMap: (projectRoot, lesson) => Object.fromEntries(lesson.blocks
      .filter((block) => block.type === 'widget')
      .map((block) => [block.widget, resolveWidget(projectRoot, block.widget)])
      .filter(([, widget]) => widget)
      .map(([name, widget]) => [name, moduleDataUrl(widget.file, modules)])),
    lessonScript: () => `<script type="module">${lessonModule}</script>\n${editScript({ language, launcher })}`,
    topbarActions: (lessonId) => {
      const href = lessonId ? `${base}/lessons/${encodeURIComponent(lessonId)}` : `${base}/`;
      return `<a class="ld-edit-open" href="${escapeAttr(href)}">✎ ${escapeHtml(localized(EDIT_TEXT, language).button)}</a>`;
    },
  };
}

// ---------- launcher ----------

const shQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

const LAUNCHER_TEXT = {
  vi: { opened: 'Đã mở khoá học trong trình duyệt. Có thể đóng cửa sổ này.', failed: 'Không mở được khoá học:', enter: 'Nhấn Enter để đóng.' },
  en: { opened: 'The course is open in your browser. You can close this window.', failed: 'Could not open the course:', enter: 'Press Enter to close.' },
};

function launcherScript(platform, language) {
  const text = localized(LAUNCHER_TEXT, language);
  const cli = path.join(SKILL_ROOT, 'bin', 'learndoc.mjs');
  // PATH as seen now, so a double-click (which gets a minimal PATH) still finds node and claude.
  // De-duplicated: a server started by the launcher exports again with the launcher's PATH.
  const envPath = [...new Set((process.env.PATH ?? '').split(path.delimiter).filter(Boolean))].join(path.delimiter);
  if (platform === 'win32') {
    return [
      '@echo off',
      'rem Generated by learndoc: double-click to open this course with editing on. Rewritten on every export.',
      'chcp 65001 >nul',
      'cd /d "%~dp0"',
      `set "PATH=${envPath};%PATH%"`,
      `"${process.execPath}" "${cli}" serve`,
      'if errorlevel 1 pause',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/bash',
    '# Generated by learndoc: double-click to open this course with editing on. Rewritten on every export.',
    'cd "$(dirname "$0")" || exit 1',
    `export PATH=${shQuote(envPath)}:"$PATH"`,
    `NODE=${shQuote(process.execPath)}`,
    '[ -x "$NODE" ] || NODE=node',
    `out=$("$NODE" ${shQuote(cli)} serve 2>&1)`,
    'case "$out" in',
    `  *'"ok":true'*) echo ${shQuote(text.opened)} ;;`,
    `  *) echo ${shQuote(text.failed)}; echo "$out"; read -r -p ${shQuote(`${text.enter} `)} _ ;;`,
    'esac',
    '',
  ].join('\n');
}

// Keeps the generated files out of git without touching the project's own .gitignore.
function excludeFromGit(root, relativePaths) {
  const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const excludeFile = run(['rev-parse', '--git-path', 'info/exclude']);
  const prefix = run(['rev-parse', '--show-prefix']);
  if (excludeFile.status !== 0 || prefix.status !== 0) return;
  const file = path.resolve(root, excludeFile.stdout.trim());
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = new Set(existing.split('\n'));
  const missing = relativePaths.map((p) => `/${prefix.stdout.trim()}${p}`).filter((line) => !lines.has(line));
  if (!missing.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

// ---------- site ----------

// Deletes every file under `dir` that `keep(relative path)` rejects, then the emptied folders.
function removeUnlisted(dir, keep, prefix = '') {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) removeUnlisted(full, keep, `${relative}/`);
    else if (!keep(relative)) fs.rmSync(full);
  }
  if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
}

// Replaced by rename, never rewritten in place: the launcher runs the server, which exports again
// while the shell is still reading the launcher.
function writeIfChanged(file, content, mode) {
  if (fs.existsSync(file) && Buffer.from(content).equals(fs.readFileSync(file))) {
    if (mode) fs.chmodSync(file, mode);
    return;
  }
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, content, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(temp, mode);
  fs.renameSync(temp, file);
}

function readOptionalJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Writes the standalone pages of every lesson that loads and renders, removes pages this export
// wrote earlier for lessons that are gone, and refreshes the launcher.
// -> { dir, pages: [file names], skipped: [lesson ids], launcher } or null without config/course.
export function exportSite(root) {
  const config = readOptionalJson(path.join(root, CONFIG_FILE));
  const course = readOptionalJson(path.join(root, COURSE_FILE));
  if (!config || !Array.isArray(course?.modules)) return null;
  const files = new Map();
  const target = fileTarget({ root, config, files });
  const dir = path.join(root, EXPORT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const pages = new Map([['index.html', renderIndexPage({ config, course, target })]]);
  const skipped = [];
  for (const entry of course.modules.flatMap((module) => module.lessons ?? [])) {
    if (entry.status === 'planned') continue;
    const lesson = readOptionalJson(lessonFile(root, entry.id));
    try {
      if (!lesson) throw new Error('missing');
      pages.set(target.lessonHref(entry.id), renderLessonPage({ root, config, course, lesson, target }));
    } catch {
      skipped.push(entry.id);
    }
  }
  for (const [name, html] of pages) writeIfChanged(path.join(dir, name), html);
  for (const [name, source] of files) writeIfChanged(path.join(dir, name), fs.readFileSync(source));
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.html') || pages.has(name)) continue;
    const file = path.join(dir, name);
    if (fs.readFileSync(file, 'utf8').includes(GENERATOR)) fs.rmSync(file);
  }
  removeUnlisted(path.join(dir, ASSETS), (relative) => files.has(`${ASSETS}/${relative}`));
  const launcher = launcherName(config.language);
  writeIfChanged(path.join(root, launcher), launcherScript(process.platform, config.language), process.platform === 'win32' ? undefined : 0o755);
  excludeFromGit(root, [`${EXPORT_DIR}/`, launcher]);
  return { dir, pages: [...pages.keys()], skipped, launcher };
}
