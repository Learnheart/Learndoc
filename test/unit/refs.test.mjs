import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chunkMarkdown, chunksDir, ensureChunks, loadChunkIndexes, slugify } from '../../lib/refs.mjs';
import { codes, copyFixture, fixtureJson } from './helpers.mjs';

// Hand-built 2-page PDF: page 1 has text, page 2 has none.
const PDF = fileURLToPath(new URL('../fixtures/refs/two-pages.pdf', import.meta.url));

test('slugify strips diacritics (incl. đ), lowercases and collapses separators', () => {
  assert.equal(slugify('Đường thẳng & mặt phẳng'), 'duong-thang-mat-phang');
  assert.equal(slugify('  What is an Agent?! '), 'what-is-an-agent');
  assert.equal(slugify('Ünïcödé — 2.0'), 'unicode-2-0');
  assert.equal(slugify('中文'), '');
});

test('chunkMarkdown: sections nest, fences are skipped, duplicates get suffixes, preamble kept', () => {
  const chunks = chunkMarkdown('Intro\n\n# A\ntext\n## B\n```\n# not heading\n```\n## B\nmore\n# [Link](x) `code`\nend\n# 中文\n');
  assert.deepEqual(chunks.map(({ anchor, level }) => [anchor, level]), [['preamble', 0], ['a', 1], ['b', 2], ['b-2', 2], ['link-code', 1], ['section-5', 1]]);
  assert.match(chunks[1].content, /^# A\ntext\n## B[\s\S]*more\n$/, 'a section includes its subsections');
  assert.equal(chunks[2].content, '## B\n```\n# not heading\n```\n');
});

test('ensureChunks writes chunk files + index and regenerates only when the source changes', async (t) => {
  const root = copyFixture(t);
  const config = fixtureJson('learndoc.json');
  const first = await ensureChunks(root, config);
  assert.deepEqual(first.diagnostics, []);
  const dir = chunksDir(root, 'notes');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['duong-thang-mat-phang.md', 'index.json', 'inner-product.md', 'norms.md', 'preamble.md', 'vectors.md']);
  assert.deepEqual(first.indexes.notes.anchors.map((a) => a.anchor), ['preamble', 'vectors', 'inner-product', 'norms', 'duong-thang-mat-phang']);
  assert.deepEqual(loadChunkIndexes(root, config), first.indexes);

  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, '');
  await ensureChunks(root, config);
  assert.ok(fs.existsSync(marker), 'unchanged source is not re-chunked');

  fs.appendFileSync(path.join(root, 'references', 'notes.md'), '\n# Added\n');
  const second = await ensureChunks(root, config);
  assert.ok(!fs.existsSync(marker), 'changed source replaces the chunk dir');
  assert.ok(second.indexes.notes.anchors.some((a) => a.anchor === 'added'));
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
  const dir = chunksDir(root, 'book');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['index.json', 'p0001.txt', 'p0002.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'p0001.txt'), 'utf8'), 'Page one text\n');
  assert.equal(fs.readFileSync(path.join(dir, 'p0002.txt'), 'utf8'), '\n');
});
