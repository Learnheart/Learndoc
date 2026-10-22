import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { checkCourse, checkLesson } from '../../lib/check.mjs';
import { codes, copyFixture, fixtureJson } from './helpers.mjs';

const FILE = 'lessons/intro.json';
const course = fixtureJson('course.json');
const block = (lesson, id) => lesson.blocks.find((entry) => entry.id === id);

function setup(t) {
  const root = copyFixture(t);
  const run = (mutate, ctx = {}) => {
    const lesson = fixtureJson(FILE);
    mutate?.(lesson);
    return checkLesson(lesson, { root, file: FILE, course, ...ctx });
  };
  return { root, run };
}

const withHtml = (html) => (lesson) => { block(lesson, 'b-1001').html = html; };

test('the fixture lesson and course pass every check', (t) => {
  const { root, run } = setup(t);
  assert.deepEqual(run(), []);
  assert.deepEqual(checkCourse(course, { root }), []);
});

test('KaTeX parses every math occurrence: html, plain, math blocks', (t) => {
  const { run } = setup(t);
  assert.deepEqual(codes(run(withHtml('<p>$\\frac{1}{$</p>'))), ['math/katex']);
  assert.deepEqual(codes(run((l) => { block(l, 'b-1000').text = 'Bad $\\notacommand$'; })), ['math/katex']);
  assert.deepEqual(codes(run((l) => { block(l, 'b-1005').latex = '\\begin{x}'; })), ['math/katex']);
  assert.deepEqual(codes(run((l) => { block(l, 'b-1009').question = 'Where $\\text{Đáp án}$ and $a<b$?'; })), [], 'unicode text and < in plain math are fine');
  assert.deepEqual(codes(run((l) => { block(l, 'b-1005').latex = '\\textsc{Adam} \\textsc{Adam}'; })), [], '\\textsc is a shared macro');
});

test('html whitelist: tags, attributes, classes, syntax, balance, entities', (t) => {
  const { run } = setup(t);
  assert.deepEqual(codes(run(withHtml('<p><script>x</script></p>'))), ['html/tag']);
  assert.deepEqual(codes(run(withHtml('<p style="x" id="y">a</p>'))), ['html/attribute', 'html/attribute']);
  assert.deepEqual(codes(run(withHtml('<p onclick="x">a</p>'))), ['html/attribute']);
  assert.deepEqual(codes(run(withHtml('<p class="term fancy">a</p>'))), ['html/class']);
  assert.deepEqual(codes(run(withHtml('<table><tr><td colspan="x">a</td></tr></table>'))), ['html/attribute']);
  assert.deepEqual(codes(run(withHtml('<p>$a < b$</p>'))), ['html/syntax']);
  assert.deepEqual(codes(run(withHtml('<p/>'))), ['html/syntax']);
  assert.deepEqual(codes(run(withHtml('<p><b>a</p></b>'))), ['html/unbalanced', 'html/unbalanced']);
  assert.deepEqual(codes(run(withHtml('<p>a'))), ['html/unbalanced']);
  assert.deepEqual(codes(run(withHtml('<p>&alpha; &amp; &#945;</p>'))), ['html/entity']);
  assert.deepEqual(codes(run(withHtml('<p>&copy 2024, R&D</p>'))), ['html/entity', 'html/entity'], 'legacy entities without ;');
  assert.deepEqual(codes(run(withHtml('<p>A & B, 1&2 &amp;c</p>'))), [], 'bare & before a non-letter is fine');
  assert.deepEqual(codes(run(withHtml('<p>$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$ and $$\\begin{matrix}x&y\\end{matrix}$$</p>'))), [], '& inside math is LaTeX');
  assert.deepEqual(codes(run(withHtml('<p>$\\begin{matrix}a&b\\end{matrix}$ &copy 2024, R&D</p>'))), ['html/entity', 'html/entity'], 'only the & outside math');
});

test('plain fields: no tags (math may contain <), entities are literal', (t) => {
  const { run } = setup(t);
  for (const title of ['<b>Bold</b>', 'a <div class="x">', 'x</span>', '<img src=x>', '<!-- note -->', '<h2>T</h2>', '<script>']) {
    assert.deepEqual(codes(run((l) => { block(l, 'b-1002').title = title; })), ['plain/tag'], title);
  }
  for (const title of ['The <BOS> token', 'Vec<T> and Option<Box<T>>', 'a<b', 'if a<b then 2<3', '<Enter> key', 'x <bold> y']) {
    assert.deepEqual(codes(run((l) => { block(l, 'b-1002').title = title; })), [], title);
  }
  const entity = run((l) => { block(l, 'b-1002').title = 'A &amp; B'; });
  assert.deepEqual(codes(entity), ['plain/entity']);
  assert.equal(entity[0].severity, 'warning');
});

