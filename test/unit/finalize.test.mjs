import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { findChrome } from '../../lib/chrome.mjs';
import { runFinalize, sha256, UsageError } from '../../lib/finalize.mjs';
import { formatJson } from '../../lib/project.mjs';
import { codes, copyFixture, GIT_ENV, readJson, SKILL, writeJson } from './helpers.mjs';

const CLI = path.join(SKILL, 'bin', 'learndoc.mjs');
const browserSkip = !findChrome() && 'Chrome not found';
const NO_CHROME = { ...process.env, LEARNDOC_CHROME: '' };

// finalize commits passing lessons; give git an identity even where none is configured.
Object.assign(process.env, GIT_ENV);

const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

test('lesson finalize: bootstrap, all gates, compact receipt, standalone page', async (t) => {
  const root = copyFixture(t);
  const legacy = [path.join(root, '.learndoc', 'build', 'old.html'), path.join(root, 'references', 'chunks', 'notes', 'index.json')];
  for (const file of legacy) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
  }
  fs.mkdirSync(path.join(root, '.learndoc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.learndoc', '.gitignore'), 'server.json\nserver.log\nbuild/\nchangesets/\nimport/\n');
  const { exitCode, receipt } = await runFinalize({ file: path.join(root, 'lessons', 'intro.json') });
  assert.deepEqual(Object.keys(receipt), ['schemaVersion', 'ok', 'command', 'status', 'target', 'gates', 'diagnostics', 'diagnosticSummary', 'artifact', 'commit', 'durationMs']);
  assert.equal(receipt.target.kind, 'lesson');
  assert.match(receipt.target.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([receipt.gates.validate, receipt.gates.render, receipt.gates.check], ['pass', 'pass', 'pass']);
  assert.equal(fs.readFileSync(path.join(root, '.learndoc', '.gitignore'), 'utf8'), 'server.json\nserver.log\nbuild/\nchangesets/\nimport/\nrefs/\n',
    'an existing .gitignore gets the missing entries appended');
  assert.ok(fs.existsSync(path.join(root, '.git')), 'git init outside a work tree');
  assert.ok(fs.existsSync(path.join(root, '.learndoc', 'refs', 'notes.json')));
  for (const file of legacy) assert.ok(!fs.existsSync(file), `${path.relative(root, file)} from an earlier version is removed`);
  assert.ok(!fs.existsSync(path.join(root, 'references', 'chunks')), 'the emptied legacy chunks folder goes too');
  assert.equal(receipt.artifact.path, path.join(root, 'html', 'intro.html'), 'the standalone page is the only rendered copy');
  const page = fs.readFileSync(receipt.artifact.path, 'utf8');
  assert.equal(receipt.artifact.sha256, sha256(page));
  assert.doesNotMatch(page, /<meta name="learndoc-token"|<script[^>]*editor\.js/, 'finalize builds the non-editable page');
  if (browserSkip) {
    t.diagnostic(`browser-check assertion skipped: ${browserSkip}`);
    return;
  }
  assert.deepEqual(receipt.diagnostics, []);
  assert.equal(receipt.gates['browser-check'], 'pass');
  assert.equal(receipt.status, 'pass');
  assert.equal(exitCode, 0);
});

test('browser-check fails on widget runtime errors and missing resources', { skip: browserSkip }, async (t) => {
  const root = copyFixture(t);
  fs.writeFileSync(path.join(root, 'widgets', 'counter.js'), fs.readFileSync(path.join(root, 'widgets', 'counter.js'), 'utf8')
    .replace("button.remove(); }", "button.remove(); console.error('boom from destroy'); }"));
  const file = path.join(root, 'lessons', 'intro.json');
  const lesson = readJson(file);
  const figure = lesson.blocks.find((block) => block.id === 'b-1007');
  delete figure.svg;
  figure.src = 'assets/pixel.png';
  writeJson(file, lesson);
  // A directory passes validate's existence check but cannot be served, so the image load fails.
  fs.mkdirSync(path.join(root, 'assets', 'pixel.png'), { recursive: true });
  const { exitCode, receipt } = await runFinalize({ file });
  assert.equal(exitCode, 1);
  assert.equal(receipt.failedStage, 'browser-check');
  assert.deepEqual([...new Set(codes(receipt.diagnostics))].sort(), ['browser/console-error', 'browser/resource-failed']);
  assert.ok(receipt.diagnostics.some((entry) => /boom from destroy/.test(entry.message)));
  assert.equal(receipt.nextAction, undefined);
});

test('a lesson that passes (or skips browser-check) is rewritten in canonical form; a failing one is not', async (t) => {
  const root = copyFixture(t);
  const file = path.join(root, 'lessons', 'intro.json');
  const lesson = readJson(file);
  fs.writeFileSync(file, JSON.stringify(lesson));
  const { receipt } = await runFinalize({ file, env: { ...process.env, LEARNDOC_CHROME: '' } });
  assert.equal(receipt.status, 'skipped');
  const canonical = formatJson(lesson);
  assert.equal(fs.readFileSync(file, 'utf8'), canonical);
  assert.equal(receipt.target.sha256, createHash('sha256').update(canonical).digest('hex'));

  lesson.blocks[1].sources = ['ghost#p1'];
  fs.writeFileSync(file, JSON.stringify(lesson));
  assert.equal((await runFinalize({ file })).receipt.status, 'fail');
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(lesson));
});

