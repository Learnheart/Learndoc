// Apply a changeset (Claude's edit output) to a copy of a lesson, and describe the result.
// Isomorphic: no node: imports.

const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const indexOf = (blocks, id) => blocks.findIndex((b) => b.id === id);
const failure = (code, message) => ({ error: { code, message } });
const unknownBlock = (id, what = '') => failure('unknown_block', `${what}no block "${id}"`);

function withId(id, block) {
  const { id: _ignored, ...rest } = block;
  return { id, ...rest };
}

// Index after which to place a block: -1 for the start (`after: null`), null when unknown.
function anchorAt(blocks, afterId) {
  if (afterId === null) return -1;
  const at = indexOf(blocks, afterId);
  return at < 0 ? null : at;
}

// Each op mutates `blocks` and returns { blockId, before, after } or { error: { code, message } }.
const OPS = {
  replace(blocks, change) {
    const at = indexOf(blocks, change.blockId);
    if (at < 0) return unknownBlock(change.blockId);
    if (!change.block) return failure('missing_field', 'replace needs "block"');
    const before = blocks[at];
    blocks[at] = withId(before.id, change.block);
    return { blockId: before.id, before, after: blocks[at] };
  },

  // Inserts sharing an anchor keep their listed order: each goes after the previous one.
  insert(blocks, change, { newId, lastInsertAfter }) {
    if (!change.block || change.after === undefined) return failure('missing_field', 'insert needs "after" and "block"');
    const key = change.after ?? '';
    const afterId = lastInsertAfter.get(key) ?? change.after;
    const at = anchorAt(blocks, afterId);
    if (at === null) return unknownBlock(afterId, 'after: ');
    const id = change.blockId ?? uniqueId(newId, blocks);
    if (indexOf(blocks, id) >= 0) return failure('duplicate_id', `block id "${id}" already exists`);
    const block = withId(id, change.block);
    blocks.splice(at + 1, 0, block);
    lastInsertAfter.set(key, id);
    return { blockId: id, before: null, after: block };
  },

  delete(blocks, change) {
    const at = indexOf(blocks, change.blockId);
    if (at < 0) return unknownBlock(change.blockId);
    const [before] = blocks.splice(at, 1);
    return { blockId: before.id, before, after: null };
  },

  move(blocks, change) {
    const at = indexOf(blocks, change.blockId);
    if (at < 0) return unknownBlock(change.blockId);
    if (change.after === undefined) return failure('missing_field', 'move needs "after"');
    if (change.after === change.blockId) return failure('invalid_move', 'a block cannot move after itself');
    const [block] = blocks.splice(at, 1);
    const target = anchorAt(blocks, change.after);
    if (target === null) {
      blocks.splice(at, 0, block);
      return unknownBlock(change.after, 'after: ');
    }
    blocks.splice(target + 1, 0, block);
    return { blockId: block.id, before: block, after: block };
  },
};

// Every change is applied independently; a change that cannot be applied is reported
// in `errors` and skipped. An `insert` that already carries `blockId` reuses that id
// (the store pins ids this way so re-applying a round is deterministic); otherwise
// `newId()` assigns one.
export function applyChangeset(lesson, changeset, { newId }) {
  const result = clone(lesson);
  const applied = [];
  const errors = [];
  const state = { newId, lastInsertAfter: new Map() }; // anchor key -> id of the last block inserted after it

  for (const [index, change] of (changeset.changes ?? []).entries()) {
    const op = Object.hasOwn(OPS, change.op) ? OPS[change.op] : null;
    const outcome = op ? op(result.blocks, change, state) : failure('unknown_op', `unknown op "${change.op}"`);
    if (outcome.error) {
      errors.push({ index, op: change.op, blockId: change.blockId ?? null, ...outcome.error });
    } else {
      applied.push({ index, op: change.op, role: change.role ?? 'primary', group: change.group ?? null, reason: change.reason ?? '', ...outcome });
    }
  }

  applyNotation(result, changeset.notation);
  return { lesson: result, applied: withPositions(applied, lesson, result), errors };
}