test('links: in-lesson anchors, cross-lesson ids and anchors, https only', (t) => {
  const { root, run } = setup(t);
  assert.deepEqual(codes(run(withHtml('<p><a href="#nowhere">x</a></p>'))), ['links/unknown-anchor']);
  assert.deepEqual(codes(run(withHtml('<p><a href="lesson:ghost">x</a></p>'))), ['links/unknown-lesson']);
  assert.deepEqual(codes(run(withHtml('<p><a href="lesson:second#nope">x</a></p>'))), ['links/unknown-anchor']);
  assert.deepEqual(codes(run(withHtml('<p><a href="lesson:second">x</a></p>'))), []);
  const planned = run(withHtml('<p><a href="lesson:later">x</a></p>'));
  assert.deepEqual(codes(planned), ['links/target-unavailable']);
  assert.equal(planned[0].severity, 'warning');
  assert.deepEqual(codes(run(withHtml('<p><a href="http://e.com">x</a></p>'))), ['links/insecure']);
  assert.deepEqual(codes(run(withHtml('<p><a href="javascript:alert(1)">x</a> <a href="/x">y</a></p>'))), ['links/scheme', 'links/scheme']);
  fs.rmSync(path.join(root, 'lessons', 'second.json'));
  assert.deepEqual(codes(run(withHtml('<p><a href="lesson:second">x</a></p>'))), ['links/target-unavailable']);
});

test('svg whitelist: root, tags, attributes, ids, classes, url(#id) references', (t) => {
  const { run } = setup(t);
  const svg = (inner, attrs = 'viewBox="0 0 10 10"') => (l) => { block(l, 'b-1007').svg = `<svg ${attrs}>${inner}</svg>`; };
  assert.deepEqual(codes(run(svg('<script>x</script>'))), ['svg/tag']);
  assert.deepEqual(codes(run(svg('<foreignObject></foreignObject><image></image>'))), ['svg/tag', 'svg/tag']);
  assert.deepEqual(codes(run(svg('<rect style="x" onclick="y" href="z"/>'))), ['svg/attribute', 'svg/attribute', 'svg/attribute']);
  assert.deepEqual(codes(run(svg('<rect id="r"/>'))), ['svg/attribute'], 'id only on marker/clipPath');
  assert.deepEqual(codes(run(svg('<rect class="c1 neon"/>'))), ['svg/class']);
  assert.deepEqual(codes(run(svg('<line marker-end="url(#missing)"/>'))), ['svg/reference']);
  assert.deepEqual(codes(run(svg('<rect fill="url(https://e.com/x)"/>'))), ['svg/reference']);
  assert.deepEqual(codes(run(svg('<clipPath id="c"><rect/></clipPath><g clip-path="url(#c)"><text x="1">a &amp; b</text></g>'))), []);
  assert.deepEqual(codes(run(svg('<defs><marker id="m" markerUnits="strokeWidth"><path/></marker></defs><line stroke-linecap="round" stroke-linejoin="round" marker-end="url(#m)"/><text dx="1" dy="2"><tspan baseline-shift="sub">i</tspan></text>'))), []);
  assert.deepEqual(codes(run(svg('<line stroke-linecap="url(#nope)"/>'))), ['svg/reference'], 'url() is still checked on new attributes');
  assert.deepEqual(codes(run((l) => { block(l, 'b-1007').svg = '<svg></svg><p>x</p>'; })), ['svg/root', 'svg/tag']);
  assert.deepEqual(codes(run(svg('<g>'))), ['svg/unbalanced']);
});

test('course: prereqs must exist; done lessons need files', (t) => {
  const { root } = setup(t);
  const broken = structuredClone(course);
  broken.modules[0].lessons[1].prereq = ['ghost', 'second'];
  assert.deepEqual(codes(checkCourse(broken, { root })), ['course/unknown-prereq', 'course/unknown-prereq']);
  fs.rmSync(path.join(root, 'lessons', 'second.json'));
  assert.deepEqual(codes(checkCourse(course, { root })), ['course/missing-lesson-file']);
});
