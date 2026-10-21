import assert from 'node:assert/strict';
import test from 'node:test';
import { OBJ, textViewFromSource } from '../../shared/textview.mjs';

const at = (src, view) => [...view.map].slice(0, -1).map((offset) => src[offset]).join('');

test('html: tags vanish, block boundaries become one space, entities decode', () => {
  const src = '<p>Hello  &amp; <b>world</b>.</p>\n<ul><li>a</li><li>b&nbsp;c</li></ul>';
  const view = textViewFromSource(src, 'html');
  assert.equal(view.text, 'Hello & world. a b c');
  assert.equal(at(src, view), 'Hello & world.<a<b&c', 'each char maps to where it starts in the source');
  assert.equal(view.map.length, view.text.length + 1);
  assert.equal(view.map[view.text.length], src.length);
});

test('math becomes one OBJ mapped to its opening delimiter', () => {
  const src = '<p>a $x^2$ b $$\\sum$$ c</p>';
  const view = textViewFromSource(src, 'html');
  assert.equal(view.text, `a ${OBJ} b ${OBJ} c`);
  assert.equal(src.slice(view.map[2], view.map[2] + 5), '$x^2$');
  assert.equal(src.slice(view.map[6], view.map[6] + 2), '$$');
});

test('\\$ is a literal dollar mapped to its backslash; code is verbatim', () => {
  const src = '<p>\\$5 <code>$x</code></p>';
  const view = textViewFromSource(src, 'html');
  assert.equal(view.text, '$5 $x');
  assert.equal(src[view.map[0]], '\\');
});

test('inline elements are not boundaries; br is', () => {
  assert.equal(textViewFromSource('<p>ab<em>cd</em>ef</p>', 'html').text, 'abcdef');
  assert.equal(textViewFromSource('<p>ab<br>cd</p>', 'html').text, 'ab cd');
  assert.equal(textViewFromSource('<table><tr><td>1</td><td>2</td></tr></table>', 'html').text, '1 2');
});

test('whitespace runs collapse to their first character; ends are trimmed', () => {
  const src = '  a \n\t b  ';
  const view = textViewFromSource(src, 'plain');
  assert.equal(view.text, 'a b');
  assert.deepEqual([...view.map], [2, 3, 7, 10]);
});

test('plain: no entity decoding, math still OBJ', () => {
  assert.equal(textViewFromSource('A &amp; $x$', 'plain').text, `A &amp; ${OBJ}`);
});

test('raw: only whitespace normalization', () => {
  const view = textViewFromSource('def f():\n    return $x &amp;\n', 'raw');
  assert.equal(view.text, 'def f(): return $x &amp;');
});

test('astral numeric entities expand per UTF-16 unit, like DOM text', () => {
  const view = textViewFromSource('<p>&#x1F600;!</p>', 'html');
  assert.equal(view.text, '\u{1F600}!');
  assert.equal(view.text.length, 3);
  assert.deepEqual([...view.map].slice(0, 3), [3, 3, 12]);
});
