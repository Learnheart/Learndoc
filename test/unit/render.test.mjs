import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_BOX_TYPES, renderBlock, renderLessonBody, resolveBoxTypes, segmentField, wrapMath,
} from '../../shared/render.mjs';

const span = (n, display, latexAttr, latexText = latexAttr) => `<span class="math" data-math="${n}" data-display="${display}" data-latex="${latexAttr}">${latexText}</span>`;

test('wrapMath html: inline and display math, numbering, entities, \\$ and verbatim code', () => {
  const out = wrapMath('<p>$a \\lt b$ and $$x &lt; y$$ cost \\$5 <code>$HOME</code></p>', 'html');
  assert.equal(out, `<p>${span(0, 0, 'a \\lt b')} and ${span(1, 1, 'x &lt; y')} cost $5 <code>$HOME</code></p>`);
});

test('wrapMath plain escapes text and math', () => {
  assert.equal(wrapMath('A & B: $a<b$ \\$', 'plain'), `A &amp; B: ${span(0, 0, 'a&lt;b')} $`);
});

test('backslash escapes inside math do not close it', () => {
  const { segments } = segmentField('$a\\$b$ c', 'plain');
  assert.equal(segments[0].latex, 'a\\$b');
  assert.equal(segments[1].type, 'text');
});

test('unclosed delimiters and math across tags are reported', () => {
  assert.equal(segmentField('cost $5', 'plain').errors.length, 1);
  assert.equal(segmentField('<p>$a <b>x</b> b$</p>', 'html').errors.length, 2);
  assert.equal(segmentField('$$a$', 'plain').errors[0].message, 'unclosed $$ math delimiter');
});

test('resolveBoxTypes localizes defaults, overrides labels only and adds custom types', () => {
  const types = resolveBoxTypes({ language: 'vi', boxTypes: { warn: { label: 'Bẫy', color: 'c6' }, ai: { label: 'AI', color: 'c3' } } });
  assert.deepEqual(types.warn, { label: 'Bẫy', color: 'c2' });
  assert.deepEqual(types.def, { label: 'Định nghĩa', color: 'c1' });
  assert.deepEqual(types.ai, { label: 'AI', color: 'c3' });
  assert.equal(resolveBoxTypes({ language: 'fr' }).note.label, 'Note');
  assert.deepEqual(Object.fromEntries(Object.entries(DEFAULT_BOX_TYPES).map(([k, v]) => [k, v.color])),
    { def: 'c1', warn: 'c2', example: 'c3', formula: 'c4', note: 'c5', intuition: 'c6' });
});

const ctx = { boxTypes: resolveBoxTypes({ language: 'en' }), lessonId: 'l1', linkBase: '/lessons/', language: 'en' };

test('every block is a section with data-block-id and data-type', () => {
  const html = renderBlock({ id: 'b-0001', type: 'prose', html: '<p>x</p>', sources: ['a#p1'] }, ctx);
  assert.match(html, /^<section class="ld-block ld-prose" data-block-id="b-0001" data-type="prose">/);
  assert.match(html, /<div class="ld-prose-body" data-field="html"><p>x<\/p><\/div><\/section>$/);
});

test('heading: h2/h3 with id and data-field=text', () => {
  assert.match(renderBlock({ id: 'b-0001', type: 'heading', level: 3, anchor: 'a-b', text: 'T $x$' }, ctx),
    /<h3 id="a-b" data-field="text">T <span class="math" data-math="0"[^>]*>x<\/span><\/h3>/);
});

test('box: variant class, color token, chrome label, title and body fields', () => {
  const html = renderBlock({ id: 'b-0002', type: 'box', variant: 'warn', title: 'Pit $x$', html: '<p>b</p>', sources: ['a#p1'] }, ctx);
  assert.equal(html, '<section class="ld-block ld-box ld-box-warn" data-block-id="b-0002" data-type="box" style="--box-c: var(--c2)">'
    + '<div class="ld-box-head"><span class="ld-box-label" data-chrome>Pitfall</span>'
    + `<span class="ld-box-title" data-field="title">Pit ${span(0, 0, 'x')}</span></div>`
    + '<div class="ld-box-body" data-field="html"><p>b</p></div></section>');
});

