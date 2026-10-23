import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import os from 'node:os';
import { commitPaths, commitsAdding, droppableCommits, dropFileVersions, init, isInsideWorkTree, log, revert, showFile } from '../../lib/git.mjs';
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

// A repo whose project sits in proj/, with a lesson changed three times and an unrelated commit
// in between: add (v0) · one (v1) · other.txt · two (v2) · three (v3).
function historyRepo(t) {
  const saved = { ...process.env };
  Object.assign(process.env, GIT_ENV);
  t.after(() => { process.env = saved; });
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'learndoc-history-'));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const root = path.join(top, 'proj');
  fs.mkdirSync(path.join(root, 'lessons'), { recursive: true });
  spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: top });
  const run = (...args) => spawnSync('git', args, { cwd: top, encoding: 'utf8' }).stdout.trim();
  const lesson = path.join(root, 'lessons', 'a.json');
  const version = (n) => `{"v":${n},"pad":"${'x'.repeat(2000 + n)}"}\n`;
  fs.writeFileSync(lesson, version(0));
  fs.writeFileSync(path.join(top, 'other.txt'), 'a\n');
  run('add', '.');
  run('commit', '--quiet', '-m', 'learndoc: add');
  const c = { add: run('rev-parse', 'HEAD') };
  fs.writeFileSync(lesson, version(1));
  c.one = commitPaths(root, ['lessons/a.json'], 'learndoc: one');
  fs.writeFileSync(path.join(top, 'other.txt'), 'b\n');
  run('commit', '--quiet', '-am', 'other');
  c.other = run('rev-parse', 'HEAD');
  fs.writeFileSync(lesson, version(2));
  c.two = commitPaths(root, ['lessons/a.json'], 'learndoc: two');
  fs.writeFileSync(lesson, version(3));
  c.three = commitPaths(root, ['lessons/a.json'], 'learndoc: three');
  return { top, root, run, c, version, tree: run('rev-parse', 'HEAD^{tree}') };
}

test('dropFileVersions folds a change into the one before it and frees the dropped version', (t) => {
  const { root, run, c, version, tree } = historyRepo(t);
  const result = dropFileVersions(root, 'lessons/a.json', new Set([c.two]));
  assert.equal(result.removedCommits, 1);
  assert.ok(result.freedBytes >= 0);
  assert.equal(run('rev-parse', 'HEAD^{tree}'), tree, 'the current tree is unchanged');
  assert.equal(run('status', '--porcelain'), '', 'index and working tree are untouched');
  assert.equal(run('symbolic-ref', 'HEAD'), 'refs/heads/main');
  const entries = log(root, 'lessons/a.json');
  assert.deepEqual(entries.map((e) => e.summary), ['learndoc: three', 'learndoc: one', 'learndoc: add']);
  assert.equal(showFile(root, 'lessons/a.json', entries[1].commit), version(2), '"one" now leads straight to v2');
  assert.match(run('log', '-1', '--format=%B', entries[1].commit), /learndoc: two/, 'its message keeps the folded subject');
  assert.equal(showFile(root, 'lessons/a.json', entries[2].commit), version(0));
  assert.deepEqual(run('log', '--format=%s').split('\n'), ['learndoc: three', 'other', 'learndoc: one', 'learndoc: add']);
  assert.equal(entries[2].commit, c.add, 'commits before the first rewritten one keep their hash');
  assert.notEqual(spawnSync('git', ['cat-file', '-e', c.two], { cwd: root }).status, 0, 'the dropped commit is pruned');
});

test('dropFileVersions of every change leaves only the commit that added the file', (t) => {
  const { root, run, c, version, tree } = historyRepo(t);
  const result = dropFileVersions(root, 'lessons/a.json', new Set([c.one, c.two, c.three]));
  assert.equal(result.removedCommits, 3);
  assert.equal(run('rev-parse', 'HEAD^{tree}'), tree);
  const entries = log(root, 'lessons/a.json');
  assert.equal(entries.length, 1);
  assert.equal(showFile(root, 'lessons/a.json', entries[0].commit), version(3), 'the add commit now adds the current version');
  assert.deepEqual(run('log', '--format=%s').split('\n'), ['other', 'learndoc: add'], 'the unrelated commit stays');
  assert.deepEqual(commitsAdding(root, 'lessons/a.json'), new Set([entries[0].commit]));
});

