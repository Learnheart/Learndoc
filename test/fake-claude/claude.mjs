// Fake `claude -p` for tests; `--version` just prints a version. FAKE_CLAUDE_SCENARIO is the path
// of a JSON file `{ "responses": [Response, ...] }`; call n uses responses[n] (the last one repeats).
// Response: { structured_output?, result?, is_error?, sleepMs?, exitCode?, stdout?, stderr?, stream? }
// With --output-format stream-json (what the server uses) the output is one JSON event per line:
// system init, message_start, the `stream` steps, then the result event. stream: [{ thinking } |
// { text } | { json } | { pauseMs }] emits deltas (or waits silently) in order.
// Every call is appended to `<scenario>.calls.jsonl` as { pid, args, prompt, sessionEnv } (sessionEnv:
// names of Claude Code session variables the call inherited).

import fs from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('2.1.285 (Claude Code, fake)\n');
  process.exit(0);
}

const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
if (!scenarioPath) {
  process.stderr.write('FAKE_CLAUDE_SCENARIO is not set\n');
  process.exit(2);
}

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', async () => {
  const prompt = Buffer.concat(chunks).toString('utf8');
  const callsPath = `${scenarioPath}.calls.jsonl`;
  const n = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).length : 0;
  const sessionEnv = Object.keys(process.env).filter((k) => /^CLAUDE(CODE$|_CODE_SESSION|_CODE_CHILD|_EFFORT)/.test(k));
  fs.appendFileSync(callsPath, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), prompt, sessionEnv }) + '\n');

  const { responses } = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  const r = responses[Math.min(n, responses.length - 1)];
  if (r.sleepMs) await new Promise((res) => setTimeout(res, r.sleepMs));
  if (r.stderr) process.stderr.write(r.stderr);
  const streaming = process.argv[process.argv.indexOf('--output-format') + 1] === 'stream-json';
  const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const event = (e) => line({ type: 'stream_event', event: e });
  if (r.stdout !== undefined) process.stdout.write(r.stdout);
  else {
    if (streaming) {
      line({ type: 'system', subtype: 'init', session_id: 'fake' });
      event({ type: 'message_start', message: { usage: { output_tokens: 1 } } });
      let block = null;
      for (const step of r.stream ?? []) {
        if (step.pauseMs) {
          await new Promise((res) => setTimeout(res, step.pauseMs));
          continue;
        }
        const kind = step.thinking !== undefined ? 'thinking' : step.text !== undefined ? 'text' : 'tool_use';
        if (block !== kind) {
          if (block) event({ type: 'content_block_stop' });
          event({ type: 'content_block_start', content_block: { type: kind } });
          block = kind;
        }
        event({ type: 'content_block_delta', delta: kind === 'thinking' ? { type: 'thinking_delta', thinking: step.thinking }
          : kind === 'text' ? { type: 'text_delta', text: step.text } : { type: 'input_json_delta', partial_json: step.json } });
      }
      if (block) event({ type: 'content_block_stop' });
      event({ type: 'message_delta', usage: { output_tokens: 20 } });
      event({ type: 'message_stop' });
    }
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: Boolean(r.is_error), duration_ms: 1234,
      num_turns: 1, result: r.result ?? '', session_id: 'fake', total_cost_usd: 0.0123,
      usage: { input_tokens: 10, output_tokens: 20 },
      ...(r.structured_output !== undefined && { structured_output: r.structured_output }),
    }));
  }
  process.exit(r.exitCode ?? 0);
});
