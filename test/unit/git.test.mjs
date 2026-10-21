import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { commitPaths, commitsAdding, init, isInsideWorkTree, log, revert } from '../../lib/git.mjs';
import { copyFixture, GIT_ENV } from './helpers.mjs';

test('init, commitPaths (only the given paths), log and revert', (t) => {
  const saved = { ...process.env };
  Object.assign(process.env, GIT_ENV);
  t.after(() => { process.env = saved; });
  const root = copyFixture(t);
  assert.equal(isInsideWorkTree(root), false);
  init(root);
  assert.equal(isInsideWorkTree(root), true);
  assert.deepEqual(log(root, 'lessons/intro.json'), [], 'no commits yet');

  spawnSync('git', ['add', 'course.json'], { cwd: root });
  const first = commitPaths(root, ['lessons/intro.json'], 'learndoc: first');
  const lesson = path.join(root, 'lessons', 'intro.json');
  const original = fs.readFileSync(lesson, 'utf8');
  fs.writeFileSync(lesson, '{}\n');
  fs.writeFileSync(path.join(root, 'learndoc.json'), '{}\n');
  const second = commitPaths(root, ['lessons/intro.json'], 'learndoc: second');
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
  assert.match(status, /^A {2}course\.json$/m, 'other staged files stay staged and uncommitted');
  assert.deepEqual(log(root, 'lessons/intro.json').map((entry) => [entry.commit, entry.summary]), [[second, 'learndoc: second'], [first, 'learndoc: first']]);

  assert.equal(commitPaths(root, ['lessons/intro.json'], 'learndoc: nothing'), null, 'nothing to commit');
  const third = revert(root, 'lessons/intro.json', first, 'learndoc: revert');
  assert.equal(fs.readFileSync(lesson, 'utf8'), original);
  assert.equal(log(root, 'lessons/intro.json')[0].commit, third);
  assert.equal(log(root, 'lessons/intro.json', { limit: 1 }).length, 1);
  const files = spawnSync('git', ['show', '--name-only', '--format=', third], { cwd: root, encoding: 'utf8' }).stdout.trim();
  assert.equal(files, 'lessons/intro.json');
});

test('commitsAdding lists only the commits that created the file', (t) => {
  const saved = { ...process.env };
  Object.assign(process.env, GIT_ENV);
  t.after(() => { process.env = saved; });
  const root = copyFixture(t);
  init(root);
  assert.deepEqual(commitsAdding(root, 'lessons/intro.json'), new Set(), 'no commits yet');
  const created = commitPaths(root, ['lessons/intro.json'], 'learndoc: create');
  fs.writeFileSync(path.join(root, 'lessons', 'intro.json'), '{}\n');
  const changed = commitPaths(root, ['lessons/intro.json'], 'learndoc: change');
  assert.notEqual(created, changed);
  assert.deepEqual(commitsAdding(root, 'lessons/intro.json'), new Set([created]));
});
