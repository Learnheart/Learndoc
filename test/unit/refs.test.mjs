import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { anchorSlug, chunkMarkdown, ensureChunks, indexFile, loadChunkIndexes, pagesFile, refsDir, slugify, sourceExcerpt } from '../../lib/refs.mjs';
import { codes, copyFixture, fixtureJson } from './helpers.mjs';

// Hand-built 2-page PDF: page 1 has text, page 2 has none.
const PDF = fileURLToPath(new URL('../fixtures/refs/two-pages.pdf', import.meta.url));

test('slugify strips diacritics (incl. đ), lowercases and collapses separators', () => {
  assert.equal(slugify('Đường thẳng & mặt phẳng'), 'duong-thang-mat-phang');
  assert.equal(slugify('  What is an Agent?! '), 'what-is-an-agent');
  assert.equal(slugify('Ünïcödé — 2.0'), 'unicode-2-0');
  assert.equal(slugify('中文'), '');
});

test('anchorSlug never yields an anchor that reads as a page reference', () => {
  assert.equal(anchorSlug('P1'), 'p1-section');
  assert.equal(anchorSlug('p12-34'), 'p12-34-section');
  assert.equal(anchorSlug('P1 intro'), 'p1-intro');
  assert.equal(anchorSlug('Part 1'), 'part-1');
  assert.deepEqual(chunkMarkdown('# P1\n\ntext\n## p2-3\n').map((chunk) => chunk.anchor), ['p1-section', 'p2-3-section']);
  assert.deepEqual(chunkMarkdown('# P1\n# P1 Section\n').map((chunk) => chunk.anchor), ['p1-section-2', 'p1-section'],
    'ordinary headings keep the anchors they had in chunk index v1; page-like ones take the next free name');
});

test('chunkMarkdown: sections nest, fences are skipped, duplicates get suffixes, preamble kept', () => {
  const chunks = chunkMarkdown('Intro\n\n# A\ntext\n## B\n```\n# not heading\n```\n## B\nmore\n# [Link](x) `code`\nend\n# 中文\n');
  assert.deepEqual(chunks.map(({ anchor, level }) => [anchor, level]), [['preamble', 0], ['a', 1], ['b', 2], ['b-2', 2], ['link-code', 1], ['section-5', 1]]);
  assert.match(chunks[1].content, /^# A\ntext\n## B[\s\S]*more\n$/, 'a section includes its subsections');
  assert.equal(chunks[2].content, '## B\n```\n# not heading\n```\n');
});

test('chunkMarkdown line ranges are 1-based, inclusive and skip surrounding blank lines', () => {
  const text = '\nIntro\n\n# A\ntext\n\n## B\nb\n\n\n# C\n';
  const chunks = chunkMarkdown(text);
  assert.deepEqual(chunks.map(({ anchor, lines }) => [anchor, lines]), [['preamble', [2, 2]], ['a', [4, 8]], ['b', [7, 8]], ['c', [11, 11]]]);
  const lines = text.split('\n');
  for (const chunk of chunks) {
    assert.equal(`${lines.slice(chunk.lines[0] - 1, chunk.lines[1]).join('\n')}\n`, chunk.content, chunk.anchor);
  }
});

test('ensureChunks writes only an index (no copies of the text) and regenerates it when the source changes', async (t) => {
  const root = copyFixture(t);
  const config = fixtureJson('learndoc.json');
  const first = await ensureChunks(root, config);
  assert.deepEqual(first.diagnostics, []);
  assert.deepEqual(fs.readdirSync(refsDir(root)), ['notes.json']);
  const { anchors } = first.indexes.notes;
  assert.deepEqual(anchors.map((a) => a.anchor), ['preamble', 'vectors', 'inner-product', 'norms', 'duong-thang-mat-phang']);
  const notes = fs.readFileSync(path.join(root, 'references', 'notes.md'), 'utf8').split('\n');
  const vectors = anchors.find((a) => a.anchor === 'vectors');
  assert.match(notes[vectors.lines[0] - 1], /^# /, 'a range starts at its heading in the reference file');
  assert.deepEqual(loadChunkIndexes(root, config), first.indexes);

  const marker = { ...first.indexes.notes, marker: true };
  fs.writeFileSync(indexFile(root, 'notes'), JSON.stringify(marker));
  await ensureChunks(root, config);
  assert.equal(JSON.parse(fs.readFileSync(indexFile(root, 'notes'), 'utf8')).marker, true, 'unchanged source is not re-indexed');

  fs.appendFileSync(path.join(root, 'references', 'notes.md'), '\n# Added\n');
  const second = await ensureChunks(root, config);
  assert.equal(JSON.parse(fs.readFileSync(indexFile(root, 'notes'), 'utf8')).marker, undefined, 'changed source replaces the index');
  assert.ok(second.indexes.notes.anchors.some((a) => a.anchor === 'added'));
});

test('ensureChunks removes the per-section chunk folders of earlier versions, nothing else', async (t) => {
  const root = copyFixture(t);
  const legacy = path.join(root, 'references', 'chunks', 'notes');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'index.json'), '{}');
  fs.writeFileSync(path.join(legacy, 'vectors.md'), '# Vectors\n');
  const foreign = path.join(root, 'references', 'chunks', 'mine');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'keep.md'), 'x');
  await ensureChunks(root, fixtureJson('learndoc.json'));
  assert.ok(!fs.existsSync(legacy));
  assert.ok(fs.existsSync(path.join(foreign, 'keep.md')), 'a folder without an index.json is not learndoc\'s');
});