test('a passing lesson commits exactly learndoc.json, course.json and the lesson', async (t) => {
  const root = copyFixture(t);
  const { receipt } = await runFinalize({ file: path.join(root, 'lessons', 'intro.json'), env: NO_CHROME });
  assert.equal(receipt.status, 'skipped');
  assert.match(receipt.commit, /^[0-9a-f]{40}$/);
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), receipt.commit);
  assert.equal(git(root, 'log', '-1', '--format=%s').stdout.trim(), 'learndoc: finalize intro');
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort(),
    ['course.json', 'learndoc.json', 'lessons/intro.json']);
  assert.deepEqual(git(root, 'ls-files').stdout.trim().split('\n').sort(), ['course.json', 'learndoc.json', 'lessons/intro.json'],
    'references/, widgets/ and .learndoc/ stay uncommitted');

  const again = await runFinalize({ file: path.join(root, 'lessons', 'intro.json'), env: NO_CHROME });
  assert.equal(again.receipt.commit, null, 'nothing changed, nothing to commit');
  assert.equal(git(root, 'rev-list', '--count', 'HEAD').stdout.trim(), '1');

  const second = await runFinalize({ file: path.join(root, 'lessons', 'second.json'), env: NO_CHROME });
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', second.receipt.commit).stdout.trim().split('\n'), ['lessons/second.json']);
});

test('a commit failure is a warning: the lesson still passes with commit null', { skip: browserSkip }, async (t) => {
  const root = copyFixture(t);
  git(root, 'init', '--quiet');
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  const { exitCode, receipt } = await runFinalize({ file: path.join(root, 'lessons', 'intro.json') });
  assert.equal(exitCode, 0);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.commit, null);
  const warning = receipt.diagnostics.find((entry) => entry.code === 'project/commit-failed');
  assert.equal(warning?.severity, 'warning');
  assert.deepEqual(warning.subject, { file: 'lessons/intro.json' });
  assert.notEqual(git(root, 'rev-parse', '--verify', 'HEAD').status, 0, 'the hook blocked the commit');
});

test('commit: false keeps the canonical rewrite but leaves committing to the caller', async (t) => {
  const root = copyFixture(t);
  const file = path.join(root, 'lessons', 'intro.json');
  const lesson = readJson(file);
  fs.writeFileSync(file, JSON.stringify(lesson));
  const { receipt } = await runFinalize({ file, env: NO_CHROME, commit: false });
  assert.equal(receipt.status, 'skipped');
  assert.equal(receipt.commit, null);
  assert.equal(fs.readFileSync(file, 'utf8'), formatJson(lesson));
  assert.notEqual(git(root, 'rev-parse', '--verify', 'HEAD').status, 0);
});

test('a failing lesson commits nothing', async (t) => {
  const root = copyFixture(t);
  const file = path.join(root, 'lessons', 'intro.json');
  const lesson = readJson(file);
  lesson.blocks[1].sources = ['ghost#p1'];
  writeJson(file, lesson);
  const { receipt } = await runFinalize({ file, env: NO_CHROME });
  assert.equal(receipt.status, 'fail');
  assert.equal(receipt.commit, null);
  assert.notEqual(git(root, 'rev-parse', '--verify', 'HEAD').status, 0, 'no commit was made');
});

test('finalize learndoc.json alone chunks references (to learn anchors before writing course.json)', async (t) => {
  const root = copyFixture(t);
  fs.rmSync(path.join(root, 'course.json'));
  fs.rmSync(path.join(root, 'lessons'), { recursive: true });
  const { exitCode, receipt } = await runFinalize({ file: path.join(root, 'learndoc.json') });
  assert.equal(exitCode, 0);
  assert.equal(Object.hasOwn(receipt, 'commit'), false, 'only lesson targets commit');
  const index = readJson(path.join(root, '.learndoc', 'refs', 'notes.json'));
  assert.deepEqual(index.anchors.map((entry) => entry.anchor), ['preamble', 'vectors', 'inner-product', 'norms', 'duong-thang-mat-phang']);
  assert.notEqual(git(root, 'rev-parse', '--verify', 'HEAD').status, 0);
});

test('validate failure: receipt names the failed stage and suggests an in-place edit', async (t) => {
  const root = copyFixture(t);
  const file = path.join(root, 'lessons', 'intro.json');
  const lesson = readJson(file);
  lesson.blocks[1].sources = ['ghost#p1'];
  lesson.blocks[2].variant = 'mystery';
  writeJson(file, lesson);
  const { exitCode, receipt } = await runFinalize({ file });
  assert.equal(exitCode, 1);
  assert.equal(receipt.status, 'fail');
  assert.equal(receipt.failedStage, 'validate');
  assert.deepEqual(receipt.gates, { validate: 'fail', render: 'not-run', check: 'not-run', 'browser-check': 'not-run' });
  assert.deepEqual(codes(receipt.diagnostics), ['refs/unknown-alias', 'box/unknown-variant']);
  assert.deepEqual(receipt.nextAction, {
    action: 'edit-in-place',
    file,
    constraint: "Apply each diagnostic's supportedFixes (or the fix its message names) to the existing file; keep block ids and unaffected content unchanged; do not rewrite the whole file.",
    then: 'finalize-once',
  });
  assert.equal(receipt.artifact, undefined);
});