test('math block is one display span in data-field=latex', () => {
  assert.match(renderBlock({ id: 'b-0003', type: 'math', latex: 'a<b', sources: ['a#p1'] }, ctx),
    /<div class="ld-math-body" data-field="latex"><span class="math" data-math="0" data-display="1" data-latex="a&lt;b">a&lt;b<\/span><\/div>/);
});

test('code: escaped code, optional caption field', () => {
  const html = renderBlock({ id: 'b-0004', type: 'code', language: 'js', code: 'a < b && $x', caption: 'C' }, ctx);
  assert.match(html, /<pre><code class="language-js" data-field="code">a &lt; b &amp;&amp; \$x<\/code><\/pre><div class="ld-code-caption" data-field="caption">C<\/div>/);
  assert.doesNotMatch(renderBlock({ id: 'b-0004', type: 'code', language: 'js', code: 'x' }, ctx), /caption/);
});

test('figure: inline svg or project asset, caption field', () => {
  assert.match(renderBlock({ id: 'b-0005', type: 'figure', svg: '<svg></svg>', alt: 'A', caption: 'C $x$' }, ctx),
    /<figure><svg><\/svg><figcaption data-field="caption">C <span class="math"/);
  assert.match(renderBlock({ id: 'b-0005', type: 'figure', src: 'assets/a.png', alt: 'A "q"', caption: 'C' }, ctx),
    /<img src="\/project\/assets\/a.png" alt="A &quot;q&quot;">/);
});

test('widget: data-widget and data-props only on the inner div', () => {
  const html = renderBlock({ id: 'b-0006', type: 'widget', widget: 'vector-plane', props: { a: '<"x">' } }, ctx);
  assert.equal(html, '<section class="ld-block ld-widget" data-block-id="b-0006" data-type="widget">'
    + '<div class="ld-widget" data-widget="vector-plane" data-props="{&quot;a&quot;:&quot;&lt;\\&quot;x\\&quot;&gt;&quot;}"></div></section>');
  const props = /data-props="([^"]*)"/.exec(html)[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  assert.deepEqual(JSON.parse(props), { a: '<"x">' });
});

test('quiz: details/summary question, chrome answer label, answer field', () => {
  const html = renderBlock({ id: 'b-0007', type: 'quiz', question: 'Q $x$?', answer: '<p>A</p>', sources: ['a#p1'] }, { ...ctx, language: 'vi' });
  assert.match(html, /<details class="ld-quiz"><summary data-field="question">Q <span[^>]*>x<\/span>\?<\/summary><div class="ld-quiz-answer"><span class="ld-answer-label" data-chrome>Đáp án<\/span><div data-field="answer"><p>A<\/p><\/div><\/div><\/details>/);
});

test('lesson: links are rewritten with linkBase; other links untouched', () => {
  const html = renderBlock({ id: 'b-0008', type: 'prose', html: '<p><a href="lesson:l2#sec">x</a> <a href="#a">y</a> <a href="https://e.com/?a=1&amp;b=2">z</a></p>', sources: ['a#p1'] }, ctx);
  assert.match(html, /<a href="\/lessons\/l2#sec">x<\/a> <a href="#a">y<\/a> <a href="https:\/\/e.com\/\?a=1&amp;b=2">z<\/a>/);
});

test('renderLessonBody joins every block', () => {
  const lesson = { blocks: [{ id: 'b-0001', type: 'heading', level: 2, anchor: 'a', text: 'A' }, { id: 'b-0002', type: 'prose', html: '<p>p</p>', sources: ['x#p1'] }] };
  assert.equal((renderLessonBody(lesson, ctx).match(/<section /g) || []).length, 2);
});
