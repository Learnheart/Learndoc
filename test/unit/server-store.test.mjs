import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, makeProject, scenario, waitFor } from '../fake-claude/harness.mjs';
import { Store } from '../../server/store.mjs';
import { ensureChunks } from '../../lib/refs.mjs';

const LESSON = '01-intro';
const sel = (blockId, exact, field = 'html') => ({ focusBlockIds: [blockId], ranges: [{ blockId, field, quote: { exact, prefix: '', suffix: '' } }] });
const prose = (html) => ({ type: 'prose', html, sources: ['notes#basics'] });
const replaceProse = (html, extra = {}) => ({ op: 'replace', blockId: 'b-prose1', role: 'primary', block: prose(html), reason: 'asked', ...extra });
const ORIGINAL = '<p>A vector $\\mathbf{x}$ has a <strong>length</strong> and a direction.</p>';

async function setup(responses) {
  const root = makeProject();
  await ensureChunks(root, JSON.parse(fs.readFileSync(path.join(root, 'learndoc.json'), 'utf8')));
  const fake = scenario(responses);
  const store = new Store({ root });
  const settle = (id) => waitFor(() => store.get(id).status !== 'running' && store.view(id), { what: `changeset ${id} to settle` });
  const lessonOnDisk = () => JSON.parse(fs.readFileSync(path.join(root, 'lessons', `${LESSON}.json`), 'utf8'));
  return { root, fake, store, settle, lessonOnDisk };
}