test('dropFileVersions refuses and changes nothing when it cannot rewrite safely', (t) => {
  const { root, run, c } = historyRepo(t);
  const head = run('rev-parse', 'HEAD');
  assert.throws(() => dropFileVersions(root, 'lessons/a.json', new Set([c.add])), { code: 'history/unknown' });
  assert.throws(() => dropFileVersions(root, 'lessons/a.json', new Set([c.other])), { code: 'history/unknown' });
  run('branch', 'backup');
  assert.throws(() => dropFileVersions(root, 'lessons/a.json', new Set([c.two])), { code: 'history/shared', message: /refs\/heads\/backup/ });
  run('branch', '-D', 'backup');
  assert.equal(run('rev-parse', 'HEAD'), head);
  assert.equal(dropFileVersions(root, 'lessons/a.json', new Set()).removedCommits, 0);
  assert.equal(run('rev-parse', 'HEAD'), head);
});

// A bare repo in a temp dir with a project in proj/; `commit(message, files)` writes and commits.
function bareRepo(t) {
  const saved = { ...process.env };
  Object.assign(process.env, GIT_ENV);
  t.after(() => { process.env = saved; });
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'learndoc-history-'));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const root = path.join(top, 'proj');
  fs.mkdirSync(path.join(root, 'lessons'), { recursive: true });
  spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: top });
  const run = (...args) => spawnSync('git', args, { cwd: top, encoding: 'utf8' }).stdout.trim();
  const commit = (message, files = {}) => {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(top, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    run('add', '-A');
    run('commit', '--quiet', '--allow-empty', '-m', message);
    return run('rev-parse', 'HEAD');
  };
  return { top, root, run, commit, exists: (id) => spawnSync('git', ['cat-file', '-e', id], { cwd: top }).status === 0 };
}
const LESSON_PATH = 'proj/lessons/a.json';

test('dropFileVersions keeps unrelated unreachable work and other reflog entries', (t) => {
  const { root, run, commit, exists } = bareRepo(t);
  commit('add', { [LESSON_PATH]: 'v0\n' });
  const precious = commit('precious work', { 'notes.txt': 'keep me\n' });
  run('reset', '--quiet', '--hard', 'HEAD~1');
  fs.writeFileSync(path.join(root, 'lessons', 'a.json'), 'stashed\n');
  run('stash', '--quiet');
  const stash = run('rev-parse', 'stash@{0}');
  run('stash', 'drop', '--quiet');
  const one = commit('one', { [LESSON_PATH]: 'v1\n' });
  commit('two', { [LESSON_PATH]: 'v2\n' });
  dropFileVersions(root, 'lessons/a.json', new Set([one]));
  assert.ok(exists(precious), 'a reset-away commit survives');
  assert.ok(exists(stash), 'a dropped stash survives');
  assert.match(run('reflog', '--format=%H'), new RegExp(precious), 'its reflog entry survives');
  assert.ok(!exists(one), 'the dropped commit is pruned');
  assert.equal(run('for-each-ref', 'refs/learndoc-keep'), '', 'no pins are left behind');
});

test('dropFileVersions keeps non-UTF-8 commits byte for byte and folds every vanished subject', (t) => {
  const { top, root, run, commit } = bareRepo(t);
  commit('add', { [LESSON_PATH]: 'A\n' });
  const toB = commit('to B', { [LESSON_PATH]: 'B\n' });
  const back = commit('back to A', { [LESSON_PATH]: 'A\n' });
  fs.writeFileSync(path.join(top, 'other.txt'), 'x\n');
  run('add', 'other.txt');
  spawnSync('git', ['-c', 'i18n.commitEncoding=ISO-8859-1', 'commit', '--quiet', '-F', '-'], { cwd: top, input: Buffer.from('caf\xe9\n', 'latin1') });
  const raw = () => spawnSync('git', ['cat-file', 'commit', 'HEAD'], { cwd: top }).stdout;
  const bodyBefore = raw().subarray(raw().indexOf('\n\n') + 2);
  commit('d', { [LESSON_PATH]: 'D\n' });
  const result = dropFileVersions(root, 'lessons/a.json', new Set([back]));
  assert.equal(result.removedCommits, 2, '"to B" undone by "back to A": both vanish');
  assert.deepEqual(run('log', '--format=%s').split('\n').slice(-1), ['add']);
  assert.match(run('log', '--format=%B', '-1', 'HEAD~2'), /^add\n\nto B\nback to A/, 'both subjects folded into the add commit');
  const latin = spawnSync('git', ['cat-file', 'commit', 'HEAD~1'], { cwd: top }).stdout;
  assert.deepEqual(latin.subarray(latin.indexOf('\n\n') + 2), bodyBefore, 'the ISO-8859-1 message is unchanged');
  assert.ok(toB);
});