function uniqueId(newId, blocks) {
  for (;;) {
    const id = newId();
    if (!blocks.some((b) => b.id === id)) return id;
  }
}

function applyNotation(lesson, notation) {
  if (!notation) return;
  const table = { ...(lesson.notation ?? {}) };
  for (const key of notation.remove ?? []) delete table[key];
  Object.assign(table, notation.set ?? {});
  lesson.notation = table;
}

// position = index in the resulting lesson; for a deleted block, the index it would
// occupy (just after the nearest surviving block that preceded it in the base lesson).
function withPositions(applied, base, result) {
  const finalIndex = new Map(result.blocks.map((b, i) => [b.id, i]));
  const baseIds = base.blocks.map((b) => b.id);
  const deletedPosition = (id) => {
    for (let i = baseIds.indexOf(id) - 1; i >= 0; i--) {
      if (finalIndex.has(baseIds[i])) return finalIndex.get(baseIds[i]) + 1;
    }
    return 0;
  };
  return applied.map((a) => ({
    ...a,
    position: a.op === 'delete' ? deletedPosition(a.blockId) : finalIndex.get(a.blockId) ?? null,
  }));
}

// Counts per op; a replace that leaves the base block unchanged is not counted.
export function summarizeChanges(baseLesson, applied) {
  const counts = { replace: 0, insert: 0, delete: 0, move: 0 };
  const baseById = new Map(baseLesson.blocks.map((b) => [b.id, b]));
  for (const a of applied) {
    if (a.op === 'replace' && same(baseById.get(a.blockId), a.after)) continue;
    counts[a.op] += 1;
  }
  return counts;
}

export function excludeGroups(changeset, groupIds) {
  const excluded = new Set(groupIds ?? []);
  return { ...changeset, changes: (changeset.changes ?? []).filter((c) => !c.group || !excluded.has(c.group)) };
}

// Net changes from `base` to `result` (for showing several refine rounds as one changeset
// relative to the original lesson). Role, group and reason come from the latest applied
// entry that touched the block (`appliedRounds` is ordered oldest first).
export function diffLessons(base, result, appliedRounds) {
  const attribution = new Map();
  appliedRounds.forEach((applied, round) => {
    for (const a of applied) attribution.set(a.blockId, { ...a, round: round + 1 });
  });
  const baseById = new Map(base.blocks.map((b) => [b.id, b]));
  const resultIds = new Set(result.blocks.map((b) => b.id));
  const moved = movedIds(base, result);
  const net = [];
  const entry = (op, blockId, before, after, position) => {
    const a = attribution.get(blockId);
    net.push({
      index: a?.index ?? null, round: a?.round ?? null, op, blockId, role: a?.role ?? 'primary',
      group: a?.group ?? null, reason: a?.reason ?? '', before, after, position,
    });
  };

  const emitDeletedAfter = (baseIndex, position) => {
    for (let i = baseIndex + 1; i < base.blocks.length && !resultIds.has(base.blocks[i].id); i++) {
      entry('delete', base.blocks[i].id, base.blocks[i], null, position);
    }
  };
  emitDeletedAfter(-1, 0);
  result.blocks.forEach((block, position) => {
    const before = baseById.get(block.id);
    // A block that was moved and edited reports as a replace at its new position.
    if (!before) entry('insert', block.id, null, block, position);
    else if (!same(before, block)) entry('replace', block.id, before, block, position);
    else if (moved.has(block.id)) entry('move', block.id, before, block, position);
    if (before) emitDeletedAfter(base.blocks.indexOf(before), position + 1);
  });
  return net;
}

// Blocks present in both lessons whose relative order changed: everything outside the
// longest common subsequence of the shared ids.
function movedIds(base, result) {
  const shared = new Set(result.blocks.map((b) => b.id));
  const a = base.blocks.map((b) => b.id).filter((id) => shared.has(id));
  const inBase = new Set(a);
  const b = result.blocks.map((x) => x.id).filter((id) => inBase.has(id));
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keep = new Set();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { keep.add(a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return new Set(a.filter((id) => !keep.has(id)));
}
