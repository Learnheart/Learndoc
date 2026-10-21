import assert from 'node:assert/strict';
import test from 'node:test';
import { renderIndexPage, renderLessonPage, widgetUrlMap } from '../../lib/page.mjs';
import { builtinWidgetNames } from '../../lib/project.mjs';
import { FIXTURE, fixtureJson } from './helpers.mjs';

const config = fixtureJson('learndoc.json');
const course = fixtureJson('course.json');
const lesson = fixtureJson('lessons/intro.json');
const render = (options = {}) => renderLessonPage({ root: FIXTURE, config, course, lesson, ...options });

test('lesson page loads assets in contract order and carries the lesson meta', () => {
  const html = render();
  const order = ['/static/runtime/vendor/katex/katex.min.css', '/static/runtime/style.css', '/static/runtime/vendor/katex/katex.min.js', '/static/runtime/lesson.js'];
  const positions = order.map((url) => html.indexOf(url));
  assert.ok(positions.every((p, i) => p > 0 && (i === 0 || p > positions[i - 1])), 'ordered');
  assert.match(html, /<meta name="learndoc-lesson" content="intro">/);
  assert.doesNotMatch(html, /editor\.js|learndoc-token/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<body class="ld-page ld-page-lesson">/);
  assert.match(html, /<title>Intro to \\mathbb\{R\}\^n · Fixture course<\/title>/);
});

test('editable adds editor.js after lesson.js and the token meta', () => {
  const html = render({ editable: true, token: 'abc' });
  assert.ok(html.indexOf('/static/runtime/editor.js') > html.indexOf('/static/runtime/lesson.js'));
  assert.match(html, /<meta name="learndoc-token" content="abc">/);
});

test('page chrome: topbar, h2-only TOC, header, prev/next skipping planned lessons', () => {
  const html = render();
  assert.match(html, /<header class="ld-topbar"><a class="ld-home" href="\/">Fixture course<\/a><span class="ld-crumb">Basics · Intro to <span class="math"/);
  assert.match(html, /<button class="ld-theme-toggle" type="button"><\/button><\/header>/);
  const toc = /<nav class="ld-toc"[^>]*>(.*?)<\/nav>/.exec(html)[1];
  assert.deepEqual([...toc.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]), ['vectors']);
  assert.match(html, /<main class="ld-lesson" data-lesson-id="intro">\n<header class="ld-lesson-header"><div class="ld-kicker">Basics<\/div><h1>Intro to /);
  assert.match(html, /<p class="ld-lede">Vectors, norms &amp; friends\.<\/p><div class="ld-meta"><span class="ld-chip">10 min<\/span><span class="ld-chip">beginner<\/span><\/div>/);
  assert.match(html, /<nav class="ld-lesson-nav"><a class="ld-next" href="\/lessons\/second">Second<\/a><\/nav>/);
  const second = renderLessonPage({ root: FIXTURE, config, course, lesson: fixtureJson('lessons/second.json') });
  assert.match(second, /<nav class="ld-lesson-nav"><a class="ld-prev" href="\/lessons\/intro">Intro<\/a><\/nav>/, 'planned "later" is not a next link');
});

test('#ld-widgets lists every built-in plus used project widgets', () => {
  const map = widgetUrlMap(FIXTURE, lesson);
  for (const name of builtinWidgetNames()) assert.equal(map[name], `/static/runtime/widgets/${name}.js`);
  assert.equal(map.counter, '/project/widgets/counter.js');
  assert.ok(!Object.keys(map).some((name) => name.startsWith('_')));
  const json = /<script type="application\/json" id="ld-widgets">(.*?)<\/script>/.exec(render())[1];
  assert.deepEqual(JSON.parse(json), map);
});

test('math disabled: no KaTeX assets', () => {
  const html = renderLessonPage({ root: FIXTURE, config: { ...config, features: { math: false } }, course, lesson });
  assert.doesNotMatch(html, /katex/);
});

test('index page: modules with cards; planned lessons are not links', () => {
  const html = renderIndexPage({ config, course });
  assert.match(html, /<body class="ld-page ld-page-index">/);
  assert.match(html, /<main class="ld-index">\n<h1>Fixture course<\/h1>\n<p>A tiny course used by the unit tests\.<\/p>/);
  assert.match(html, /<section class="ld-module"><h2>Basics<\/h2><a class="ld-card" href="\/lessons\/intro"><h3>Intro<\/h3><p>Every block type once\.<\/p><span class="ld-badge done">Done<\/span><\/a>/);
  assert.match(html, /<div class="ld-card"><h3>Later<\/h3><span class="ld-badge planned">Planned<\/span><\/div><\/section>/);
});