test('replace → ready with preview, context pack contents, outside_focus warning', async () => {
  const { store, fake, settle } = await setup([{ structured_output: {
    summary: 'Explain length as norm.',
    changes: [replaceProse('<p>A vector $\\mathbf{x}$ has a <strong>norm</strong> and an orientation.</p>')],
  } }]);
  const id = store.startEdit({ lessonId: LESSON, mode: 'replace', instruction: 'say norm', selection: sel('b-prose1', 'length') });
  const view = await settle(id);
  assert.equal(view.status, 'ready', view.error);
  assert.equal(view.round, 1);
  assert.deepEqual(view.counts, { replace: 1, insert: 0, delete: 0, move: 0 });
  assert.equal(view.changes[0].before.html, ORIGINAL);
  assert.match(view.preview.blocks[1].html, /norm/);
  assert.deepEqual(view.warnings, [
    { code: 'outside_focus', blockId: 'b-prose1', message: 'b-prose1: text outside the selection changed' },
  ]);
  assert.equal(view.usage.costUsd, 0.0123);

  const { prompt, args } = fake.calls()[0];
  assert.match(prompt, /<strong>⟦focus⟧length⟦\/focus⟧<\/strong>/);
  assert.match(prompt, /=== INBOUND ===\n- lesson 02-next, block b-next1 \(links lesson:01-intro#basics; uses notation \\mathbf\{x\}\)/);
  assert.match(prompt, /=== REFERENCES ===\n--- notes#basics ---\n[\s\S]*never negative/);
  assert.match(prompt, /"vector-plane":\{"type":"object"/);
  assert.match(prompt, /"maxRelated":2/);
  assert.match(prompt, /"math":true/);
  const cliSchema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.equal(cliSchema.title, 'Changeset');
  assert.equal(cliSchema.$schema, undefined, 'claude --json-schema rejects the 2020-12 $schema URI');
});

test('refine: rounds stack on the preview; changes stay relative to the original; accept commits only the lesson', async () => {
  const { root, store, fake, settle, lessonOnDisk } = await setup([
    { structured_output: { summary: 'Add an example.', changes: [{ op: 'insert', after: 'b-prose1', role: 'primary', block: prose('<p>Example: $[3,4]$.</p>') }] } },
    { structured_output: { summary: 'Retitle the box.', changes: [{ op: 'replace', blockId: 'b-box1', role: 'primary', block: { type: 'box', variant: 'note', title: 'Keep in mind', html: '<p>The length of $\\mathbf{x}$ is never negative.</p>', sources: ['notes#basics'] } }] } },
  ]);
  const id = store.startEdit({ lessonId: LESSON, mode: 'insert', instruction: 'add example', selection: sel('b-prose1', 'direction') });
  const first = await settle(id);
  assert.equal(first.status, 'ready', first.error);
  const newId = first.changes[0].blockId;
  assert.match(newId, /^b-[a-z0-9]{8}$/);
  assert.equal(store.view(id).changes[0].blockId, newId, 'inserted id is stable');

  store.refine(id, { instruction: 'rename the box', model: 'opus', selection: { focusBlockIds: ['b-box1'], ranges: [{ blockId: 'b-box1', whole: true }] } });
  const second = await settle(id);
  assert.equal(second.status, 'ready', second.error);
  assert.equal(second.round, 2);
  assert.deepEqual(second.changes.map((c) => [c.op, c.blockId]), [['insert', newId], ['replace', 'b-box1']]);
  const prompt2 = fake.calls()[1].prompt;
  assert.match(prompt2, /=== MODE ===\nreplace/);
  assert.equal(fake.calls()[1].args[fake.calls()[1].args.indexOf('--model') + 1], 'opus', 'refine can switch the model');
  assert.match(prompt2, /=== PREVIOUS ROUNDS ===[\s\S]*Round 1: Add an example\./);
  assert.ok(prompt2.includes(`"id":"${newId}"`), 'round 2 sees the preview');

  fs.writeFileSync(path.join(root, 'stray.txt'), 'not part of the commit');
  git(root, 'add', 'stray.txt');
  const result = await store.accept(id);
  assert.deepEqual(lessonOnDisk(), result.lesson);
  assert.deepEqual(result.lesson.blocks.map((b) => b.id), ['b-head1', 'b-prose1', newId, 'b-box1', 'b-plot1', 'b-quiz1']);
  assert.equal(git(root, 'log', '-1', '--format=%H %s').trim(), `${result.commit} learndoc: Retitle the box.`);
  assert.equal(git(root, 'show', '--name-only', '--format=', 'HEAD').trim(), 'lessons/01-intro.json');
  assert.match(git(root, 'diff', '--cached', '--name-only'), /stray\.txt/, 'other staged files stay staged');
  assert.equal(store.view(id).status, 'accepted');
  assert.equal(fs.readdirSync(path.join(root, '.learndoc/changesets')).length, 0, 'accepted changeset is not persisted');
});

test('one open changeset per lesson; stale lesson blocks accept; restart keeps open changesets', async () => {
  const { root, store, settle } = await setup([{ structured_output: { summary: 's', changes: [replaceProse('<p>Shorter.</p>')] } }]);
  const id = store.startEdit({ lessonId: LESSON, mode: 'replace', instruction: 'shorter', selection: sel('b-prose1', 'length') });
  assert.throws(() => store.startEdit({ lessonId: LESSON, mode: 'replace', instruction: 'x', selection: sel('b-prose1', 'length') }), { status: 409, code: 'changeset_open' });
  await settle(id);

  const reloaded = new Store({ root });
  reloaded.load();
  assert.equal(reloaded.view(id).status, 'ready');
  assert.equal(reloaded.view(id).preview.blocks[1].html, '<p>Shorter.</p>');

  const file = path.join(root, 'lessons', `${LESSON}.json`);
  fs.appendFileSync(file, '\n');
  await assert.rejects(store.accept(id), { status: 409, code: 'stale' });
});

test('cancel kills the running claude process', async () => {
  const { store, fake } = await setup([{ sleepMs: 30_000, structured_output: { summary: 's', changes: [] } }]);
  const id = store.startEdit({ lessonId: LESSON, mode: 'replace', instruction: 'x', selection: sel('b-prose1', 'length') });
  const { pid } = await waitFor(() => fake.calls()[0], { what: 'fake claude to start' });
  store.cancel(id);
  assert.equal(store.view(id).status, 'cancelled');
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, { what: 'claude process to exit' });
  assert.equal(store.openFor(LESSON), null);
});

test('ask stores a note, ends as answered, leaves the lesson alone and does not lock it', async () => {
  const { root, store, settle, lessonOnDisk } = await setup([{ structured_output: { answer: '<p>A norm is a length, see <a href="#basics">basics</a>.</p>', sources: ['notes#basics'] } }]);
  const before = lessonOnDisk();
  const id = store.startEdit({ lessonId: LESSON, mode: 'ask', instruction: 'Why never negative?', selection: sel('b-box1', 'never negative') });
  const view = await settle(id);
  assert.equal(view.status, 'answered', view.error);
  assert.equal(view.answer.sources[0], 'notes#basics');
  assert.deepEqual(view.changes, []);
  assert.deepEqual(lessonOnDisk(), before);
  const notes = JSON.parse(fs.readFileSync(path.join(root, '.learndoc/notes', `${LESSON}.json`), 'utf8'));
  assert.deepEqual(notes.map((n) => [n.id, n.blockId, n.question]), [[id, 'b-box1', 'Why never negative?']]);
  assert.equal(store.openFor(LESSON), null);
  store.cancel(id);
  assert.equal(store.view(id).status, 'answered', 'DELETE on a terminal changeset changes nothing');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.learndoc/notes', `${LESSON}.json`), 'utf8')).length, 1, 'note is kept');
  assert.deepEqual(notes[0].ranges, [{ blockId: 'b-box1', field: 'html', quote: { exact: 'never negative', prefix: '', suffix: '' } }], 'the note keeps its passage');

  assert.throws(() => store.deleteNote(LESSON, 'cs-other'), { code: 'not_found' });
  assert.deepEqual(store.deleteNote(LESSON, id), { ok: true });
  assert.deepEqual(store.notes(LESSON), []);
});

test('an ask answer outside the HTML whitelist is retried, then failed', async () => {
  const { store, fake, settle } = await setup([{ structured_output: { answer: '<p style="color:red">No <script>x()</script></p>', sources: [] } }]);
  const id = store.startEdit({ lessonId: LESSON, mode: 'ask', instruction: 'Why?', selection: sel('b-box1', 'never negative') });
  const view = await settle(id);
  assert.equal(view.status, 'failed');
  assert.equal(fake.calls().length, 2);
  assert.deepEqual([...new Set(view.diagnostics.map((d) => d.code))].sort(), ['html/attribute', 'html/tag']);
  assert.deepEqual(store.notes(LESSON), []);
});

test('a new block without sources is retried in a cited lesson, and accepted in an imported one', async () => {
  const insert = { op: 'insert', after: 'b-prose1', role: 'primary', block: { type: 'prose', html: '<p>Example: $[3,4]$.</p>' } };
  const responses = [{ structured_output: { summary: 'Add an example.', changes: [insert] } }, { structured_output: { summary: 'Add an example.', changes: [insert] } }];
  const cited = await setup(responses);
  const failed = await cited.settle(cited.store.startEdit({ lessonId: LESSON, mode: 'insert', instruction: 'example', selection: sel('b-prose1', 'length') }));
  assert.equal(failed.status, 'failed');
  assert.equal(cited.fake.calls().length, 2);
  assert.deepEqual([...new Set(failed.diagnostics.map((d) => d.code))], ['block/missing-sources']);

  const imported = await setup(responses.slice(0, 1));
  const file = path.join(imported.root, 'lessons', `${LESSON}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ ...imported.lessonOnDisk(), origin: { file: '../course/01-intro.html', sha256: 'a'.repeat(64) } }, null, 2)}\n`);
  const ready = await imported.settle(imported.store.startEdit({ lessonId: LESSON, mode: 'insert', instruction: 'example', selection: sel('b-prose1', 'length') }));
  assert.equal(ready.status, 'ready', ready.error);
  assert.equal(ready.preview.blocks[2].sources, undefined);
});

test('needsConfirmation → needs_confirmation; confirm re-runs with maxRelated raised to the scope', async () => {
  const scope = ['b-prose1', 'b-box1', 'b-quiz1', 'b-head1'];
  const related = (blockId, block) => ({ op: 'replace', blockId, role: 'related', group: 'g-term', block, reason: 'uses the old term' });
  const { store, fake, settle } = await setup([
    { structured_output: { summary: 'Rename length to norm everywhere.', needsConfirmation: { scope, reason: 'four blocks use the term' } } },
    { structured_output: { summary: 'Rename length to norm everywhere.', changes: [
      replaceProse('<p>A vector $\\mathbf{x}$ has a <strong>norm</strong> and a direction.</p>'),
      related('b-box1', { type: 'box', variant: 'note', title: 'Remember', html: '<p>The norm of $\\mathbf{x}$ is never negative.</p>', sources: ['notes#basics'] }),
      related('b-quiz1', { type: 'quiz', question: 'Can a norm be negative?', answer: '<p>No.</p>', sources: ['notes#basics'] }),
      related('b-head1', { type: 'heading', level: 2, anchor: 'basics', text: '1. Norm basics' }),
    ] } },
  ]);
  const id = store.startEdit({ lessonId: LESSON, mode: 'replace', instruction: 'call it norm', selection: sel('b-prose1', 'length') });
  const first = await settle(id);
  assert.equal(first.status, 'needs_confirmation');
  assert.deepEqual(first.needsConfirmation.scope, scope);

  store.confirm(id);
  const second = await settle(id);
  assert.equal(second.status, 'ready', JSON.stringify(second.diagnostics ?? second.error));
  assert.equal(second.counts.replace, 4);
  const prompt2 = fake.calls()[1].prompt;
  assert.match(prompt2, /"maxRelated":4/);
  assert.match(prompt2, /=== CONFIRMED ===\nThe user approved changing these blocks: b-prose1, b-box1, b-quiz1, b-head1/);

  assert.ok(second.changes.filter((c) => c.role === 'related').every((c) => c.group === 'r1:g-term'), 'group ids are namespaced by round');
  const kept = await store.accept(id, { excludeGroups: ['r1:g-term'] });
  assert.equal(kept.lesson.blocks.find((b) => b.id === 'b-box1').title, 'Remember', 'excluded group is not applied');
  assert.match(kept.lesson.blocks.find((b) => b.id === 'b-prose1').html, /norm/);
});

test('validation errors: one retry with diagnostics, then failed', async () => {
  const badAnchor = { op: 'replace', blockId: 'b-head1', role: 'primary', block: { type: 'heading', level: 2, anchor: 'renamed', text: 'Basics' } };
  const badHtml = replaceProse('<p onclick="x()">Hi <script>alert(1)</script></p>');
  const { store, fake, settle } = await setup([
    { structured_output: { summary: 'a', changes: [badAnchor, { op: 'replace', blockId: 'b-nope', role: 'related', block: prose('<p>x</p>') }] } },
    { structured_output: { summary: 'b', changes: [badHtml] } },
  ]);
  const id = store.startEdit({ lessonId: LESSON, mode: 'replace', instruction: 'x', selection: sel('b-head1', 'Basics', 'text') });
  const view = await settle(id);
  assert.equal(view.status, 'failed');
  assert.equal(fake.calls().length, 2);
  const retryPrompt = fake.calls()[1].prompt;
  assert.match(retryPrompt, /=== ERRORS ===/);
  assert.match(retryPrompt, /\[changeset\/anchor-changed\]/);
  assert.match(retryPrompt, /\[changeset\/unknown_block\]/);
  assert.match(retryPrompt, /\[changeset\/related-reason\]/);
  assert.ok(view.diagnostics.length > 0);
  assert.ok(view.diagnostics.every((d) => !d.code.startsWith('changeset/anchor')), 'diagnostics are from the second attempt');
  assert.equal(store.openFor(LESSON), null, 'a failed changeset without preview does not lock the lesson');
});

test('validation retry that succeeds; related count over maxRelated is an error', async () => {
  const related = (blockId) => ({ op: 'delete', blockId, role: 'related', reason: 'dup' });
  const { store, settle } = await setup([
    { structured_output: { summary: 'a', changes: [related('b-box1'), related('b-quiz1'), related('b-plot1')] } },
    { structured_output: { summary: 'b', changes: [related('b-box1')] } },
  ]);
  const id = store.startEdit({ lessonId: LESSON, mode: 'replace', instruction: 'x', selection: sel('b-prose1', 'length') });
  const view = await settle(id);
  assert.equal(view.status, 'ready', JSON.stringify(view.diagnostics));
  assert.deepEqual(view.counts, { replace: 0, insert: 0, delete: 1, move: 0 });
  assert.equal(view.summary, 'b');
});

test('deleting a heading that another lesson links to is a validation error', async () => {
  const del = { op: 'delete', blockId: 'b-head1', role: 'primary', reason: 'asked' };
  const { store, fake, settle } = await setup([{ structured_output: { summary: 'Drop the heading.', changes: [del] } }]);
  const id = store.startEdit({ lessonId: LESSON, mode: 'replace', instruction: 'remove heading', selection: sel('b-head1', 'Basics', 'text') });
  const view = await settle(id);
  assert.equal(view.status, 'failed');
  assert.equal(fake.calls().length, 2, 'retried once');
  assert.match(fake.calls()[1].prompt, /\[anchor\/referenced\] heading #basics \(b-head1\) is linked from lesson 02-next block b-next1/);
  assert.deepEqual(view.diagnostics.map((d) => d.code), ['anchor/referenced']);
});

test('an unreadable notes file reads as empty', async () => {
  const { root, store } = await setup([{ structured_output: {} }]);
  fs.mkdirSync(path.join(root, '.learndoc/notes'), { recursive: true });
  fs.writeFileSync(path.join(root, '.learndoc/notes', `${LESSON}.json`), '{ not json');
  assert.deepEqual(store.notes(LESSON), []);
});

test('restoreBefore commits the lesson as it was before a commit', async () => {
  const { root, store, settle, lessonOnDisk } = await setup([{ structured_output: { summary: 'Shorter.', changes: [replaceProse('<p>Shorter.</p>')] } }]);
  const original = lessonOnDisk();
  const id = store.startEdit({ lessonId: LESSON, mode: 'replace', instruction: 'shorter', selection: sel('b-prose1', 'length') });
  await settle(id);
  const { commit } = await store.accept(id);
  const history = store.history(LESSON);
  assert.deepEqual(history.map((h) => [h.commit === commit, h.restorable]), [[true, true], [false, false]], 'the commit that added the file is not restorable');
  assert.throws(() => store.restoreBefore(LESSON, history[1].commit), { status: 409, code: 'history/no-parent' });
  const restored = store.restoreBefore(LESSON, commit);
  assert.deepEqual(restored.lesson, original);
  assert.equal(git(root, 'log', '-1', '--format=%s').trim(), `learndoc: restore before ${commit.slice(0, 7)}`);
  assert.equal(git(root, 'show', '--name-only', '--format=', 'HEAD').trim(), 'lessons/01-intro.json');
  assert.throws(() => store.restoreBefore(LESSON, 'HEAD'), { status: 400 });
  const again = store.restoreBefore(LESSON, commit);
  assert.equal(again.commit, null, 'nothing to restore is a no-op');
  assert.deepEqual(again.lesson, original);
});

test('accepting a changeset that leaves the lesson as it is commits nothing', async () => {
  const { root, store, settle, lessonOnDisk } = await setup([{ structured_output: { summary: 'Same.', changes: [replaceProse(ORIGINAL)] } }]);
  const formatted = store.lesson(LESSON);
  fs.writeFileSync(formatted.file, `${JSON.stringify(formatted.lesson, null, 2)}\n`);
  git(root, 'commit', '--quiet', '-am', 'canonical format');
  const id = store.startEdit({ lessonId: LESSON, mode: 'replace', instruction: 'noop', selection: sel('b-prose1', 'length') });
  await settle(id);
  const head = git(root, 'rev-parse', 'HEAD').trim();
  const result = await store.accept(id);
  assert.equal(result.commit, null);
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), head);
  assert.deepEqual(lessonOnDisk(), formatted.lesson);
  assert.equal(store.view(id).status, 'accepted');
});

test('ask answers citing unknown aliases or anchors are retried, then failed', async () => {
  const { store, fake, settle } = await setup([
    { structured_output: { answer: '<p>See the definition.</p>', sources: ['lesson#b-def03'] } },
    { structured_output: { answer: '<p>See the notes.</p>', sources: ['notes#no-such-heading'] } },
  ]);
  const id = store.startEdit({ lessonId: LESSON, mode: 'ask', instruction: 'Why?', selection: sel('b-box1', 'never negative') });
  const view = await settle(id);
  assert.equal(view.status, 'failed');
  assert.match(fake.calls()[1].prompt, /\[refs\/unknown-alias\][^\n]*"lesson#b-def03"/);
  assert.deepEqual(view.diagnostics.map((d) => d.code), ['refs/unknown-anchor']);
  assert.deepEqual(store.notes(LESSON), []);
});

test('selection warnings carry a code and the block id', async () => {
  const { store, settle } = await setup([{ structured_output: { summary: 's', changes: [replaceProse('<p>New.</p>')] } }]);
  const id = store.startEdit({ lessonId: LESSON, mode: 'replace', instruction: 'x', selection: sel('b-prose1', 'not in the text') });
  const view = await settle(id);
  assert.deepEqual(view.warnings, [{
    code: 'selection_unresolved', blockId: 'b-prose1',
    message: 'the selection in b-prose1 could not be located; the whole block was used',
  }]);
});

test('refining a block this changeset inserted gives no outside_focus warning', async () => {
  const { store, settle } = await setup([
    { structured_output: { summary: 'Add an example.', changes: [{ op: 'insert', after: 'b-prose1', role: 'primary', block: prose('<p>Example one.</p>') }] } },
  ]);
  const id = store.startEdit({ lessonId: LESSON, mode: 'insert', instruction: 'add example', selection: sel('b-prose1', 'direction') });
  const inserted = (await settle(id)).changes[0].blockId;
  scenario([{ structured_output: { summary: 'Better example.', changes: [{ op: 'replace', blockId: inserted, role: 'primary', block: prose('<p>A sample, rewritten.</p>') }] } }]);
  store.refine(id, { instruction: 'reword', selection: sel(inserted, 'one') });
  const view = await settle(id);
  assert.equal(view.status, 'ready', view.error);
  assert.deepEqual(view.warnings, []);
});

test('lesson mode: no selection, the whole lesson in scope, refines stay whole-lesson', async () => {
  const { store, fake, settle } = await setup([
    { structured_output: { summary: 'Say norm throughout.', changes: [replaceProse('<p>A vector $\\mathbf{x}$ has a <strong>norm</strong> and a direction.</p>')] } },
    { structured_output: { summary: 'Retitle the box.', changes: [{ op: 'replace', blockId: 'b-box1', role: 'primary', block: { type: 'box', variant: 'note', title: 'Norm', html: '<p>The norm of $\\mathbf{x}$ is never negative.</p>', sources: ['notes#basics'] } }] } },
  ]);
  const id = store.startEdit({ lessonId: LESSON, mode: 'lesson', instruction: 'use "norm" everywhere' });
  const first = await settle(id);
  assert.equal(first.status, 'ready', first.error);
  assert.equal(first.mode, 'lesson');
  assert.deepEqual(first.warnings, [], 'no outside_focus warning without a selection');
  const { prompt } = fake.calls()[0];
  assert.match(prompt, /=== MODE ===\nlesson/);
  assert.match(prompt, /=== FOCUS ===\nNo selection: INSTRUCTION applies to the whole lesson\./);
  assert.ok(!prompt.includes('⟦focus⟧'), 'no focus markers');
  assert.match(prompt, /=== REFERENCES ===\n--- notes#basics ---/, 'sources cited anywhere in the lesson are included');

  store.refine(id, { instruction: 'also the box title' });
  const second = await settle(id);
  assert.equal(second.status, 'ready', second.error);
  assert.match(fake.calls()[1].prompt, /=== MODE ===\nlesson/);
  assert.match(fake.calls()[1].prompt, /=== FOCUS ===\nNo selection/);
  assert.deepEqual(second.changes.map((c) => c.blockId), ['b-prose1', 'b-box1']);
});
