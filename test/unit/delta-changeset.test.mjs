import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChangeset, summarizeChanges, excludeGroups, diffLessons } from '../../delta/changeset.mjs';

const p = (id, text) => ({ id, type: 'prose', html: `<p>${text}</p>`, sources: ['notes#a'] });
const lesson = () => ({
  schemaVersion: 1, id: 'l', title: 'L', notation: { x: 'old' },
  blocks: [p('b-aaaa', 'A'), p('b-bbbb', 'B'), p('b-cccc', 'C')],
});
const ids = (l) => l.blocks.map((b) => b.id);
const counter = () => { let n = 0; return () => `b-new${++n}`; };
const block = (text) => ({ type: 'prose', html: `<p>${text}</p>`, sources: ['notes#a'] });

test('replace keeps the id and ignores an id inside block', () => {
  const base = lesson();
  const { lesson: out, applied, errors } = applyChangeset(base, {
    changes: [{ op: 'replace', blockId: 'b-bbbb', role: 'primary', block: { ...block('B2'), id: 'b-zzzz' }, reason: 'r' }],
  }, { newId: counter() });
  assert.deepEqual(errors, []);
  assert.deepEqual(ids(out), ['b-aaaa', 'b-bbbb', 'b-cccc']);
  assert.equal(out.blocks[1].html, '<p>B2</p>');
  assert.equal(base.blocks[1].html, '<p>B</p>', 'base lesson is not mutated');
  assert.equal(applied[0].before.html, '<p>B</p>');
  assert.equal(applied[0].position, 1);
});

test('insert after null and after an id; same anchor keeps listed order; server assigns ids', () => {
  const { lesson: out, applied, errors } = applyChangeset(lesson(), {
    changes: [
      { op: 'insert', after: null, role: 'primary', block: block('first') },
      { op: 'insert', after: 'b-bbbb', role: 'primary', block: block('x1') },
      { op: 'insert', after: 'b-bbbb', role: 'primary', block: block('x2') },
    ],
  }, { newId: counter() });
  assert.deepEqual(errors, []);
  assert.deepEqual(ids(out), ['b-new1', 'b-aaaa', 'b-bbbb', 'b-new2', 'b-new3', 'b-cccc']);
  assert.deepEqual(applied.map((a) => [a.blockId, a.position]), [['b-new1', 0], ['b-new2', 3], ['b-new3', 4]]);
});

test('insert reuses a pinned blockId and skips colliding generated ids', () => {
  const ids_ = ['b-aaaa', 'b-fresh'];
  const { lesson: out } = applyChangeset(lesson(), {
    changes: [
      { op: 'insert', after: 'b-cccc', role: 'primary', block: block('p'), blockId: 'b-pinned' },
      { op: 'insert', after: 'b-cccc', role: 'primary', block: block('q') },
    ],
  }, { newId: () => ids_.shift() });
  assert.deepEqual(ids(out), ['b-aaaa', 'b-bbbb', 'b-cccc', 'b-pinned', 'b-fresh']);
});

test('delete and move', () => {
  const { lesson: out, applied } = applyChangeset(lesson(), {
    changes: [
      { op: 'delete', blockId: 'b-aaaa', role: 'related', reason: 'dup' },
      { op: 'move', blockId: 'b-cccc', after: null, role: 'related', reason: 'order' },
    ],
  }, { newId: counter() });
  assert.deepEqual(ids(out), ['b-cccc', 'b-bbbb']);
  assert.equal(applied[0].op, 'delete');
  assert.equal(applied[0].after, null);
  assert.equal(applied[0].position, 0);
  assert.equal(applied[1].position, 0);
});

test('unknown ids, bad ops and missing fields are errors; other changes still apply', () => {
  const { lesson: out, errors } = applyChangeset(lesson(), {
    changes: [
      { op: 'replace', blockId: 'b-nope', role: 'primary', block: block('x') },
      { op: 'insert', after: 'b-nope', role: 'primary', block: block('x') },
      { op: 'move', blockId: 'b-aaaa', after: 'b-nope', role: 'primary' },
      { op: 'delete', blockId: 'b-cccc', role: 'primary' },
      { op: 'rename', blockId: 'b-aaaa', role: 'primary' },
      { op: 'replace', blockId: 'b-aaaa', role: 'primary' },
    ],
  }, { newId: counter() });
  assert.deepEqual(errors.map((e) => [e.index, e.code]), [
    [0, 'unknown_block'], [1, 'unknown_block'], [2, 'unknown_block'], [4, 'unknown_op'], [5, 'missing_field'],
  ]);
  assert.deepEqual(ids(out), ['b-aaaa', 'b-bbbb'], 'failed move leaves the block in place');
});

test('notation set and remove', () => {
  const { lesson: out } = applyChangeset(lesson(), { changes: [], notation: { set: { y: 'new' }, remove: ['x'] } }, { newId: counter() });
  assert.deepEqual(out.notation, { y: 'new' });
});

test('summarizeChanges skips no-op replaces; excludeGroups drops whole groups', () => {
  const base = lesson();
  const cs = {
    summary: 's',
    changes: [
      { op: 'replace', blockId: 'b-aaaa', role: 'primary', block: block('A') },
      { op: 'replace', blockId: 'b-bbbb', role: 'related', group: 'g-1', block: block('B2'), reason: 'r' },
      { op: 'delete', blockId: 'b-cccc', role: 'related', group: 'g-1', reason: 'r' },
      { op: 'insert', after: null, role: 'primary', block: block('n') },
    ],
  };
  const { applied } = applyChangeset(base, cs, { newId: counter() });
  assert.deepEqual(summarizeChanges(base, applied), { replace: 1, insert: 1, delete: 1, move: 0 });
  const kept = excludeGroups(cs, ['g-1']);
  assert.equal(kept.summary, 's');
  assert.deepEqual(kept.changes.map((c) => c.op), ['replace', 'insert']);
});

test('diffLessons reports net changes over several rounds relative to the base', () => {
  const base = lesson();
  const newId = counter();
  const r1 = applyChangeset(base, {
    changes: [
      { op: 'replace', blockId: 'b-aaaa', role: 'primary', block: block('A1'), reason: 'one' },
      { op: 'insert', after: 'b-cccc', role: 'primary', block: block('N') },
    ],
  }, { newId });
  const r2 = applyChangeset(r1.lesson, {
    changes: [
      { op: 'replace', blockId: 'b-aaaa', role: 'primary', block: block('A'), reason: 'undo' },
      { op: 'delete', blockId: 'b-bbbb', role: 'related', reason: 'dup' },
      { op: 'move', blockId: 'b-new1', after: null, role: 'related', reason: 'mv' },
    ],
  }, { newId });
  const net = diffLessons(base, r2.lesson, [r1.applied, r2.applied]);
  assert.deepEqual(net.map((c) => [c.op, c.blockId, c.position, c.round]), [
    ['insert', 'b-new1', 0, 2],
    ['delete', 'b-bbbb', 2, 2],
  ]);
});

test('diffLessons: a block moved and edited reports as replace at its new position', () => {
  const base = lesson();
  const r = applyChangeset(base, {
    changes: [
      { op: 'move', blockId: 'b-cccc', after: null, role: 'primary' },
      { op: 'replace', blockId: 'b-cccc', role: 'primary', block: block('C2') },
    ],
  }, { newId: counter() });
  const net = diffLessons(base, r.lesson, [r.applied]);
  assert.deepEqual(net.map((c) => [c.op, c.blockId, c.position, c.before.html, c.after.html]), [['replace', 'b-cccc', 0, '<p>C</p>', '<p>C2</p>']]);
});

