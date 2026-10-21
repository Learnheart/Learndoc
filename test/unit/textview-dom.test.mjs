// Parity of textViewFromDom / domPointToIndex with textViewFromSource in a real browser (skipped without Chrome).
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ChromeBrowser, findChrome } from '../../lib/chrome.mjs';
import { createStaticHandler } from '../../lib/static-server.mjs';
import { renderBlock, resolveBoxTypes } from '../../shared/render.mjs';
import { textViewFromSource } from '../../shared/textview.mjs';
import { FIXTURE, fixtureJson } from './helpers.mjs';

const chrome = findChrome();

const blocks = [
  ...fixtureJson('lessons/intro.json').blocks,
  { id: 'b-9001', type: 'prose', html: '<p>  Spaces &nbsp; and\n<strong>bold</strong>&mdash;\\$3 $a$$$b$$</p><blockquote>q</blockquote><pre>x  $y</pre>', sources: ['notes#norms'] },
  { id: 'b-9002', type: 'quiz', question: 'Why $x$?', answer: '<ol><li>one</li><li>two <code>$</code></li></ol>', sources: ['notes#norms'] },
];
const ctx = { boxTypes: resolveBoxTypes({ language: 'en' }), linkBase: '/lessons/', language: 'en' };
const KIND = { text: 'plain', title: 'plain', caption: 'plain', question: 'plain', html: 'html', answer: 'html', code: 'raw' };

test('DOM text view equals the source text view for every rendered field', { skip: !chrome && 'Chrome not found' }, async (t) => {
  const page = `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">
<script src="/static/runtime/vendor/katex/katex.min.js"></script>
<body>${blocks.map((block) => renderBlock(block, ctx)).join('')}
<script type="module">
import { textViewFromDom, domPointToIndex } from '/static/shared/textview.mjs';
for (const span of document.querySelectorAll('span.math')) katex.render(span.dataset.latex, span, { throwOnError: false, displayMode: span.dataset.display === '1' });
window.views = [...document.querySelectorAll('[data-field]')].map((el) => {
  const { text, points } = textViewFromDom(el);
  const roundTrip = points.slice(0, -1).every((p, i) => domPointToIndex(el, p.node, p.offset) === i);
  const firstText = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
  return { blockId: el.closest('section').dataset.blockId, field: el.dataset.field, text, roundTrip,
    insideMath: el.querySelector('.katex') ? domPointToIndex(el, el.querySelector('.katex').firstChild, 0) : null,
    end: domPointToIndex(el, el, el.childNodes.length), firstText: firstText ? domPointToIndex(el, firstText, 0) : null };
});
</script>`;
  const serveStatic = createStaticHandler({ projectRoot: FIXTURE });
  const server = http.createServer((req, res) => {
    if (!serveStatic(req, res)) res.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const browser = new ChromeBrowser(chrome);
  t.after(() => browser.close());
  await browser.navigate(`http://127.0.0.1:${server.address().port}/`);
  const views = await browser.evaluate(`new Promise((resolve) => { const poll = () => window.views ? resolve(window.views) : setTimeout(poll, 20); poll(); })`, { awaitPromise: true });
  assert.ok(views.length > 10);
  for (const view of views) {
    const block = blocks.find((entry) => entry.id === view.blockId);
    if (view.field === 'latex') {
      assert.equal(view.text, '\ufffc', 'math block field is one OBJ');
      continue;
    }
    const source = textViewFromSource(block[view.field], KIND[view.field]);
    assert.equal(view.text, source.text, `${view.blockId}.${view.field}`);
    assert.ok(view.roundTrip, `${view.blockId}.${view.field}: points map back to their own index`);
    assert.equal(view.end, view.text.length);
    if (view.firstText !== null) assert.ok(view.firstText <= 1);
    if (view.insideMath !== null) assert.equal(view.text[view.insideMath], '\ufffc', 'a point inside KaTeX output maps to its OBJ');
  }
  assert.deepEqual(browser.problems, []);
});
