// Git helpers. All paths are relative to `cwd` (the project root, which may sit inside a larger repo).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function git(cwd, args, { input, env } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', input, env, maxBuffer: 64 * 1024 * 1024 });
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

const historyError = (code, message) => Object.assign(new Error(message), { code });
// Rewriting reads the real objects, never `git replace` substitutes.
const HISTORY_ENV = () => ({ ...process.env, GIT_NO_REPLACE_OBJECTS: '1' });
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG'];

// The versions of `repoPath` (repo-relative) since it was last added, oldest first:
// [{ commit, mode, blob, status }], the first one being the add. Empty when it was never committed.
function fileVersions(top, repoPath, env) {
  let out;
  try {
    out = git(top, ['log', '--reverse', '--no-renames', '--raw', '--no-abbrev', '--format=%x00%H', 'HEAD', '--', repoPath], { env });
  } catch (error) {
    if (/does not have any commits|unknown revision/.test(error.message)) return [];
    throw error;
  }
  const versions = [];
  for (const chunk of out.split('\0').filter((c) => c.trim())) {
    const [commit, ...lines] = chunk.trim().split('\n');
    const raw = lines.find((l) => l.startsWith(':'));
    if (!raw) continue;
    const [, mode, , blob, status] = raw.slice(1).split('\t')[0].split(' ');
    versions.push({ commit, mode, blob, status: status[0] });
  }
  const added = versions.findLastIndex((v) => v.status === 'A');
  return added < 0 ? [] : versions.slice(added);
}

// -> the commits whose version of `file` can be dropped: every change since it was last added,
// except that add itself (dropFileVersions accepts exactly these).
export function droppableCommits(cwd, file) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const repoPath = git(cwd, ['rev-parse', '--show-prefix']).trim() + relativeTo(cwd, file);
  return fileVersions(top, repoPath, HISTORY_ENV()).slice(1).map((v) => v.commit);
}

// `git cat-file --batch` for many objects in one process. -> [{ id, type, data: Buffer }]
function readObjects(cwd, ids, env) {
  const out = spawnSync('git', ['cat-file', '--batch'], { cwd, env, input: ids.join('\n') + '\n', maxBuffer: 1024 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`git cat-file failed: ${out.stderr.toString().trim()}`);
  const objects = [];
  let at = 0;
  for (const id of ids) {
    const eol = out.stdout.indexOf(0x0a, at);
    const [, type, size] = out.stdout.subarray(at, eol).toString().split(' ');
    if (type === undefined || size === undefined) throw new Error(`git object ${id} is missing`);
    objects.push({ id, type, data: out.stdout.subarray(eol + 1, eol + 1 + Number(size)) });
    at = eol + 1 + Number(size) + 1;
  }
  return objects;
}

// A raw commit as latin1 text, so every byte survives a round trip whatever its encoding:
// header lines (continuations kept with their header) and the message.
function parseCommit(id, data) {
  const text = data.toString('latin1');
  const split = text.indexOf('\n\n');
  const headers = [];
  for (const line of (split < 0 ? text : text.slice(0, split)).split('\n')) {
    if (line.startsWith(' ') && headers.length) headers[headers.length - 1] += `\n${line}`;
    else headers.push(line);
  }
  const field = (name) => headers.filter((h) => h.startsWith(`${name} `)).map((h) => h.slice(name.length + 1));
  const encoding = field('encoding')[0];
  return {
    id, headers, message: split < 0 ? '' : text.slice(split + 2), tree: field('tree')[0], parents: field('parent'),
    utf8: !encoding || /^utf-?8$/i.test(encoding),
  };
}

// The commit (bytes) with a new tree, new parents and `extra` lines appended to its message.
// A signature would no longer match, so it is dropped.
function rebuildCommit(commit, tree, parents, extra) {
  const rest = commit.headers.filter((h) => !/^(tree|parent|gpgsig|gpgsig-sha256) /.test(h));
  let message = commit.message;
  if (extra) message = `${message.replace(/\n*$/, '')}\n\n${extra}\n`;
  return Buffer.from([`tree ${tree}`, ...parents.map((p) => `parent ${p}`), ...rest].join('\n') + `\n\n${message}`, 'latin1');
}

// Loose plus packed object size in bytes (`git count-objects -v`).
function objectBytes(cwd) {
  const fields = Object.fromEntries(git(cwd, ['count-objects', '-v']).trim().split('\n').map((l) => l.split(': ')));
  return (Number(fields.size ?? 0) + Number(fields['size-pack'] ?? 0) + Number(fields['size-garbage'] ?? 0)) * 1024;
}

const isAncestor = (top, a, b, env) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: top, env }).status === 0;

