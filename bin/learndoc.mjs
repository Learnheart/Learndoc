#!/usr/bin/env node
// Internal learndoc CLI, called by Claude (per SKILL.md) and by the edit server — not by users.
import { runFinalize, UsageError } from '../lib/finalize.mjs';
import { SERVE_USAGE, runServe } from '../server/cli.mjs';

const EXIT_USAGE = 64;

const COMMAND_USAGE = {
  finalize: '<learndoc.json|course.json|lessons/<id>.json> [--json]',
  serve: SERVE_USAGE,
};

function usage() {
  const commands = Object.entries(COMMAND_USAGE).map(([command, form]) => `  learndoc ${command} ${form}`);
  return `Usage:\n${commands.join('\n')}\n`;
}

function fail(message) {
  console.error(message);
  process.exit(EXIT_USAGE);
}

function printHuman(receipt) {
  const lines = [`finalize ${receipt.status}: ${receipt.target.path}`];
  lines.push(`  gates: ${Object.entries(receipt.gates).map(([stage, status]) => `${stage}=${status}`).join(' ')}`);
  for (const entry of receipt.diagnostics) {
    lines.push(`  [${entry.severity}] ${entry.code}: ${entry.message}`);
    for (const fix of entry.supportedFixes) lines.push(`      fix: ${fix}`);
  }
  if (receipt.diagnosticSummary.truncated) {
    lines.push(`  … ${receipt.diagnosticSummary.total - receipt.diagnosticSummary.shown} more diagnostic(s)`);
  }
  if (receipt.artifact) lines.push(`  page: ${receipt.artifact.path}`);
  console.log(lines.join('\n'));
}

async function commandFinalize(args) {
  const json = args.includes('--json');
  const positional = args.filter((arg) => arg !== '--json');
  const unknown = positional.filter((arg) => arg.startsWith('-'));
  if (unknown.length) fail(`finalize: unknown option ${unknown[0]}\n\n${usage()}`);
  if (positional.length !== 1) fail(`finalize needs exactly one file\n\n${usage()}`);
  let result;
  try {
    result = await runFinalize({ file: positional[0] });
  } catch (error) {
    if (error instanceof UsageError) fail(`finalize: ${error.message}\n\n${usage()}`);
    throw error;
  }
  if (json) console.log(JSON.stringify(result.receipt));
  else printHuman(result.receipt);
  process.exitCode = result.exitCode;
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case undefined:
  case '-h':
  case '--help':
  case 'help':
    console.log(usage());
    break;
  case 'finalize':
    await commandFinalize(args);
    break;
  case 'serve':
    await runServe(args);
    break;
  default:
    fail(`Unknown command "${command}".\n\n${usage()}`);
}
