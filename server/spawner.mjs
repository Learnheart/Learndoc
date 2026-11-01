// Runs `claude -p` with a JSON schema and returns its structured output. The CLI streams its events
// (stream-json), so a call is stopped only when it goes silent for idleTimeoutMs (stalled) or runs
// past the timeoutMs cap; a long call that keeps thinking or writing is left to finish.

import { spawn } from 'node:child_process';
import path from 'node:path';

export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 3 * 60_000;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const KILL_GRACE_MS = 3_000;
// Variables a Claude Code session sets for its own children: a server started from inside a session
// must not hand them on, or `claude -p` acts as that session's child (and its effort leaks in).
const SESSION_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT',
];

function claudeArgs({ model, schemaText, skillDir, effort }) {
  return [
    '-p',
    '--model', model,
    ...(effort ? ['--effort', effort] : []),
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--json-schema', schemaText,
    '--tools', '',
    '--strict-mcp-config',
    '--append-system-prompt-file', path.join(skillDir, 'references', 'edit-contract.md'),
    '--no-session-persistence',
  ];
}

function childEnv() {
  const env = { ...process.env };
  for (const name of SESSION_ENV) delete env[name];
  return env;
}

// -> { done: Promise<{ ok, value, costUsd, durationMs, error?, raw? }>, cancel() }
// error = { code: 'cli_error'|'api_error'|'no_structured_output'|'timeout'|'stalled'|'cancelled', message }
// onProgress(progress) runs on every streamed event, progress = { phase: 'starting'|'thinking'|'writing',
//   thinkingChars, outputChars, outputTokens?, lastEventAt } (outputTokens once the CLI reports usage).
export function runClaude({ prompt, model, schemaText, skillDir, cwd, effort, timeoutMs, idleTimeoutMs, onProgress }) {
  timeoutMs ??= DEFAULT_TIMEOUT_MS;
  idleTimeoutMs ??= DEFAULT_IDLE_TIMEOUT_MS;
  const bin = process.env.LEARNDOC_CLAUDE_BIN || 'claude';
  const started = Date.now();
  const child = spawn(bin, claudeArgs({ model, schemaText, skillDir, effort }), { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  const progress = { phase: 'starting', thinkingChars: 0, outputChars: 0, lastEventAt: started };
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
  let idleTimer = null;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop('stalled'), idleTimeoutMs);
    idleTimer.unref();
  };
  touch();

  const done = new Promise((resolve) => {
    const lines = new LineReader();
    let result = null;
    let lastLines = [];
    const err = [];
    child.stdout.on('data', (d) => {
      touch();
      for (const line of lines.push(d)) {
        lastLines = [...lastLines, line].slice(-5);
        const event = parseLine(line);
        if (!event) continue;
        if (event.type === 'result') result = event;
        if (track(progress, event)) {
          progress.lastEventAt = Date.now();
          const { outputTokensBefore, ...shown } = progress;
          onProgress?.(shown);
        }
      }
    });
    child.stderr.on('data', (d) => err.push(d));
    child.stdin.on('error', () => {}); // child may exit before reading stdin (EPIPE)
    const finish = (outcome) => {
      clearTimeout(timer);
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      resolve(outcome);
    };
    child.on('error', (e) => finish(failure('cli_error', `cannot run ${bin}: ${e.message}`, Date.now() - started)));
    child.on('close', (code) => {
      const elapsed = Date.now() - started;
      if (stopReason === 'timeout') return finish(failure('timeout', `claude did not finish within ${Math.round(timeoutMs / 1000)} s`, elapsed));
      if (stopReason === 'stalled') return finish(failure('stalled', `claude sent nothing for ${Math.round(idleTimeoutMs / 1000)} s and was stopped`, elapsed));
      if (stopReason === 'cancelled') return finish(failure('cancelled', 'cancelled', elapsed));
      const rest = lines.flush();
      if (rest) {
        lastLines = [...lastLines, rest].slice(-5);
        const event = parseLine(rest);
        if (event?.type === 'result') result = event;
      }
      if (result) return finish(parseOutcome(result, elapsed));
      const detail = Buffer.concat(err).toString('utf8').trim() || lastLines.join('\n').trim() || `exit code ${code}`;
      finish(failure('cli_error', detail.slice(0, 2000), elapsed));
    });
  });

  child.stdin.end(prompt);
  return { done, cancel: () => stop('cancelled') };
}

// Splits a byte stream into lines (UTF-8 safe across chunks).
class LineReader {
  constructor() {
    this.decoder = new TextDecoder();
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop();
    return parts.filter((l) => l.trim());
  }

  flush() {
    const rest = (this.buffer + this.decoder.decode()).trim();
    this.buffer = '';
    return rest;
  }
}

function parseLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// Folds one stream event into `progress`; true when it is model activity worth reporting.
function track(progress, event) {
  if (event.type !== 'stream_event' || !event.event) return false;
  const e = event.event;
  if (e.type === 'content_block_start') {
    progress.phase = ['thinking', 'redacted_thinking'].includes(e.content_block?.type) ? 'thinking' : 'writing';
  } else if (e.type === 'content_block_delta') {
    const d = e.delta ?? {};
    if (d.type === 'thinking_delta') {
      progress.phase = 'thinking';
      progress.thinkingChars += d.thinking?.length ?? 0;
    } else if (d.type === 'text_delta' || d.type === 'input_json_delta') {
      progress.phase = 'writing';
      progress.outputChars += (d.text ?? d.partial_json ?? '').length;
    }
  } else if (e.type === 'message_delta' && typeof e.usage?.output_tokens === 'number') {
    progress.outputTokens = (progress.outputTokensBefore ?? 0) + e.usage.output_tokens;
  } else if (e.type === 'message_stop') {
    // A structured answer can take more than one model turn; tokens add up across them.
    progress.outputTokensBefore = progress.outputTokens;
  } else if (e.type !== 'message_start' && e.type !== 'content_block_stop') {
    return false;
  }
  return true;
}

function failure(code, message, durationMs) {
  return { ok: false, value: null, costUsd: 0, durationMs, error: { code, message } };
}

// The final `result` event. `subtype` says "success" even on API errors, so it is ignored.
function parseOutcome(raw, elapsedMs) {
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
