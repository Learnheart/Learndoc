// Test helpers: a git-committed copy of a fixture project, fake-claude scenarios, HTTP requests.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

Object.assign(process.env, {
  LEARNDOC_CLAUDE_BIN: path.join(SKILL_ROOT, 'test/fake-claude/claude'),
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
});

export const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// Copy of test/fixtures/<name> in a temp dir, committed to a fresh repository.
export function makeProject(name = 'edit-basic') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ld-proj-'));
  fs.cpSync(path.join(SKILL_ROOT, 'test/fixtures', name), root, { recursive: true });
  git(root, 'init', '--quiet');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'init');
  return root;
}

// Writes a fake-claude scenario and points FAKE_CLAUDE_SCENARIO at it.
export function scenario(responses) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ld-fake-')), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify({ responses }));
  process.env.FAKE_CLAUDE_SCENARIO = file;
  const callsFile = `${file}.calls.jsonl`;
  return {
    calls: () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

export async function waitFor(check, { timeoutMs = 10_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Raw HTTP so tests control Host, Origin and Cookie. -> { status, headers, body, json }
export function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: Object.fromEntries(Object.entries({ host: `127.0.0.1:${port}`, ...(data && { 'content-type': 'application/json' }), ...headers })
        .filter(([, v]) => v !== undefined)),
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
