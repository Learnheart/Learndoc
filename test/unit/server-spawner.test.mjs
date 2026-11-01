import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SKILL_ROOT as ROOT, scenario } from '../fake-claude/harness.mjs';
import { runClaude } from '../../server/spawner.mjs';

const run = (opts = {}) => runClaude({ prompt: 'PROMPT TEXT', model: 'sonnet', schemaText: '{"type":"object"}', skillDir: ROOT, cwd: ROOT, ...opts });

test('ok: structured_output, cost, duration; prompt via stdin; flags', async () => {
  const s = scenario([{ structured_output: { summary: 's', changes: [] } }]);
  const r = await run().done;
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { summary: 's', changes: [] });
  assert.equal(r.costUsd, 0.0123);
  assert.equal(r.durationMs, 1234);
  const [call] = s.calls();
  assert.equal(call.prompt, 'PROMPT TEXT');
  assert.deepEqual(call.args.slice(0, 3), ['-p', '--model', 'sonnet']);
  assert.equal(call.args[call.args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(call.args.includes('--verbose') && call.args.includes('--include-partial-messages'));
  assert.ok(!call.args.includes('--effort'), 'no --effort unless configured');
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.ok(call.args.includes('--strict-mcp-config') && call.args.includes('--no-session-persistence'));
  assert.equal(call.args[call.args.indexOf('--append-system-prompt-file') + 1], path.join(ROOT, 'references/edit-contract.md'));
});

test('is_error with subtype success is an api_error', async () => {
  scenario([{ is_error: true, result: 'API Error: 529 overloaded' }]);
  const r = await run().done;
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'api_error');
  assert.match(r.error.message, /overloaded/);
});

test('missing structured_output carries the prose result', async () => {
  scenario([{ result: 'I cannot satisfy that schema.' }]);
  const r = await run().done;
  assert.equal(r.error.code, 'no_structured_output');
  assert.match(r.error.message, /cannot satisfy/);
});

test('non-zero exit with empty stdout is a cli_error with stderr', async () => {
  scenario([{ stdout: '', stderr: 'Error: invalid --json-schema', exitCode: 1 }]);
  const r = await run().done;
  assert.equal(r.error.code, 'cli_error');
  assert.match(r.error.message, /invalid --json-schema/);
});

test('cancel kills a running call; timeout stops it too', async () => {
  scenario([{ sleepMs: 20_000, structured_output: {} }]);
  const started = Date.now();
  const call = run();
  setTimeout(call.cancel, 300);
  assert.equal((await call.done).error.code, 'cancelled');
  const timed = await run({ timeoutMs: 300 }).done;
  assert.equal(timed.error.code, 'timeout');
  assert.ok(Date.now() - started < 10_000);
});

test('streamed progress: phases, character and token counts; --effort passed on', async () => {
  const s = scenario([{ structured_output: { summary: 's' }, stream: [{ thinking: 'Let me think.' }, { thinking: ' More.' }, { json: '{"summary":' }, { json: '"s"}' }] }]);
  const seen = [];
  const r = await run({ effort: 'high', onProgress: (p) => seen.push(p) }).done;
  assert.equal(r.ok, true, r.error?.message);
  assert.deepEqual(r.value, { summary: 's' });
  const [call] = s.calls();
  assert.equal(call.args[call.args.indexOf('--effort') + 1], 'high');
  assert.deepEqual([...new Set(seen.map((p) => p.phase))], ['starting', 'thinking', 'writing']);
  const last = seen.at(-1);
  assert.equal(last.thinkingChars, 'Let me think. More.'.length);
  assert.equal(last.outputChars, '{"summary":"s"}'.length);
  assert.equal(last.outputTokens, 20);
  assert.equal(typeof last.lastEventAt, 'number');
  assert.ok(!('outputTokensBefore' in last));
});

test('a long call that keeps streaming runs past the idle limit; a silent one is stopped as stalled', async () => {
  const steps = Array.from({ length: 8 }, () => [{ pauseMs: 150 }, { thinking: '…' }]).flat();
  scenario([{ structured_output: { summary: 'done' }, stream: steps }]);
  const active = await run({ idleTimeoutMs: 600 }).done;
  assert.equal(active.ok, true, active.error?.message);
  assert.ok(active.durationMs > 0);

  scenario([{ structured_output: { summary: 'late' }, stream: [{ thinking: 'start' }, { pauseMs: 5000 }] }]);
  const started = Date.now();
  const stalled = await run({ idleTimeoutMs: 400 }).done;
  assert.equal(stalled.error.code, 'stalled');
  assert.match(stalled.error.message, /sent nothing for \d+ s/);
  assert.ok(Date.now() - started < 4000, 'stopped well before the pause ends');
});

test('Claude Code session variables are not passed on to claude -p', async () => {
  const s = scenario([{ structured_output: {} }]);
  const saved = { ...process.env };
  Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_EFFORT: 'low' });
  try {
    assert.equal((await run().done).ok, true);
  } finally {
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_EFFORT']) {
      if (k in saved) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
  assert.deepEqual(s.calls()[0].sessionEnv, []);
});

test('output with no result event is a cli_error showing the last lines', async () => {
  scenario([{ stdout: '{"type":"system","subtype":"init"}\nsomething went wrong\n', exitCode: 1 }]);
  const r = await run().done;
  assert.equal(r.error.code, 'cli_error');
  assert.match(r.error.message, /something went wrong/);
});