test('check failure stops before browser-check; diagnostics are capped at 8 with a summary', async (t) => {
  const root = copyFixture(t);
  const file = path.join(root, 'lessons', 'intro.json');
  const lesson = readJson(file);
  lesson.blocks[1].html = `<p>${Array.from({ length: 12 }, (_, i) => `<a href="#gone-${i}">x</a>`).join(' ')} $\\frac{$</p>`;
  writeJson(file, lesson);
  const { receipt } = await runFinalize({ file });
  assert.equal(receipt.failedStage, 'check');
  assert.equal(receipt.gates['browser-check'], 'not-run');
  assert.equal(receipt.diagnostics.length, 8);
  assert.deepEqual(receipt.diagnosticSummary, { total: 13, shown: 8, truncated: true, omittedByCode: { 'links/unknown-anchor': 5 } });
  assert.deepEqual(codes(receipt.diagnostics).slice(0, 2), ['links/unknown-anchor', 'math/katex'], 'one of each code first');
  assert.equal(receipt.nextAction.action, 'edit-in-place');
});

test('config and course targets run validate and check only', async (t) => {
  const root = copyFixture(t);
  const config = await runFinalize({ file: path.join(root, 'learndoc.json') });
  assert.equal(config.receipt.status, 'pass');
  assert.deepEqual(config.receipt.gates, { validate: 'pass', render: 'skipped', check: 'pass', 'browser-check': 'skipped' });
  const coursePath = path.join(root, 'course.json');
  const course = readJson(coursePath);
  course.modules[0].lessons[1].prereq = ['ghost'];
  writeJson(coursePath, course);
  const { exitCode, receipt } = await runFinalize({ file: coursePath });
  assert.equal(exitCode, 1);
  assert.equal(receipt.failedStage, 'check');
  assert.deepEqual(codes(receipt.diagnostics), ['course/unknown-prereq']);
});

test('JSON parse errors report line and column', async (t) => {
  const root = copyFixture(t);
  const file = path.join(root, 'lessons', 'intro.json');
  fs.writeFileSync(file, '{\n  "schemaVersion": 1,\n  "id": "intro" "x"\n}\n');
  const { receipt } = await runFinalize({ file });
  assert.deepEqual(codes(receipt.diagnostics), ['json/parse']);
  assert.equal(receipt.diagnostics[0].evidence.line, 3);
});

test('files outside a project, or misplaced, fail with project/layout', async (t) => {
  const root = copyFixture(t);
  fs.mkdirSync(path.join(root, 'nested', 'lessons'), { recursive: true });
  const misplaced = path.join(root, 'nested', 'lessons', 'intro.json');
  fs.copyFileSync(path.join(root, 'lessons', 'intro.json'), misplaced);
  assert.deepEqual(codes((await runFinalize({ file: misplaced })).receipt.diagnostics), ['project/layout']);
  fs.rmSync(path.join(root, 'learndoc.json'));
  assert.deepEqual(codes((await runFinalize({ file: path.join(root, 'course.json') })).receipt.diagnostics), ['project/layout']);
});

test('unsupported or missing targets are usage errors', async (t) => {
  const root = copyFixture(t);
  await assert.rejects(runFinalize({ file: path.join(root, 'references', 'notes.md') }), UsageError);
  await assert.rejects(runFinalize({ file: path.join(root, 'lessons', 'ghost.json') }), UsageError);
});

test('CLI: --json prints one receipt line; exit codes 0/1/2/64', (t) => {
  const root = copyFixture(t);
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const skipped = run(['finalize', path.join(root, 'lessons', 'intro.json'), '--json'], { LEARNDOC_CHROME: '' });
  assert.equal(skipped.status, 2);
  const lines = skipped.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.status, 'skipped');
  assert.equal(receipt.gates['browser-check'], 'skipped');
  assert.deepEqual(codes(receipt.diagnostics), ['browser/chrome-missing']);
  assert.equal(run(['finalize', path.join(root, 'learndoc.json'), '--json']).status, 0);
  assert.match(run(['finalize', path.join(root, 'learndoc.json')]).stdout, /^finalize pass: /);
  assert.equal(run(['finalize']).status, 64);
  assert.equal(run(['finalize', 'a.json', 'b.json']).status, 64);
  assert.equal(run(['finalize', path.join(root, 'learndoc.json'), '--bogus']).status, 64);
  assert.equal(run(['finalize', path.join(root, 'README.md')]).status, 64);
  assert.equal(run(['nope']).status, 64);
  const bad = path.join(root, 'learndoc.json');
  writeJson(bad, { schemaVersion: 2 });
  assert.equal(run(['finalize', bad, '--json']).status, 1);
});
