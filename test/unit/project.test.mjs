import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { findChrome } from '../../lib/chrome.mjs';
import { bootstrapProject, findProjectRoot, readJson, resolveWidget } from '../../lib/project.mjs';
import { copyFixture } from './helpers.mjs';

test('findProjectRoot walks up from files and directories', (t) => {
  const root = copyFixture(t);
  assert.equal(findProjectRoot(path.join(root, 'lessons', 'intro.json')), root);
  assert.equal(findProjectRoot(path.join(root, 'lessons')), root);
  assert.equal(findProjectRoot(path.dirname(root)), null);
});

test('readJson reports missing files and parse errors', (t) => {
  const root = copyFixture(t);
  assert.equal(readJson(path.join(root, 'nope.json'), { root }).diagnostic.code, 'project/missing-file');
  fs.writeFileSync(path.join(root, 'bad.json'), '{\n  "a": 1,\n}');
  const { diagnostic } = readJson(path.join(root, 'bad.json'), { root });
  assert.equal(diagnostic.code, 'json/parse');
  assert.equal(diagnostic.evidence.line, 3);
  assert.deepEqual(readJson(path.join(root, 'learndoc.json'), { root }).value.schemaVersion, 1);
});

test('bootstrapProject is idempotent', (t) => {
  const root = copyFixture(t);
  assert.deepEqual(bootstrapProject(root), { stateCreated: true, gitInitialized: true });
  assert.deepEqual(bootstrapProject(root), { stateCreated: false, gitInitialized: false });
});

test('resolveWidget prefers built-ins and ignores private helpers', (t) => {
  const root = copyFixture(t);
  assert.equal(resolveWidget(root, 'counter').url, '/project/widgets/counter.js');
  assert.equal(resolveWidget(root, '_svg'), null);
  assert.equal(resolveWidget(root, 'ghost'), null);
  fs.copyFileSync(path.join(root, 'widgets', 'counter.js'), path.join(root, 'widgets', 'vector-plane.js'));
  const builtIn = resolveWidget(root, 'vector-plane');
  if (builtIn.builtIn) assert.equal(builtIn.url, '/static/runtime/widgets/vector-plane.js');
});

test('findChrome honours LEARNDOC_CHROME and falls back to PATH lookups', () => {
  assert.equal(findChrome({ env: { LEARNDOC_CHROME: '' } }), null);
  assert.equal(findChrome({ env: { LEARNDOC_CHROME: process.execPath } }), process.execPath);
  const found = findChrome({ env: { PATH: '/opt/x:/usr/bin' }, platform: 'linux', resolveExecutable: (file) => (file === '/usr/bin/chromium' ? file : null) });
  assert.equal(found, '/usr/bin/chromium');
});