// Removes saved versions of `file` from the current branch's history. For every commit in `drop`
// (one of droppableCommits) the version just before it stops existing: its change is folded into
// the previous commit that changed the file, and a commit left with no change disappears, its
// subject added to the message of the nearest earlier remaining commit that changes the file.
// The tip's tree, the index and the working tree stay exactly as they were; commits from the
// first rewritten one on get new hashes (other files' commits too, kept byte for byte otherwise).
// Then the reflog entries of the replaced commits are deleted and only the objects that nothing
// else reaches any more are pruned: everything that was already unreachable (reset-away commits,
// dropped stashes) is kept, as are all other reflog entries.
// Refuses (error.code), changing nothing, when another ref, worktree or stash entry still holds the
// commits (`history/shared`), the history since the file was added has merges (`history/merges`),
// the repo is shallow (`history/unsupported`), a commit is not droppable (`history/unknown`), or a
// merge, rebase, cherry-pick, revert or bisect is in progress (`history/busy`).
// Cleanup runs after the branch moved, so a cleanup failure is reported, not thrown.
// -> { removedCommits, freedBytes, retainedVersions, cleanupError? }
export function dropFileVersions(cwd, file, drop) {
  const env = HISTORY_ENV();
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const g = (args, opts = {}) => git(top, args, { env, ...opts });
  const repoPath = git(cwd, ['rev-parse', '--show-prefix']).trim() + relativeTo(cwd, file);
  for (const name of IN_PROGRESS) {
    if (fs.existsSync(path.resolve(top, g(['rev-parse', '--git-path', name]).trim()))) {
      throw historyError('history/busy', 'a git merge, rebase, cherry-pick, revert or bisect is in progress');
    }
  }
  if (g(['rev-parse', '--is-shallow-repository']).trim() === 'true') throw historyError('history/unsupported', 'the repository is a shallow clone');
  // Pins left by an interrupted cleanup (see pruneReplaced) would otherwise hold old commits.
  const stale = g(['for-each-ref', '--format=%(refname)', 'refs/learndoc-keep/']).split('\n').filter(Boolean);
  if (stale.length) g(['update-ref', '--stdin'], { input: stale.map((ref) => `delete ${ref}\n`).join('') });
  const head = g(['rev-parse', 'HEAD']).trim();
  const symbolic = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: top, env, encoding: 'utf8' });
  const branch = symbolic.status === 0 ? symbolic.stdout.trim() : null;

  const versions = fileVersions(top, repoPath, env);
  if (!versions.length) throw historyError('history/unknown', `${repoPath} has no commit that added it`);
  if (versions.some((v) => v.status === 'D')) throw historyError('history/unsupported', `${repoPath} is deleted at HEAD`);
  const added = versions[0].commit;
  if (g(['rev-list', '--merges', `${added}..HEAD`]).trim()) {
    throw historyError('history/merges', `the history of ${repoPath} has merge commits; it can only be rewritten when linear`);
  }
  const chain = [added, ...g(['rev-list', '--reverse', `${added}..HEAD`]).split('\n').filter(Boolean)];
  const commits = readObjects(top, chain, env).map((o) => parseCommit(o.id, o.data));
  const position = new Map(chain.map((c, i) => [c, i]));
  const changes = versions.map((v) => position.get(v.commit));
  if (changes.some((i) => i === undefined)) throw historyError('history/unsupported', `the history of ${repoPath} is not a single line`);

  // version[i]: index (in `versions`) of the version in effect at commit i.
  const version = [];
  for (let i = 0, k = -1; i < chain.length; i++) version.push(changes[k + 1] === i ? ++k : k);
  const dropped = new Set();
  for (const commit of drop) {
    const k = versions.findIndex((v) => v.commit === commit);
    if (k < 1) throw historyError('history/unknown', `${commit.slice(0, 7)} is not a change to ${repoPath} after it was added`);
    dropped.add(k);
  }
  // Version k survives unless the change right after it is dropped; then the next survivor stands in.
  const survivor = new Array(versions.length);
  for (let k = versions.length - 1; k >= 0; k--) survivor[k] = dropped.has(k + 1) ? survivor[k + 1] : k;
  const state = chain.map((_, i) => versions[survivor[version[i]]]);
  const same = (a, b) => a.blob === b.blob && a.mode === b.mode;

  const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'learndoc-index-')), 'index');
  const trees = new Map();
  const treeWith = (tree, { mode, blob }) => {
    const key = `${tree}:${mode}:${blob}`;
    if (!trees.has(key)) {
      const step = (args) => git(top, args, { env: { ...env, GIT_INDEX_FILE: index } }).trim();
      step(['read-tree', tree]);
      step(['update-index', '--add', '--cacheinfo', `${mode},${blob},${repoPath}`]);
      trees.set(key, step(['write-tree']));
    }
    return trees.get(key);
  };

  // Pass 1: every commit's new tree, and which commits are left with nothing to do.
  const newTrees = [];
  const gone = new Set();
  try {
    let parentTree = null;
    for (let i = 0; i < chain.length; i++) {
      const tree = same(state[i], versions[version[i]]) ? commits[i].tree : treeWith(commits[i].tree, state[i]);
      newTrees.push(tree);
      const wasEmpty = i > 0 && commits[i].tree === commits[i - 1].tree;
      if (i > 0 && !wasEmpty && tree === parentTree) gone.add(i);
      else parentTree = tree;
    }
  } finally {
    fs.rmSync(path.dirname(index), { recursive: true, force: true });
  }
  let start = newTrees.findIndex((tree, i) => tree !== commits[i].tree);
  if (start < 0 && !gone.size) return { removedCommits: 0, freedBytes: 0 };

  // A vanished commit's subject goes to the nearest earlier remaining commit that changes the file.
  const changesFile = (i) => i === 0 || !same(state[i], state[i - 1]);
  const extra = new Map();
  for (const i of gone) {
    let j = i - 1;
    while (gone.has(j) || !changesFile(j)) j--;
    if (!commits[i].utf8 || !commits[j].utf8) continue;
    extra.set(j, [extra.get(j), commits[i].message.split('\n')[0]].filter(Boolean).join('\n'));
    start = Math.min(start < 0 ? j : start, j);
  }
  start = Math.min(start < 0 ? Infinity : start, ...gone);

  // Nothing else may still hold the commits being replaced: other refs, worktrees, older stashes.
  const first = chain[start];
  const holders = g(['for-each-ref', '--contains', first, '--format=%(refname)']).split('\n').filter((r) => r && r !== branch);
  for (const block of g(['worktree', 'list', '--porcelain']).split('\n\n')) {
    const wtHead = block.match(/^HEAD ([0-9a-f]+)$/m)?.[1];
    const wtPath = block.match(/^worktree (.+)$/m)?.[1];
    if (wtHead && wtPath && path.resolve(wtPath) !== path.resolve(top) && isAncestor(top, first, wtHead, env)) holders.push(`worktree ${wtPath}`);
  }
  if (spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/stash'], { cwd: top, env }).status === 0) {
    g(['reflog', 'show', '--format=%H', 'refs/stash']).split('\n').filter(Boolean)
      .forEach((stash, n) => { if (isAncestor(top, first, stash, env)) holders.push(`stash@{${n}}`); });
  }
  if (holders.length) throw historyError('history/shared', `these still hold the commits: ${[...new Set(holders)].join(', ')}`);

  // Pass 2: write the commits from `start` on.
  const mapped = new Map();
  for (let i = start; i < chain.length; i++) {
    const commit = commits[i];
    const parents = commit.parents.map((p) => mapped.get(p) ?? p);
    if (gone.has(i)) {
      mapped.set(commit.id, parents[0]);
      continue;
    }
    const raw = rebuildCommit(commit, newTrees[i], parents, extra.get(i));
    try {
      mapped.set(commit.id, g(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: raw }).trim());
    } catch (error) {
      // git refuses to write a copy of a malformed commit (a bad timezone, say); nothing has moved yet.
      throw historyError('history/unsupported', `commit ${commit.id.slice(0, 7)} cannot be rewritten: ${error.message}`);
    }
  }
  const newHead = mapped.get(head);
  if (g(['rev-parse', `${newHead}^{tree}`]).trim() !== g(['rev-parse', `${head}^{tree}`]).trim()) {
    throw new Error('rewritten history does not end at the current tree; nothing was changed');
  }
  const reason = `learndoc: drop history of ${repoPath}`;
  const rewrittenAt = new Date();
  if (branch) g(['update-ref', '-m', reason, branch, newHead, head]);
  else g(['update-ref', '--no-deref', '-m', reason, 'HEAD', newHead, head]);

  const result = { removedCommits: gone.size, freedBytes: 0, retainedVersions: 0 };
  try {
    result.freedBytes = pruneReplaced(top, g, new Set(chain.slice(start)), head, branch, rewrittenAt);
    // A dropped version whose content is still stored is held by something we must not delete
    // (a reflog entry or an unreachable commit built on the old history): report it.
    const kept = new Set(state.map((v) => v.blob));
    const removed = [...dropped].map((k) => versions[k - 1].blob).filter((blob) => !kept.has(blob));
    result.retainedVersions = [...new Set(removed)].filter((blob) => spawnSync('git', ['cat-file', '-e', blob], { cwd: top, env }).status === 0).length;
  } catch (error) {
    result.cleanupError = error.message;
  }
  return result;
}

