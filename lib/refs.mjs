// Reference chunking: markdown/web snapshots by heading, PDFs by page.
// Output: <project>/references/chunks/<alias>/{<anchor>.md | p0001.txt…} + index.json.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { diagnostic } from './diagnostics.mjs';
import { formatJson, SKILL_ROOT } from './project.mjs';

const INDEX_VERSION = 1;
const PDFJS_DIR = path.join(SKILL_ROOT, 'runtime', 'vendor', 'pdfjs');

export const chunksDir = (root, alias) => path.join(root, 'references', 'chunks', alias);
export const pageFileName = (page) => `p${String(page).padStart(4, '0')}.txt`;

// NFD-strip diacritics (plus Vietnamese đ), lowercase, non-alphanumerics → '-', collapse, trim.
export function slugify(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function headingTitle(raw) {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
}

// -> [{ anchor, title, level, content }] — each heading's section runs until the next heading of the
// same or a higher level; text before the first heading becomes the `preamble` chunk.
export function chunkMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const headings = [];
  let fence = null;
  lines.forEach((line, index) => {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const match = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (match) headings.push({ level: match[1].length, title: headingTitle(match[2]), line: index });
  });

  const used = new Map();
  const unique = (base) => {
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    return count ? `${base}-${count + 1}` : base;
  };
  const chunks = [];
  const firstLine = headings.length ? headings[0].line : lines.length;
  const preamble = lines.slice(0, firstLine).join('\n').trim();
  if (preamble) chunks.push({ anchor: unique('preamble'), title: '', level: 0, content: `${preamble}\n` });
  headings.forEach((heading, i) => {
    const next = headings.slice(i + 1).find((other) => other.level <= heading.level);
    const content = lines.slice(heading.line, next ? next.line : lines.length).join('\n').trim();
    const anchor = unique(slugify(heading.title) || `section-${i + 1}`);
    chunks.push({ anchor, title: heading.title, level: heading.level, content: `${content}\n` });
  });
  return chunks;
}

let pdfjsPromise = null;

// pdf.js needs DOMMatrix/Path2D only for rendering (never used here) but constructs one at import time,
// and warns on the console when its optional canvas package is missing; stub and mute during import.
function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    const stubs = ['DOMMatrix', 'Path2D'].filter((name) => !(name in globalThis));
    for (const name of stubs) globalThis[name] = class {};
    const { warn } = console;
    console.warn = () => {};
    try {
      const pdfjs = await import(pathToFileURL(path.join(PDFJS_DIR, 'pdf.mjs')).href);
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(PDFJS_DIR, 'pdf.worker.mjs')).href;
      return pdfjs;
    } finally {
      console.warn = warn;
      for (const name of stubs) delete globalThis[name];
    }
  })();
  return pdfjsPromise;
}

// -> [text of page 1, text of page 2, …]
async function extractPdfPages(file) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    isEvalSupported: false,
    useSystemFonts: false,
  });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join('').trim());
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

function sourceSignature(root, ref) {
  const stat = fs.statSync(path.join(root, ref.file));
  return { file: ref.file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

function readIndex(root, alias) {
  try {
    return JSON.parse(fs.readFileSync(path.join(chunksDir(root, alias), 'index.json'), 'utf8'));
  } catch {
    return null;
  }
}

function isFresh(index, ref, source) {
  return index?.schemaVersion === INDEX_VERSION && index.type === ref.type
    && index.source?.file === source.file && index.source.size === source.size
    && index.source.mtimeMs === source.mtimeMs;
}

// Writes all chunk files plus index.json into a staging dir, then swaps it into place.
function writeChunks(root, alias, files, index) {
  const target = chunksDir(root, alias);
  const staging = `${target}.${process.pid}.tmp`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const [name, content] of files) fs.writeFileSync(path.join(staging, name), content);
  fs.writeFileSync(path.join(staging, 'index.json'), formatJson(index));
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
}

async function chunkReference(root, alias, ref, source) {
  const base = { schemaVersion: INDEX_VERSION, alias, type: ref.type, source };
  if (ref.type === 'pdf') {
    const pages = await extractPdfPages(path.join(root, ref.file));
    const index = {
      ...base,
      pages: pages.length,
      pagesWithoutText: pages.flatMap((text, i) => (text ? [] : [i + 1])),
    };
    writeChunks(root, alias, pages.map((text, i) => [pageFileName(i + 1), `${text}\n`]), index);
    return index;
  }
  const chunks = chunkMarkdown(fs.readFileSync(path.join(root, ref.file), 'utf8'));
  const index = {
    ...base,
    anchors: chunks.map(({ anchor, title, level }) => ({ anchor, title, level })),
  };
  writeChunks(root, alias, chunks.map((chunk) => [`${chunk.anchor}.md`, chunk.content]), index);
  return index;
}

// Chunks every reference whose source changed (size/mtime) since the last run.
// -> { indexes: { alias: index }, diagnostics }; references that cannot be chunked have no index.
export async function ensureChunks(root, config) {
  const indexes = {};
  const diagnostics = [];
  for (const [alias, ref] of Object.entries(config.references || {})) {
    const subject = { reference: alias, file: ref.file };
    let source;
    try {
      source = sourceSignature(root, ref);
    } catch {
      diagnostics.push(diagnostic({
        code: 'refs/missing-file',
        severity: 'warning',
        message: `reference "${alias}" points to ${ref.file}, which does not exist; its sources cannot be verified`,
        subject,
        supportedFixes: [`place the reference file at ${ref.file}`, 'fix the "file" path in learndoc.json'],
      }));
      continue;
    }
    const existing = readIndex(root, alias);
    if (isFresh(existing, ref, source)) {
      indexes[alias] = existing;
      continue;
    }
    try {
      indexes[alias] = await chunkReference(root, alias, ref, source);
    } catch (error) {
      diagnostics.push(diagnostic({
        code: 'refs/extract-failed',
        severity: 'warning',
        message: `reference "${alias}" could not be chunked: ${error.message}`,
        subject,
        supportedFixes: ref.type === 'pdf'
          ? ['make sure the PDF is not encrypted or corrupt', 'convert the reference to markdown']
          : ['make sure the file is UTF-8 text'],
      }));
    }
  }
  return { indexes, diagnostics };
}

// Existing chunk indexes, without regenerating anything. -> { alias: index }
export function loadChunkIndexes(root, config) {
  const indexes = {};
  for (const alias of Object.keys(config.references || {})) {
    const index = readIndex(root, alias);
    if (index) indexes[alias] = index;
  }
  return indexes;
}
