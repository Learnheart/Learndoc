#!/usr/bin/env node
// Internal learndoc CLI, called by Claude (per SKILL.md) and by the edit server — not by users.
import { runFinalize, UsageError } from '../lib/finalize.mjs';
import { runImport } from '../lib/import.mjs';
import { SERVE_USAGE, runServe } from '../server/cli.mjs';

const EXIT_USAGE = 64;

const COMMAND_USAGE = {
  finalize: '<learndoc.json|course.json|lessons/<id>.json> [--json]',
  import: '<source-dir> [--profile <file>] [--json]   (run in the new project folder)',
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

async function commandImport(args) {
  const json = args.includes('--json');
  const rest = args.filter((arg) => arg !== '--json');
  const profileAt = rest.indexOf('--profile');
  const profileFile = profileAt >= 0 ? rest[profileAt + 1] : undefined;
  if (profileAt >= 0 && (!profileFile || profileFile.startsWith('-'))) fail(`import: --profile needs a file\n\n${usage()}`);
  const positional = rest.filter((arg, i) => profileAt < 0 || (i !== profileAt && i !== profileAt + 1));
  const unknown = positional.filter((arg) => arg.startsWith('-'));
  if (unknown.length) fail(`import: unknown option ${unknown[0]}\n\n${usage()}`);
  if (positional.length !== 1) fail(`import needs exactly one source folder\n\n${usage()}`);
  let result;
  try {
    result = await runImport({ source: positional[0], profileFile });
  } catch (error) {
    if (error instanceof UsageError) fail(`import: ${error.message}\n\n${usage()}`);
    throw error;
  }
  const { receipt } = result;
  if (json) {
    console.log(JSON.stringify(receipt));
  } else {
    const lines = [`import ${receipt.status}: ${receipt.lessons.pass}/${receipt.lessons.total} lessons pass, `
      + `${receipt.pendingDemos.total} demo(s) pending (${receipt.pendingDemos.withCandidate} with a widget candidate)`];
    for (const entry of receipt.diagnostics) lines.push(`  [${entry.severity}] ${entry.code}: ${entry.message}`);
    if (receipt.report) lines.push(`  report: ${receipt.report}`);
    if (receipt.commit) lines.push(`  commit: ${receipt.commit}`);
    console.log(lines.join('\n'));
  }
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
  case 'import':
    await commandImport(args);
    break;
  case 'serve':
    await runServe(args);
    break;
  default:
    fail(`Unknown command "${command}".\n\n${usage()}`);
}
