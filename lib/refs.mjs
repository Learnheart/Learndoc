// Reference sections: markdown/web snapshots by heading, PDFs by page. Nothing is copied out of a
// markdown reference; its index records each heading's line range in the reference file itself.
// A PDF's extracted text is cached once, page after page, in one text file.
// Output (git-ignored, regenerated when the source changes):
//   <project>/.learndoc/refs/<alias>.json         index
//   <project>/.learndoc/refs/<alias>.pages.txt    PDF text, each page after a `=== page N ===` line
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { diagnostic } from './diagnostics.mjs';
import { formatJson, relativePath, SKILL_ROOT, STATE_DIR } from './project.mjs';

// 2: anchors never look like page references. 3: index-only, in .learndoc/refs/ (same anchors as 2).
const INDEX_VERSION = 3;
const PDFJS_DIR = path.join(SKILL_ROOT, 'runtime', 'vendor', 'pdfjs');

export const refsDir = (root) => path.join(root, STATE_DIR, 'refs');
export const indexFile = (root, alias) => path.join(refsDir(root), `${alias}.json`);
export const pagesFile = (root, alias) => path.join(refsDir(root), `${alias}.pages.txt`);
const pageHeader = (page) => `=== page ${page} ===`;

// Where versions before index v3 wrote one file per section or page.
const legacyChunksDir = (root) => path.join(root, 'references', 'chunks');

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

const PAGE_REF = /^p\d+(-\d+)?$/;

// A heading anchor: the slug, suffixed when it would read as a PDF page reference ("p1" → "p1-section"),
// because a sourceRef `alias#p1` means page 1.
export function anchorSlug(text) {
  const slug = slugify(text);
  return PAGE_REF.test(slug) ? `${slug}-section` : slug;
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
  // 1-based inclusive range of lines [from, to) without the blank lines around it.
  const range = (from, to) => {
    while (from < to && !lines[from].trim()) from++;
    while (to > from && !lines[to - 1].trim()) to--;
    return [from + 1, to];
  };
  const chunks = [];
  const firstLine = headings.length ? headings[0].line : lines.length;
  const preamble = lines.slice(0, firstLine).join('\n').trim();
  if (preamble) chunks.push({ anchor: unique('preamble'), title: '', level: 0, lines: range(0, firstLine), content: `${preamble}\n` });
  // Ordinary slugs are reserved first and page-like ones suffixed afterwards, so every anchor that was valid
  // before page-like slugs were suffixed (chunk index v1) keeps its name.
  const anchors = headings.map((heading, i) => {
    const slug = slugify(heading.title);
    return PAGE_REF.test(slug) ? null : unique(slug || `section-${i + 1}`);
  });
  headings.forEach((heading, i) => {
    anchors[i] ??= unique(anchorSlug(heading.title));
    const next = headings.slice(i + 1).find((other) => other.level <= heading.level);
    const end = next ? next.line : lines.length;
    const content = lines.slice(heading.line, end).join('\n').trim();
    chunks.push({ anchor: anchors[i], title: heading.title, level: heading.level, lines: range(heading.line, end), content: `${content}\n` });
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
    return JSON.parse(fs.readFileSync(indexFile(root, alias), 'utf8'));
  } catch {
    return null;
  }
}

function isFresh(index, ref, source) {
  return index?.schemaVersion === INDEX_VERSION && index.type === ref.type
    && index.source?.file === source.file && index.source.size === source.size
    && index.source.mtimeMs === source.mtimeMs;
}

// Written to a temp name and renamed, so a reader never sees half a file.
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

async function chunkReference(root, alias, ref, source) {
  const base = { schemaVersion: INDEX_VERSION, alias, type: ref.type, source };
  if (ref.type === 'pdf') {
    const pages = await extractPdfPages(path.join(root, ref.file));
    // Page N's text is on lines pageLines[N-1][0]..[1] of the pages file (empty when [1] < [0]).
    const out = [];
    const pageLines = pages.map((text, i) => {
      out.push(pageHeader(i + 1));
      const textLines = text ? text.split('\n') : [];
      const first = out.length + 1;
      out.push(...textLines);
      return [first, first + textLines.length - 1];
    });
    writeAtomic(pagesFile(root, alias), `${out.join('\n')}\n`);
    const index = {
      ...base,
      pages: pages.length,
      pagesWithoutText: pages.flatMap((text, i) => (text ? [] : [i + 1])),
      pagesFile: relativePath(root, pagesFile(root, alias)),
      pageLines,
    };
    writeAtomic(indexFile(root, alias), formatJson(index));
    return index;
  }
  const chunks = chunkMarkdown(fs.readFileSync(path.join(root, ref.file), 'utf8'));
  const index = {
    ...base,
    anchors: chunks.map(({ anchor, title, level, lines }) => ({ anchor, title, level, lines })),
  };
  fs.rmSync(pagesFile(root, alias), { force: true });
  writeAtomic(indexFile(root, alias), formatJson(index));
  return index;
}

// Removes the per-section chunk folders of index v1/v2 (each holds an index.json learndoc wrote).
function removeLegacyChunks(root) {
  const dir = legacyChunksDir(root);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'index.json'))) {
      fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    }
  }
  if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
}

const MAX_EXCERPT_PAGES = 20;

// The text a parsed sourceRef points at: a markdown section (re-read from the reference file, so it
// follows the file even before the next finalize) or a PDF page range from the cached page text.
// -> string or null
export function sourceExcerpt(root, config, { alias, anchor, page, pageEnd }, { maxPages = MAX_EXCERPT_PAGES } = {}) {
  const ref = config.references?.[alias];
  if (!ref) return null;
  try {
    if (anchor) {
      const chunk = chunkMarkdown(fs.readFileSync(path.join(root, ref.file), 'utf8')).find((entry) => entry.anchor === anchor);
      return chunk ? chunk.content : null;
    }
    const index = readIndex(root, alias);
    if (!index?.pageLines) return null;
    const lines = fs.readFileSync(pagesFile(root, alias), 'utf8').split('\n');
    const last = Math.min(pageEnd, page + maxPages - 1, index.pageLines.length);
    const texts = [];
    for (let n = page; n <= last; n++) {
      const [first, end] = index.pageLines[n - 1];
      texts.push(lines.slice(first - 1, end).join('\n'));
    }
    const text = texts.join('\n').trim();
    return text ? `${text}\n` : null;
  } catch {
    return null;
  }
}

// Indexes every reference whose source changed (size/mtime) since the last run.
// -> { indexes: { alias: index }, diagnostics }; references that cannot be read have no index.
export async function ensureChunks(root, config) {
  removeLegacyChunks(root);
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
        message: `reference "${alias}" could not be read: ${error.message}`,
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
