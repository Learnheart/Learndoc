// `learndoc serve`: reuse or start the project's edit server, then open the browser.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SKILL_ROOT, STATE_DIR, findProjectRoot } from '../lib/project.mjs';
import { startServer } from './server.mjs';

// --foreground runs the server in this process; it opens no browser and prints no token.
export const SERVE_USAGE = '[--lesson <id>] [--no-open] [--foreground] [--port N]';
const EXIT_USAGE = 64;
const START_TIMEOUT_MS = 10_000;
const MIN_NODE_MAJOR = 22;
const CLAUDE_CHECK_TIMEOUT_MS = 10_000;
const OPENERS = {
  darwin: (url) => ['open', [url]],
  win32: (url) => ['cmd', ['/c', 'start', '', url]],
};
const LESSON_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseArgs(args) {
  const opts = { open: true, foreground: false, port: 0, lesson: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-open') opts.open = false;
    else if (arg === '--foreground') opts.foreground = true;
    else if (arg === '--lesson' && LESSON_RE.test(args[i + 1] ?? '')) opts.lesson = args[++i];
    else if (arg === '--port' && /^\d{1,5}$/.test(args[i + 1] ?? '') && Number(args[i + 1]) < 65536) opts.port = Number(args[++i]);
    else return { error: `serve: invalid argument ${arg}` };
  }
  return { opts };
}

const statePaths = (root) => ({
  json: path.join(root, STATE_DIR, 'server.json'),
  log: path.join(root, STATE_DIR, 'server.log'),
});

function urls({ port, token }, lesson) {
  const base = `http://127.0.0.1:${port}`;
  return { url: `${base}/?t=${token}`, ...(lesson && { lessonUrl: `${base}/lessons/${lesson}?t=${token}` }) };
}

export async function runServe(args) {
  const { opts, error } = parseArgs(args);
  if (error) {
    console.error(`${error}\nUsage: learndoc serve ${SERVE_USAGE}`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.log(JSON.stringify({ ok: false, error: { code: 'project/missing', message: 'no learndoc.json in this directory or its parents', fix: 'run serve inside a learndoc project' } }));
    process.exitCode = 1;
    return;
  }
  if (opts.foreground) return runForeground(root, opts);

  let info = await liveServer(root);
  const reused = Boolean(info);
  if (!info) {
    // The environment is only checked when a new server has to start.
    const problem = preflight();
    if (problem) {
      console.log(JSON.stringify({ ok: false, error: problem }));
      process.exitCode = 1;
      return;
    }
    info = await spawnServer(root, opts);
  }
  if (!info) {
    console.log(JSON.stringify({ ok: false, error: { code: 'server/start', message: `the server did not start within ${START_TIMEOUT_MS / 1000} s`, fix: `see ${statePaths(root).log}` } }));
    process.exitCode = 1;
    return;
  }
  const links = urls(info, opts.lesson);
  if (opts.open) openBrowser(links.lessonUrl ?? links.url);
  console.log(JSON.stringify({ ok: true, ...links, pid: info.pid, port: info.port, reused }));
}

// The environment serve needs: a recent Node and a working claude binary (a browser is the OS default).
// -> null or { code, message, fix }
function preflight() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    return { code: 'env/node', message: `Node ${process.versions.node} is too old; learndoc serve needs Node ${MIN_NODE_MAJOR} or later`, fix: `install Node ${MIN_NODE_MAJOR}+ (for example from https://nodejs.org)` };
  }
  const bin = process.env.LEARNDOC_CLAUDE_BIN || 'claude';
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: CLAUDE_CHECK_TIMEOUT_MS });
  if (r.error || r.status !== 0) {
    const detail = r.error?.message ?? (r.stderr.trim() || `exit code ${r.status}`);
    return { code: 'env/claude', message: `\`${bin} --version\` failed: ${detail}`, fix: 'install Claude Code and log in (`claude`), or set LEARNDOC_CLAUDE_BIN to its path' };
  }
  return null;
}

// The token only goes to server.json (0600), never to stdout, which is server.log when detached.
async function runForeground(root, opts) {
  const { json } = statePaths(root);
  const { port, token, close } = await startServer({ root, port: opts.port });
  const info = { pid: process.pid, port, token, startedAt: new Date().toISOString(), projectRoot: root };
  fs.writeFileSync(json, JSON.stringify(info), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, pid: process.pid, port, stateFile: json }));

  const shutdown = async () => {
    try {
      if (readInfo(json)?.pid === process.pid) fs.rmSync(json, { force: true });
    } finally {
      await close();
      process.exit(0);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

function readInfo(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function getHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

// server.json describing a running, healthy server of this project, or null.
async function liveServer(root, pid) {
  const info = readInfo(statePaths(root).json);
  if (!info || (pid && info.pid !== pid) || !pidAlive(info.pid)) return null;
  const health = await getHealth(info.port);
  const ok = health?.ok && health.pid === info.pid && realpath(health.projectRoot) === realpath(root);
  return ok ? info : null;
}

async function spawnServer(root, opts) {
  const { log } = statePaths(root);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, 'a', 0o600);
  fs.fchmodSync(out, 0o600); // an existing log keeps its old mode otherwise
  const args = [path.join(SKILL_ROOT, 'bin', 'learndoc.mjs'), 'serve', '--foreground', ...(opts.port ? ['--port', String(opts.port)] : [])];
  const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.closeSync(out);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return null;
    const info = await liveServer(root, child.pid);
    if (info) return info;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function openBrowser(url) {
  const [cmd, args] = (OPENERS[process.platform] ?? ((u) => ['xdg-open', [u]]))(url);
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
