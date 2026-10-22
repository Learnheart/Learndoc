import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PROFILE, resolveProfile } from '../../lib/import/profile.mjs';
import { codes } from './helpers.mjs';

test('no profile resolves to the generic defaults, which leave the language to the pages', () => {
  assert.deepEqual(resolveProfile({}, 'p'), { profile: DEFAULT_PROFILE, diagnostics: [] });
  assert.equal(Object.hasOwn(DEFAULT_PROFILE, 'language'), false);
  assert.equal(resolveProfile({ language: 'vi' }, 'p').profile.language, 'vi');
});

test('objects merge key by key; arrays and scalars replace', () => {
  const { profile } = resolveProfile({ lesson: { root: 'main.lesson' }, files: { exclude: [] }, boxes: { variantMap: { tip: 'note' } } }, 'p');
  assert.equal(profile.lesson.root, 'main.lesson');
  assert.equal(profile.lesson.header, DEFAULT_PROFILE.lesson.header);
  assert.deepEqual(profile.files, { include: DEFAULT_PROFILE.files.include, exclude: [] });
  assert.equal(profile.boxes.variantMap.tip, 'note');
  assert.equal(profile.boxes.variantMap.warning, 'warn');
  assert.deepEqual(DEFAULT_PROFILE.files.exclude, ['^index\\.html?$'], 'defaults are not mutated');
  const resolved = resolveProfile({}, 'p').profile;
  resolved.lesson.chipRules.push({ label: 'x', to: 'prose' });
  resolved.boxes.variantMap.extra = 'note';
  assert.deepEqual(DEFAULT_PROFILE.lesson.chipRules, [], 'a resolved profile shares nothing with the defaults');
  assert.equal(DEFAULT_PROFILE.boxes.variantMap.extra, undefined);
});

test('schema errors come first and stop the semantic checks', () => {
  assert.deepEqual(codes(resolveProfile({ course: { order: 'random' } }, 'p').diagnostics), ['schema/enum']);
  assert.equal(resolveProfile({ extra: true }, 'p').profile, null);
});

test('semantic checks: regexes, box variants, globals expr, candidate widgets', () => {
  const problems = (user) => resolveProfile(user, 'p').diagnostics.map((entry) => entry.subject.path);
  assert.deepEqual(problems({ files: { include: '[' }, boxes: { classPattern: '(' } }), ['files.include', 'boxes.classPattern']);
  assert.deepEqual(problems({ boxes: { variants: ['ai'], variantMap: { x: 'nope' } } }), ['boxes', 'boxes']);
  assert.deepEqual(problems({ boxes: { variants: ['ai'], boxTypes: { ai: { label: 'AI', color: 'c3' } } } }), []);
  assert.deepEqual(problems({ course: { order: 'globals' } }), ['course.globals.expr']);
  assert.deepEqual(problems({ lesson: { chipRules: [{ label: 'pre', to: 'prereq' }] } }), [], 'a prereq rule without ref uses the default');
  assert.deepEqual(problems({ demos: { candidates: [{ widget: 'not-a-widget' }] } }), ['demos.candidates/0/widget']);
  assert.ok(resolveProfile({ files: { include: '[' } }, 'p').diagnostics.every((entry) => entry.code === 'import/profile-invalid'));
});
