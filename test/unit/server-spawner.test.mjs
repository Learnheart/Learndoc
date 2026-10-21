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
