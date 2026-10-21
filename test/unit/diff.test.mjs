import assert from 'node:assert/strict';
import test from 'node:test';
import { diffField } from '../../shared/diff.mjs';

test('identical fields render without markers', () => {
  const src = '<p>One. Two $x$.</p>';
  const out = diffField(src, src, 'html');
  assert.doesNotMatch(out, /ld-(del|ins)/);
  assert.match(out, /<span class="math" data-math="0"/);
});

test('changed sentence is deleted and inserted; others stay', () => {
  const out = diffField('<p>One. Two $a.b$ here. Three!</p>', '<p>One. Two $a.c$ here. Three! Four.</p>', 'html');
  assert.equal(out, '<p>One. <del class="ld-del">Two <span class="math" data-math="0" data-display="0" data-latex="a.b">a.b</span> here. </del>'
    + '<ins class="ld-ins">Two <span class="math" data-math="1" data-display="0" data-latex="a.c">a.c</span> here. </ins>Three! <ins class="ld-ins">Four.</ins></p>');
});

test('sentences never split inside math, and colon splits', () => {
  const out = diffField('Note: $a. b$ end.', 'Note: $a. b$ fin.', 'plain');
  assert.equal(out, 'Note: <del class="ld-del"><span class="math" data-math="0" data-display="0" data-latex="a. b">a. b</span> end.</del>'
    + '<ins class="ld-ins"><span class="math" data-math="1" data-display="0" data-latex="a. b">a. b</span> fin.</ins>');
});

test('tags are never wrapped: removed tags drop, added tags follow the new structure', () => {
  const out = diffField('<ul><li>A</li></ul>', '<p>B</p>', 'html');
  assert.equal(out, '<del class="ld-del">A</del><p><ins class="ld-ins">B</ins></p>');
  assert.doesNotMatch(out, /<(del|ins)[^>]*><\/?(p|ul|li)/);
});

test('raw fields diff by line and are escaped', () => {
  assert.equal(diffField('a = 1\nb < 2\n', 'a = 1\nb < 3\n', 'raw'),
    'a = 1\n<del class="ld-del">b &lt; 2\n</del><ins class="ld-ins">b &lt; 3\n</ins>');
});
