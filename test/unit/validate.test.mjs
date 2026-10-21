import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ensureChunks } from '../../lib/refs.mjs';
import { parseSourceRef, schemaDiagnostics, validateConfig, validateCourse, validateLesson } from '../../lib/validate.mjs';
import { codes, copyFixture, fixtureJson } from './helpers.mjs';

const FILE = 'lessons/intro.json';

async function setup(t) {
  const root = copyFixture(t);
  const config = fixtureJson('learndoc.json');
  const course = fixtureJson('course.json');
  const { indexes } = await ensureChunks(root, config);
  const lesson = fixtureJson(FILE);
  const run = (mutate, overrides = {}) => {
    const copy = structuredClone(lesson);
    mutate?.(copy);
    return validateLesson(copy, { root, file: FILE, config, course, indexes, ...overrides });
  };
  return { root, config, course, indexes, lesson, run };
}

const block = (lesson, id) => lesson.blocks.find((entry) => entry.id === id);

test('the fixture project validates cleanly', async (t) => {
  const { run, config, course, indexes } = await setup(t);
  assert.deepEqual(await run(), []);
  assert.deepEqual(validateConfig(config), []);
  assert.deepEqual(validateCourse(course, { config, indexes }), []);
});

test('parseSourceRef', () => {
  assert.deepEqual(parseSourceRef('mml#p71-73|§3.1'), { alias: 'mml', page: 71, pageEnd: 73 });
  assert.deepEqual(parseSourceRef('mml#p7'), { alias: 'mml', page: 7, pageEnd: 7 });
  assert.deepEqual(parseSourceRef('notes#what-is-an-agent'), { alias: 'notes', anchor: 'what-is-an-agent' });
  assert.equal(parseSourceRef('bad'), null);
});

test('schema errors carry path, block id and supported fixes; discriminator noise is dropped', async (t) => {
  const { run } = await setup(t);
  const out = await run((lesson) => {
    block(lesson, 'b-1000').level = 4;
    block(lesson, 'b-1001').style = 'x';
    lesson.blocks.push({ id: 'b-7777', type: 'nope' });
    delete block(lesson, 'b-1009').sources;
  });
  assert.deepEqual(codes(out).sort(), ['schema/additionalProperties', 'schema/enum', 'schema/enum', 'schema/required']);
  const extra = out.find((entry) => entry.code === 'schema/additionalProperties');
  assert.deepEqual(extra.subject, { file: FILE, path: '/blocks/1', id: 'b-1001' });
  assert.deepEqual(extra.supportedFixes, ['remove unsupported property "style"']);
  assert.match(extra.message, /\/blocks\/1 \(id: "b-1001"\) must NOT have additional properties/);
});

test('lesson-level semantic diagnostics', async (t) => {
  const { run, course } = await setup(t);
  assert.deepEqual(codes(await run((l) => { l.id = 'other'; }, { course: { ...course, modules: [{ ...course.modules[0], lessons: [{ id: 'other', title: 'x', status: 'done' }] }] } })), ['lesson/id-mismatch']);
  assert.deepEqual(codes(await run(null, { course: { ...course, modules: [{ ...course.modules[0], lessons: [] }] } })), ['lesson/not-in-course']);
  assert.deepEqual(codes(await run((l) => { block(l, 'b-1001').id = 'b-1000'; })), ['block/duplicate-id']);
  assert.deepEqual(codes(await run((l) => { block(l, 'b-1004').anchor = 'vectors'; })), ['heading/duplicate-anchor']);
});

test('source references: alias, kind, anchor, page range and unverified', async (t) => {
  const { run, root, config, course } = await setup(t);
  const withSource = (source) => run((l) => { block(l, 'b-1005').sources = [source]; });
  assert.deepEqual(codes(await withSource('mml#p3')), ['refs/unknown-alias']);
  assert.deepEqual(codes(await withSource('notes#p3')), ['refs/kind-mismatch']);
  assert.deepEqual(codes(await withSource('notes#missing')), ['refs/unknown-anchor']);
  const pdfIndexes = { notes: { type: 'pdf', pages: 10, pagesWithoutText: [] } };
  const pdf = (source) => validateLesson({ ...fixtureJson(FILE), blocks: [{ id: 'b-0001', type: 'math', latex: 'x', sources: [source] }] }, { root, file: FILE, config, course, indexes: pdfIndexes });
  assert.deepEqual(codes(await pdf('notes#p11')), ['refs/page-out-of-range']);
  assert.deepEqual(codes(await pdf('notes#p0')), ['refs/page-out-of-range']);
  assert.deepEqual(codes(await pdf('notes#p5-3')), ['refs/page-out-of-range']);
  assert.deepEqual(codes(await pdf('notes#p2-10|§1')), []);
  const noIndex = await run(null, { indexes: {} });
  assert.deepEqual(codes(noIndex), ['refs/unverified'], 'reported once per alias');
  assert.equal(noIndex[0].severity, 'warning');
});

