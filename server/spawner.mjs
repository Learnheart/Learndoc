// Runs `claude -p` with a JSON schema and returns its structured output.

import { spawn } from 'node:child_process';
import path from 'node:path';

const TIMEOUT_MS = 150_000;
const KILL_GRACE_MS = 3_000;

function claudeArgs({ model, schemaText, skillDir }) {
  return [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--json-schema', schemaText,
    '--tools', '',
    '--strict-mcp-config',
    '--append-system-prompt-file', path.join(skillDir, 'references', 'edit-contract.md'),
    '--no-session-persistence',
  ];
}

// -> { done: Promise<{ ok, value, costUsd, durationMs, error?, raw? }>, cancel() }
// error = { code: 'cli_error'|'api_error'|'no_structured_output'|'timeout'|'cancelled', message }
export function runClaude({ prompt, model, schemaText, skillDir, cwd, timeoutMs = TIMEOUT_MS }) {
  const bin = process.env.LEARNDOC_CLAUDE_BIN || 'claude';
  const started = Date.now();
  const child = spawn(bin, claudeArgs({ model, schemaText, skillDir }), { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stopReason = null;
  let killTimer = null;

  const stop = (reason) => {
    if (stopReason || child.exitCode !== null || child.signalCode !== null) return;
    stopReason = reason;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    killTimer.unref();
  };
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  timer.unref();

  const done = new Promise((resolve) => {
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.stdin.on('error', () => {}); // child may exit before reading stdin (EPIPE)
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(failure('cli_error', `cannot run ${bin}: ${e.message}`, Date.now() - started));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      const elapsed = Date.now() - started;
      if (stopReason === 'timeout') return resolve(failure('timeout', `claude did not finish within ${timeoutMs / 1000} s`, elapsed));
      if (stopReason === 'cancelled') return resolve(failure('cancelled', 'cancelled', elapsed));
      resolve(parseOutcome(code, Buffer.concat(out).toString('utf8'), Buffer.concat(err).toString('utf8'), elapsed));
    });
  });

  child.stdin.end(prompt);
  return { done, cancel: () => stop('cancelled') };
}

function failure(code, message, durationMs) {
  return { ok: false, value: null, costUsd: 0, durationMs, error: { code, message } };
}

// `subtype` says "success" even on API errors, so it is ignored.
function parseOutcome(exitCode, stdout, stderr, elapsedMs) {
  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    return failure('cli_error', detail.slice(0, 2000), elapsedMs);
  }
  const costUsd = typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : 0;
  const durationMs = typeof raw.duration_ms === 'number' ? raw.duration_ms : elapsedMs;
  const base = { costUsd, durationMs, raw };
  if (raw.is_error) return { ...failure('api_error', String(raw.result ?? 'API error'), durationMs), ...base };
  const value = raw.structured_output;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const prose = String(raw.result ?? '').slice(0, 2000);
    return { ...failure('no_structured_output', prose || 'claude returned no structured output', durationMs), ...base };
  }
  return { ok: true, value, ...base };
}
