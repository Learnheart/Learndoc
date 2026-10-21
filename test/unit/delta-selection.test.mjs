import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelection, markFocus } from '../../delta/selection.mjs';
import { textViewFromSource, OBJ } from '../../shared/textview.mjs';
import { segmentField } from '../../shared/render.mjs';

const lessonOf = (...blocks) => ({ schemaVersion: 1, id: 'l', title: 'L', blocks });
const prose = (id, html) => ({ id, type: 'prose', html, sources: ['notes#a'] });
const quoteRange = (blockId, exact, extra = {}) => ({ blockId, field: 'html', quote: { exact, prefix: '', suffix: '', ...extra.quote }, mathIdx: extra.mathIdx });
const resolveOne = (html, range) => {
  const lesson = lessonOf(prose('b-aaaa', html));
  const out = resolveSelection(lesson, { focusBlockIds: ['b-aaaa'], ranges: [range] });
  return { ...out, range: out.ranges[0], slice: out.ranges[0].whole ? null : html.slice(out.ranges[0].start, out.ranges[0].end) };
};

test('exact quote maps across inline tags', () => {
  const html = '<p>Git keeps the <strong>history</strong> of a project.</p>';
  const { range, slice, warnings } = resolveOne(html, quoteRange('b-aaaa', 'the history of'));
  assert.deepEqual(warnings, []);
  assert.equal(slice, 'the <strong>history</strong> of');
  assert.equal(range.exact, 'the history of');
  assert.equal(range.field, 'html');
});

test('duplicate quote is disambiguated by prefix and suffix', () => {
  const html = '<p>the cat sat. Then the cat ran.</p>';
  const second = resolveOne(html, quoteRange('b-aaaa', 'the cat', { quote: { suffix: ' ran.' } }));
  assert.equal(second.range.start, html.lastIndexOf('the cat'));
  const first = resolveOne(html, quoteRange('b-aaaa', 'the cat', { quote: { prefix: '', suffix: ' sat' } }));
  assert.equal(first.range.start, html.indexOf('the cat'));
  const byPrefix = resolveOne(html, quoteRange('b-aaaa', 'the cat', { quote: { prefix: 'sat. Then ' } }));
  assert.equal(byPrefix.range.start, html.lastIndexOf('the cat'));
});

test('whitespace/punctuation-normalized fallback', () => {
  const html = '<p>Branches are <em>cheap</em>, fast — and local.</p>';
  const { slice, warnings } = resolveOne(html, quoteRange('b-aaaa', 'cheap fast and'));
  assert.deepEqual(warnings, []);
  assert.equal(slice, 'cheap</em>, fast — and');
});

test('math placeholder picks the formula by mathIdx and returns its latex', () => {
  const html = '<p>Let $x$ and $y$ and $x$.</p>';
  const third = resolveOne(html, quoteRange('b-aaaa', OBJ, { mathIdx: [2] }));
  assert.equal(third.range.start, html.lastIndexOf('$x$'));
  assert.equal(third.slice, '$x$');
  assert.deepEqual(third.range.math, ['x']);
  const second = resolveOne(html, quoteRange('b-aaaa', `${OBJ} and`, { mathIdx: [1] }));
  assert.equal(second.slice, '$y$ and');
  assert.deepEqual(second.range.math, ['y']);
});

test('cross-block selection: quoted start, whole middle block, other field', () => {
  const lesson = lessonOf(
    prose('b-aaaa', '<p>First block text.</p>'),
    prose('b-bbbb', '<p>Middle.</p>'),
    { id: 'b-cccc', type: 'box', variant: 'note', title: 'A title here', html: '<p>Box.</p>', sources: ['notes#a'] },
  );
  const out = resolveSelection(lesson, {
    focusBlockIds: ['b-aaaa', 'b-bbbb', 'b-cccc'],
    ranges: [quoteRange('b-aaaa', 'block text.'), { blockId: 'b-bbbb', whole: true },
      { blockId: 'b-cccc', field: 'title', quote: { exact: 'A title' } }],
  });
  assert.deepEqual(out.focusBlockIds, ['b-aaaa', 'b-bbbb', 'b-cccc']);
  assert.deepEqual(out.ranges.map((r) => [r.blockId, r.whole ?? false, r.field ?? null]), [
    ['b-aaaa', false, 'html'], ['b-bbbb', true, null], ['b-cccc', false, 'title'],
  ]);
  assert.deepEqual([out.ranges[2].start, out.ranges[2].end], [0, 7]);
  assert.deepEqual(out.warnings, []);
});

test('unresolved quote falls back to the whole block with a warning; unknown blocks are dropped', () => {
  const lesson = lessonOf(prose('b-aaaa', '<p>Some text.</p>'));
  const out = resolveSelection(lesson, { focusBlockIds: ['b-aaaa', 'b-gone'], ranges: [quoteRange('b-aaaa', 'not in the block')] });
  assert.deepEqual(out.ranges, [{ blockId: 'b-aaaa', whole: true }]);
  assert.deepEqual(out.focusBlockIds, ['b-aaaa']);
  assert.deepEqual(out.warnings, [
    { code: 'selection_unresolved', blockId: 'b-aaaa', field: 'html' },
    { code: 'selection_unresolved', blockId: 'b-gone', field: null },
  ]);
});

test('a range ending on a block-boundary space or entity ends after the whole unit', () => {
  assert.equal(resolveOne('<ul><li>one</li><li>two</li></ul>', quoteRange('b-aaaa', 'one ')).slice, 'one</li>');
  assert.equal(resolveOne('<p>Tom &amp; Jerry</p>', quoteRange('b-aaaa', 'Tom &')).slice, 'Tom &amp;');
});

test('property: no resolved range cuts a tag, an entity or a formula', () => {
  const html = '<p>A <strong>bold</strong> claim $a&lt;b$ &amp; <code>$x</code> then $$\\sum_i x_i$$.</p><ul><li>item \\$5</li></ul>';
  const { text } = textViewFromSource(html, 'html');
  const atoms = segmentField(html, 'html').segments
    .map((s) => (s.type === 'tag' ? s.token : s))
    .filter((s) => s.type !== 'text');
  for (const m of html.matchAll(/&[a-z]+;|\\\$/g)) atoms.push({ start: m.index, end: m.index + m[0].length });
  const cuts = (offset) => atoms.some((a) => offset > a.start && offset < a.end);
  for (let i = 0; i < text.length; i++) {
    for (let j = i + 1; j <= text.length; j++) {
      const exact = text.slice(i, j);
      if (!exact.trim()) continue;
      const { range } = resolveOne(html, quoteRange('b-aaaa', exact, { quote: { prefix: text.slice(Math.max(0, i - 32), i), suffix: text.slice(j, j + 32) } }));
      assert.ok(!range.whole, `resolves ${JSON.stringify(exact)}`);
      assert.ok(!cuts(range.start) && !cuts(range.end), `no cut for ${JSON.stringify(exact)}: ${range.start}-${range.end}`);
    }
  }
});

test('markFocus wraps the range', () => {
  assert.equal(markFocus('<p>abc</p>', 4, 5), '<p>a⟦focus⟧b⟦/focus⟧c</p>');
});
