// Git helpers. All paths are relative to `cwd` (the project root, which may sit inside a larger repo).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(cwd, args, { input } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
    error.status = result.status;
    throw error;
  }
  return result.stdout;
}

export function isInsideWorkTree(cwd) {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === 'true';
}

export function init(cwd) {
  git(cwd, ['init', '--quiet']);
}

// Commits exactly `paths` (staged or not, new or tracked); anything else already staged stays staged
// and out of this commit. -> commit hash, or null when those paths have no changes to commit
export function commitPaths(cwd, paths, message) {
  git(cwd, ['add', '--', ...paths]);
  const unchanged = spawnSync('git', ['diff', '--cached', '--quiet', '--', ...paths], { cwd }).status === 0;
  if (unchanged) return null;
  git(cwd, ['commit', '--quiet', '--only', '-m', message, '--', ...paths]);
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

// -> [{ commit, date, summary }] newest first, for commits touching `file`.
export function log(cwd, file, { limit = 50 } = {}) {
  let out;
  try {
    out = git(cwd, ['log', `--max-count=${limit}`, '--format=%H%x1f%cI%x1f%s', '--', file]);
  } catch (error) {
    if (/does not have any commits/.test(error.message)) return [];
    throw error;
  }
  return out.split('\n').filter(Boolean).map((line) => {
    const [commit, date, summary] = line.split('\x1f');
    return { commit, date, summary };
  });
}

// -> Set of the commits that added `file` (no earlier version of it exists before them); empty without commits.
export function commitsAdding(cwd, file) {
  try {
    return new Set(git(cwd, ['log', '--diff-filter=A', '--format=%H', '--', file]).split('\n').filter(Boolean));
  } catch (error) {
    if (/does not have any commits/.test(error.message)) return new Set();
    throw error;
  }
}

const relativeTo = (cwd, file) => path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join('/');

// Content of `file` at revision `rev` (a commit, or e.g. `<commit>^`).
export function showFile(cwd, file, rev) {
  return git(cwd, ['show', `${rev}:./${relativeTo(cwd, file)}`]);
}

// Restores `file` to its content at `commit` and commits that single path.
// -> new commit hash, or null when the file already has that content
export function revert(cwd, file, commit, message) {
  const relative = relativeTo(cwd, file);
  const content = showFile(cwd, relative, commit);
  fs.writeFileSync(path.resolve(cwd, file), content);
  return commitPaths(cwd, [relative], message);
}
