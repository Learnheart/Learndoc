import assert from 'node:assert/strict';
import test from 'node:test';
import { prereqIds } from '../../lib/import.mjs';

const lesson = (n) => ({ id: `${String(n).padStart(2, '0')}-lesson-${n}`, record: null });
const entries = Array.from({ length: 18 }, (_, i) => lesson(i + 1));
const ids = (...numbers) => numbers.map((n) => lesson(n).id);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('default ref: every number in the chip, in order of mention', () => {
  assert.deepEqual(prereqIds('Bài 01, 02', undefined, entries), ids(1, 2));
  assert.deepEqual(prereqIds('Bài 04 (Projection), 05 (Eigen), 06 (SVD), 07 (Low-rank)', undefined, entries), ids(4, 5, 6, 7));
});

test('ranges with an en dash, em dash or hyphen expand to every existing lesson; duplicates are dropped', () => {
  assert.deepEqual(prereqIds('Bài 09, 11, 12, 13 (khuyến nghị 01–16)', undefined, entries), ids(9, 11, 12, 13, ...range(1, 8), 10, 14, 15, 16));
  assert.deepEqual(prereqIds('Bài 01—03 and 05-06', undefined, entries), ids(1, 2, 3, 5, 6));
  assert.deepEqual(prereqIds('Bài 01–17', undefined, entries), ids(...range(1, 17)));
});

test('unknown numbers and ranges without lessons are ignored', () => {
  assert.deepEqual(prereqIds('Bài 99, 20–25 and 03', undefined, entries), ids(3));
  assert.deepEqual(prereqIds('đại số phổ thông, ký hiệu tổng $\\sum$', undefined, entries), []);
});

test('a keyword ref with list continuation: the math_learning chips', () => {
  const ref = 'Bài (\\d+)';
  const cases = [
    ['Bài 01, 02', ids(1, 2)],
    ['Bài 01–03 (span, kernel, inner product)', ids(1, 2, 3)],
    ['Bài 04 (Projection), 05 (Eigen), 06 (SVD), 07 (Low-rank)', ids(4, 5, 6, 7)],
    ['Bài 03 (Mahalanobis), Bài 09–11', ids(3, 9, 10, 11)],
    ['Bài 05 (eigenvalue), Bài 14 (gradient); Bài 07 (LoRA) cho Mục 10–12', ids(5, 14, 7)],
    ['Bài 09, 11, 12, 13 (khuyến nghị 01–16)', ids(9, 11, 12, 13)],
    ['Bài 01–17', ids(...range(1, 17))],
  ];
  for (const [chip, expected] of cases) assert.deepEqual(prereqIds(chip, ref, entries), expected, chip);
});

test('continuation: separators , ; / & và and, an optional parenthetical, ranges; anything else stops it', () => {
  const ref = 'Lesson (\\d+)';
  assert.deepEqual(prereqIds('Lesson 01; 02 / 03 & 04 và 05 and 06–07', ref, entries), ids(1, 2, 3, 4, 5, 6, 7));
  assert.deepEqual(prereqIds('Lesson 02 (rank), 06 (SVD) then 09', ref, entries), ids(2, 6), '"then" stops the list');
  assert.deepEqual(prereqIds('Lesson 02, Lesson 03, see 04', ref, entries), ids(2, 3));
});

test('chip text and ref are compared in NFC', () => {
  const decomposed = 'Bài 03, 04'.normalize('NFD');
  assert.notEqual(decomposed, 'Bài 03, 04');
  assert.deepEqual(prereqIds(decomposed, 'Bài (\\d+)', entries), ids(3, 4));
  assert.deepEqual(prereqIds('Bài 03, 04', 'Bài (\\d+)'.normalize('NFD'), entries), ids(3, 4));
});

test('ranges accept every dash form', () => {
  for (const dash of ['-', '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2212']) {
    assert.deepEqual(prereqIds(`Bài 02${dash}04`, 'Bài (\\d+)', entries), ids(2, 3, 4), `U+${dash.codePointAt(0).toString(16)}`);
  }
});

test('a "range" ending past the last lesson is just its first number', () => {
  assert.deepEqual(prereqIds('Bài 05 – 2023 edition', 'Bài (\\d+)', entries), ids(5));
  assert.deepEqual(prereqIds('Bài 05 – 2023 edition', undefined, entries), ids(5));
  assert.deepEqual(prereqIds('Bài 05–18', 'Bài (\\d+)', entries), ids(...range(5, 18)), '18 is the last lesson');
});

test('continuation: a parenthetical may be followed by spaces before the separator', () => {
  assert.deepEqual(prereqIds('Bài 02 (rank) , 06 ,07', 'Bài (\\d+)', entries), ids(2, 6, 7));
  assert.deepEqual(prereqIds('Bài 02 (rank) 06', 'Bài (\\d+)', entries), ids(2), 'no separator: the list ends');
});

test('globals keys name lessons before ids, numerically', () => {
  const keyed = [{ id: 'intro', record: { key: '1' } }, { id: 'vectors', record: { key: '2' } }, { id: 'norms', record: { key: '3' } }];
  assert.deepEqual(prereqIds('Lesson 01–02, 3', undefined, keyed), ['intro', 'vectors', 'norms']);
});