test('dropFileVersions handles mode-only changes, re-added files and refuses busy or shared repos', (t) => {
  const { top, root, run, commit } = bareRepo(t);
  commit('first life', { [LESSON_PATH]: 'old\n' });
  commit('gone', {});
  run('rm', '--quiet', LESSON_PATH);
  run('commit', '--quiet', '-m', 'delete');
  const added = commit('add again', { [LESSON_PATH]: 'v0\n' });
  fs.chmodSync(path.join(top, LESSON_PATH), 0o755);
  const chmod = commit('chmod');
  const one = commit('one', { [LESSON_PATH]: 'v1\n' });
  assert.deepEqual(droppableCommits(root, 'lessons/a.json'), [chmod, one], 'only changes since the last add');

  fs.mkdirSync(path.join(top, '.git', 'sequencer'));
  assert.throws(() => dropFileVersions(root, 'lessons/a.json', new Set([one])), { code: 'history/busy' });
  fs.rmSync(path.join(top, '.git', 'sequencer'), { recursive: true });
  const worktree = path.join(top, '..', `${path.basename(top)}-wt`);
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  run('worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
  assert.throws(() => dropFileVersions(root, 'lessons/a.json', new Set([one])), { code: 'history/shared', message: /worktree/ });
  run('worktree', 'remove', '--force', worktree);

  dropFileVersions(root, 'lessons/a.json', new Set(droppableCommits(root, 'lessons/a.json')));
  assert.deepEqual(droppableCommits(root, 'lessons/a.json'), []);
  assert.equal(run('ls-tree', 'HEAD~0', '--', LESSON_PATH).split(' ')[0], '100755');
  assert.equal(run('ls-tree', 'HEAD', '--', LESSON_PATH), run('ls-tree', run('log', '-1', '--format=%H', '--diff-filter=A', '--', LESSON_PATH), '--', LESSON_PATH), 'the add commit now adds the current mode and content');
  assert.deepEqual(run('log', '--format=%s').split('\n'), ['add again', 'delete', 'gone', 'first life']);
  assert.ok(added);
});

test('dropFileVersions reports versions something else still holds, and frees space past a malformed old commit', (t) => {
  const { top, root, run, commit, exists } = bareRepo(t);
  // A root commit with a bad timezone (as in old imported repos): plain fsck fails on it.
  const tree = run('write-tree');
  const bad = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], {
    cwd: top, encoding: 'utf8', input: `tree ${tree}\nauthor a <a@x> 1700000000 +99999\ncommitter a <a@x> 1700000000 +99999\n\nold import\n`,
  }).stdout.trim();
  run('update-ref', 'refs/heads/main', bad);
  commit('add', { [LESSON_PATH]: 'A\n' });
  commit('to B', { [LESSON_PATH]: 'B\n' });
  const amended = run('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(top, LESSON_PATH), 'B2\n');
  run('commit', '--quiet', '-a', '--amend', '-m', 'to B (amended)');
  const toB = run('rev-parse', 'HEAD');
  const toC = commit('to C', { [LESSON_PATH]: 'C\n' });
  const blobB2 = run('rev-parse', `${toB}:${LESSON_PATH}`);
  const result = dropFileVersions(root, 'lessons/a.json', new Set([toC]));
  assert.equal(result.cleanupError, undefined, 'the malformed root commit does not stop the cleanup');
  assert.equal(result.retainedVersions, 0);
  assert.ok(!exists(blobB2), 'the dropped version is freed');
  assert.ok(exists(amended), 'the pre-amend commit, still in the reflog, is kept');

  const again = dropFileVersions(root, 'lessons/a.json', new Set(droppableCommits(root, 'lessons/a.json')));
  assert.equal(again.retainedVersions, 1, 'version A is still held by the pre-amend commit in the reflog');
});