// Frees what the old commits held and nothing else. -> bytes freed
function pruneReplaced(top, g, replaced, oldHead, branch, rewrittenAt) {
  const before = objectBytes(top);
  // Only the reflog entries of replaced commits go (oldest first, so the remaining indexes stay
  // valid); --rewrite points the next entry's old value past them, or the old tip stays reachable.
  for (const ref of ['HEAD', branch].filter(Boolean)) {
    const entries = g(['reflog', 'show', '--format=%H', ref]).split('\n').filter(Boolean);
    for (let n = entries.length - 1; n >= 0; n--) if (replaced.has(entries[n])) g(['reflog', 'delete', '--rewrite', `${ref}@{${n}}`]);
  }
  const origHead = spawnSync('git', ['rev-parse', '-q', '--verify', 'ORIG_HEAD'], { cwd: top, encoding: 'utf8' }).stdout.trim();
  if (replaced.has(origHead)) g(['update-ref', '-d', 'ORIG_HEAD']);
  // Objects only the old history reaches. Every other unreachable tip (a reset-away commit, a
  // dropped stash) is pinned while pruning, which keeps everything it references too.
  const ours = new Set(g(['rev-list', '--objects', oldHead, '--not', '--all', '--reflog', '--indexed-objects'])
    .split('\n').filter(Boolean).map((l) => l.split(' ')[0]));
  // --connectivity-only: an unrelated malformed object must not stop the cleanup (and it is faster).
  const keep = g(['fsck', '--connectivity-only', '--dangling', '--no-progress'])
    .split('\n').map((l) => l.match(/^dangling \w+ ([0-9a-f]+)$/)?.[1]).filter((id) => id && !ours.has(id));
  const pins = keep.map((id) => `refs/learndoc-keep/${id}`);
  if (pins.length) g(['update-ref', '--stdin'], { input: pins.map((ref, i) => `create ${ref} ${keep[i]}\n`).join('') });
  try {
    g(['repack', '-a', '-d', '-q']);
    // Loose objects written after the rewrite (by another git process, say) are newer, so they stay.
    g(['prune', `--expire=${rewrittenAt.toISOString()}`]);
  } finally {
    if (pins.length) g(['update-ref', '--stdin'], { input: pins.map((ref) => `delete ${ref}\n`).join('') });
  }
  return Math.max(0, before - objectBytes(top));
}
