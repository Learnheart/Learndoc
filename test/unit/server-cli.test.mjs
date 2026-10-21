import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_ROOT, makeProject, request, waitFor } from '../fake-claude/harness.mjs';

const runServe = (cwd, args, env = process.env) => spawnSync(process.execPath, [path.join(SKILL_ROOT, 'bin/learndoc.mjs'), 'serve', '--no-open', ...args], { cwd, env, encoding: 'utf8', timeout: 20_000 });

const serve = (cwd, ...args) => {
  const r = runServe(cwd, args);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'prints one JSON line');
  return JSON.parse(lines[0]);
};

test('serve starts a detached server once, then reuses it; SIGTERM removes server.json', async () => {
  const root = makeProject();
  const stateFile = path.join(root, '.learndoc/server.json');
  fs.mkdirSync(path.join(root, '.learndoc'));
  fs.writeFileSync(path.join(root, '.learndoc/server.log'), '', { mode: 0o644 });
  const first = serve(path.join(root, 'lessons'), '--lesson', '01-intro');
  let info;
  try {
    assert.equal(first.ok, true);
    assert.equal(first.reused, false);
    info = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual([info.pid, info.port, info.projectRoot], [first.pid, first.port, root]);
    assert.match(info.token, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    assert.equal(first.url, `http://127.0.0.1:${first.port}/?t=${info.token}`);
    assert.equal(first.lessonUrl, `http://127.0.0.1:${first.port}/lessons/01-intro?t=${info.token}`);
    assert.equal((await request(first.port, { path: '/api/health' })).json.pid, first.pid);

    const reusedRun = runServe(root, [], { ...process.env, LEARNDOC_CLAUDE_BIN: path.join(root, 'no-such-claude') });
    assert.equal(JSON.parse(reusedRun.stdout).reused, true, 'reusing a live server skips the preflight');
    const second = serve(root);
    assert.deepEqual([second.reused, second.pid, second.port, second.url], [true, first.pid, first.port, first.url]);
    assert.equal(second.lessonUrl, undefined);
  } finally {
    process.kill(first.pid, 'SIGTERM');
  }
  await waitFor(() => !fs.existsSync(stateFile), { what: 'server.json removal' });
  const logFile = path.join(root, '.learndoc/server.log');
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /"ok":true/);
  assert.ok(!log.includes(info.token), 'the token never reaches server.log');
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
});

test('a stale server.json is replaced by a new server', async () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, '.learndoc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.learndoc/server.json'), JSON.stringify({ pid: 999999, port: 1, token: 'x', projectRoot: root }));
  const started = serve(root);
  try {
    assert.equal(started.reused, false);
    assert.notEqual(started.pid, 999999);
  } finally {
    process.kill(started.pid, 'SIGTERM');
  }
});

test('preflight: a missing claude binary is reported before anything starts', () => {
  const root = makeProject();
  const r = runServe(root, [], { ...process.env, LEARNDOC_CLAUDE_BIN: path.join(root, 'no-such-claude') });
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'env/claude');
  assert.match(out.error.fix, /LEARNDOC_CLAUDE_BIN/);
  assert.equal(fs.existsSync(path.join(root, '.learndoc/server.json')), false);
});