test('block semantics: box variant, figure source, math delimiters', async (t) => {
  const { run } = await setup(t);
  assert.deepEqual(codes(await run((l) => { block(l, 'b-1002').variant = 'mystery'; })), ['box/unknown-variant']);
  assert.deepEqual(codes(await run((l) => { block(l, 'b-1007').src = 'assets/x.png'; })), ['figure/source', 'figure/missing-asset']);
  assert.deepEqual(codes(await run((l) => { delete block(l, 'b-1007').svg; })), ['figure/source']);
  assert.deepEqual(codes(await run((l) => { block(l, 'b-1001').html = '<p>\\(x\\) and \\[y\\]</p>'; })), ['math/delimiter']);
  assert.deepEqual(codes(await run((l) => { block(l, 'b-1005').latex = '$x$'; })), ['math/delimiter']);
  assert.deepEqual(codes(await run((l) => { block(l, 'b-1000').text = 'costs $5'; })), ['math/unclosed']);
  assert.deepEqual(codes(await run((l) => { block(l, 'b-1001').html = '<p><code>\\(x\\) $y</code></p>'; })), [], 'code is verbatim');
});

test('widgets: unknown, invalid props, load failure, invalid module, built-in props', async (t) => {
  const { run, root } = await setup(t);
  assert.deepEqual(codes(await run((l) => { block(l, 'b-1008').widget = 'nope'; })), ['widget/unknown']);
  const props = await run((l) => { block(l, 'b-1008').props = { start: -1, extra: true }; });
  assert.deepEqual(codes(props), ['widget/props-invalid', 'widget/props-invalid']);
  assert.deepEqual(props.map((entry) => entry.subject.path).sort(), ['/props/extra', '/props/start']);
  fs.writeFileSync(path.join(root, 'widgets', 'broken.js'), 'export default {');
  assert.deepEqual(codes(await run((l) => { block(l, 'b-1008').widget = 'broken'; })), ['widget/load-failed']);
  fs.writeFileSync(path.join(root, 'widgets', 'empty.js'), 'export default { name: "empty" };');
  assert.deepEqual(codes(await run((l) => { block(l, 'b-1008').widget = 'empty'; })), ['widget/invalid-module']);
  const builtIn = await run((l) => Object.assign(block(l, 'b-1008'), { widget: 'vector-plane', props: { vectors: [] } }));
  assert.deepEqual(codes(builtIn), ['widget/props-invalid'], 'built-in widget propsSchema is enforced');
});

test('config and course semantics', async (t) => {
  const { config, course, indexes } = await setup(t);
  assert.deepEqual(codes(validateConfig({ ...config, boxTypes: { custom: { label: 'C' } } })), ['config/box-color']);
  assert.deepEqual(codes(validateConfig({ ...config, references: { w: { type: 'web', file: 'x.md' } } })), ['schema/required']);
  const modules = [...course.modules, { ...course.modules[0] }];
  assert.deepEqual(codes(validateCourse({ ...course, modules }, { config, indexes })).sort(), ['course/duplicate-lesson', 'course/duplicate-lesson', 'course/duplicate-lesson', 'course/duplicate-module']);
  const sources = structuredClone(course);
  sources.modules[0].lessons[0].sources = ['zzz#p1'];
  assert.deepEqual(codes(validateCourse(sources, { config, indexes })), ['refs/unknown-alias']);
});

test('schemaDiagnostics covers every schema, including the single-block validator', () => {
  assert.deepEqual(schemaDiagnostics('answer', { answer: '<p>x</p>', sources: ['a#p1'] }, 'answer'), []);
  assert.deepEqual(codes(schemaDiagnostics('block', { id: 'b-0001', type: 'prose', html: 'x', sources: [] }, 'block')), ['schema/minItems']);
  assert.deepEqual(codes(schemaDiagnostics('changeset', { summary: 's', changes: [{ op: 'replace', role: 'primary', blockId: 'b-0001', block: { type: 'prose', html: 'x', sources: ['a#p1'] } }] }, 'cs')), []);
  assert.throws(() => schemaDiagnostics('nope', {}, 'x'), /unknown schema/);
});
