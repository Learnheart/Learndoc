// Fake `claude -p` for tests; `--version` just prints a version. FAKE_CLAUDE_SCENARIO is the path
// of a JSON file `{ "responses": [Response, ...] }`; call n uses responses[n] (the last one repeats).
// Response: { structured_output?, result?, is_error?, sleepMs?, exitCode?, stdout?, stderr? }
// Every call is appended to `<scenario>.calls.jsonl` as { pid, args, prompt }.

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
  fs.appendFileSync(callsPath, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), prompt }) + '\n');

  const { responses } = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  const r = responses[Math.min(n, responses.length - 1)];
  if (r.sleepMs) await new Promise((res) => setTimeout(res, r.sleepMs));
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.stdout !== undefined) process.stdout.write(r.stdout);
  else {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: Boolean(r.is_error), duration_ms: 1234,
      num_turns: 1, result: r.result ?? '', session_id: 'fake', total_cost_usd: 0.0123,
      usage: { input_tokens: 10, output_tokens: 20 },
      ...(r.structured_output !== undefined && { structured_output: r.structured_output }),
    }));
  }
  process.exit(r.exitCode ?? 0);
});