test('sourceExcerpt reads a section from the reference file itself', async (t) => {
  const root = copyFixture(t);
  const config = fixtureJson('learndoc.json');
  await ensureChunks(root, config);
  const text = sourceExcerpt(root, config, { alias: 'notes', anchor: 'vectors' });
  assert.match(text, /^# Vectors/);
  assert.equal(text, chunkMarkdown(fs.readFileSync(path.join(root, 'references', 'notes.md'), 'utf8')).find((c) => c.anchor === 'vectors').content);
  assert.equal(sourceExcerpt(root, config, { alias: 'notes', anchor: 'nope' }), null);
  assert.equal(sourceExcerpt(root, config, { alias: 'ghost', anchor: 'vectors' }), null);
});

test('missing reference files and unreadable PDFs become warnings', async (t) => {
  const root = copyFixture(t);
  fs.writeFileSync(path.join(root, 'references', 'bad.pdf'), 'not a pdf');
  const { indexes, diagnostics } = await ensureChunks(root, {
    references: { gone: { type: 'markdown', file: 'references/gone.md' }, bad: { type: 'pdf', file: 'references/bad.pdf' } },
  });
  assert.deepEqual(codes(diagnostics), ['refs/missing-file', 'refs/extract-failed']);
  assert.ok(diagnostics.every((entry) => entry.severity === 'warning'));
  assert.deepEqual(indexes, {});
});

test('pdf chunking by page with the vendored pdf.js', async (t) => {
  const root = copyFixture(t);
  fs.copyFileSync(PDF, path.join(root, 'references', 'book.pdf'));
  const { indexes, diagnostics } = await ensureChunks(root, { references: { book: { type: 'pdf', file: 'references/book.pdf' } } });
  assert.deepEqual(diagnostics, []);
  assert.equal(indexes.book.pages, 2);
  assert.deepEqual(indexes.book.pagesWithoutText, [2]);
  assert.deepEqual(fs.readdirSync(refsDir(root)).sort(), ['book.json', 'book.pages.txt']);
  assert.equal(fs.readFileSync(pagesFile(root, 'book'), 'utf8'), '=== page 1 ===\nPage one text\n=== page 2 ===\n');
  assert.equal(indexes.book.pagesFile, '.learndoc/refs/book.pages.txt');
  assert.deepEqual(indexes.book.pageLines, [[2, 2], [4, 3]], 'page 2 has no text: an empty range');
  const config = { references: { book: { type: 'pdf', file: 'references/book.pdf' } } };
  assert.equal(sourceExcerpt(root, config, { alias: 'book', page: 1, pageEnd: 1 }), 'Page one text\n');
  assert.equal(sourceExcerpt(root, config, { alias: 'book', page: 1, pageEnd: 2 }), 'Page one text\n');
  assert.equal(sourceExcerpt(root, config, { alias: 'book', page: 2, pageEnd: 2 }), null);
});
