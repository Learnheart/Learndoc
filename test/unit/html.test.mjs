import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeEntities, escapeAttr, escapeHtml, readEntity, tokenize } from '../../shared/html.mjs';

const kinds = (src) => tokenize(src).map((token) => (token.type === 'text' ? `text:${src.slice(token.start, token.end)}` : `${token.type}:${token.name ?? ''}`));

test('tokenizes tags, attributes and text covering the whole string', () => {
  const src = '<p class="term">a &amp; b<br><br/></p>';
  assert.deepEqual(kinds(src), ['open:p', 'text:a &amp; b', 'open:br', 'open:br', 'close:p']);
  const [open, , br1, br2] = tokenize(src);
  assert.deepEqual(open.attrs.map(({ name, value }) => ({ name, value })), [{ name: 'class', value: 'term' }]);
  assert.equal(br1.selfClosing, false);
  assert.equal(br2.selfClosing, true);
  const tokens = tokenize(src);
  for (let i = 1; i < tokens.length; i++) assert.equal(tokens[i].start, tokens[i - 1].end);
  assert.equal(tokens.at(-1).end, src.length);
});

test('decodes attribute values and accepts single quotes', () => {
  const [a] = tokenize("<a href='lesson:x#y' title=\"A &amp; B\">");
  assert.deepEqual(a.attrs.map((attr) => attr.value), ['lesson:x#y', 'A & B']);
});

test('a stray < becomes an error token and scanning continues', () => {
  assert.deepEqual(kinds('a < b <b>c</b>'), ['text:a ', 'error:', 'text: b ', 'open:b', 'text:c', 'close:b']);
  assert.deepEqual(kinds('$a<b$'), ['text:$a', 'error:', 'text:b$']);
  assert.equal(tokenize('<!-- x -->')[0].message, 'HTML comments are not allowed');
  assert.equal(tokenize('<a href=x>')[0].type, 'error', 'unquoted attribute values are rejected');
});

test('entities: named subset, numeric, unknown and bare ampersands', () => {
  assert.equal(decodeEntities('&lt;&gt;&amp;&quot;&#39;&#x3b1;&nbsp;&mdash;'), '<>&"\'α\u00a0—');
  assert.equal(decodeEntities('A & B &unknown; &#0;'), 'A & B &unknown; &#0;');
  assert.deepEqual(readEntity('&alpha;', 0), { value: null, length: 7 });
  assert.equal(readEntity('& x', 0), null);
});

test('escape helpers', () => {
  assert.equal(escapeHtml('<a & "b">'), '&lt;a &amp; "b"&gt;');
  assert.equal(escapeAttr(`<"'&>`), '&lt;&quot;&#39;&amp;&gt;');
});
