import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, makeProject, request, scenario, waitFor } from '../fake-claude/harness.mjs';
import { startServer } from '../../server/server.mjs';

let srv;
let root;
let cookie;
const writeHeaders = () => ({ cookie, 'x-learndoc-token': srv.token, origin: `http://127.0.0.1:${srv.port}` });
const editBody = {
  lessonId: '01-intro', mode: 'replace', instruction: 'say norm',
  selection: { focusBlockIds: ['b-prose1'], ranges: [{ blockId: 'b-prose1', field: 'html', quote: { exact: 'length', prefix: '', suffix: '' } }] },
};

before(async () => {
  root = makeProject();
  scenario([{ structured_output: { summary: 'Say norm.', changes: [{ op: 'replace', blockId: 'b-prose1', role: 'primary', block: { type: 'prose', html: '<p>A vector $\\mathbf{x}$ has a <strong>norm</strong> and a direction.</p>', sources: ['notes#basics'] }, reason: 'asked' }] } }]);
  srv = await startServer({ root, exportPages: true });
});
after(() => srv.close());

test('health and static files need no cookie; everything else does', async () => {
  const health = await request(srv.port, { path: '/api/health' });
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, pid: process.pid, projectRoot: root });
  assert.equal((await request(srv.port, { path: '/static/runtime/lesson.js' })).status, 200);
  for (const p of ['/api/lessons/01-intro', '/project/widgets/x.js']) {
    const res = await request(srv.port, { path: p });
    assert.equal(res.status, 403, p);
    assert.deepEqual(res.json, { error: { code: 'forbidden', message: 'forbidden' } });
  }
  // Pages explain how to get a session back (a standalone page links here without the token).
  for (const p of ['/', '/lessons/01-intro']) {
    const res = await request(srv.port, { path: p });
    assert.equal(res.status, 403, p);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.match(res.body, /double-click/i);
    assert.doesNotMatch(res.body, new RegExp(srv.token));
  }
  assert.equal((await request(srv.port, { path: `/api/lessons/01-intro?t=${srv.token}` })).status, 403, 'the query token only works on pages');
});

test('a token of the same length but with multibyte characters is a 403, not a 500', async () => {
  const forged = `é${srv.token.slice(1)}`;
  assert.equal((await request(srv.port, { path: '/', headers: { cookie: `ld_t_${srv.port}=${forged}` } })).status, 403);
  assert.equal((await request(srv.port, { path: `/?t=${encodeURIComponent(forged)}` })).status, 403);
});

test('a /static/ path that normalizes elsewhere is never served as a route', async () => {
  assert.equal((await request(srv.port, { path: '/static/../api/lessons/01-intro' })).status, 403);
  assert.equal((await request(srv.port, { path: '/static/nope/x.js' })).status, 404);
});

test('bad Host is rejected (DNS rebinding)', async () => {
  const res = await request(srv.port, { path: '/api/health', headers: { host: `evil.example:${srv.port}` } });
  assert.equal(res.status, 403);
});

test('page load with ?t= sets the cookie; the page carries the token meta', async () => {
  const res = await request(srv.port, { path: `/lessons/01-intro?t=${srv.token}` });
  assert.equal(res.status, 200);
  const setCookie = res.headers['set-cookie'][0];
  assert.match(setCookie, new RegExp(`^ld_t_${srv.port}=${srv.token}; HttpOnly; SameSite=Lax; Path=/$`));
  cookie = setCookie.split(';')[0];
  assert.match(res.body, new RegExp(`<meta name="learndoc-token" content="${srv.token}"`));
  assert.match(res.body, /\/static\/runtime\/editor\.js/);
  assert.equal((await request(srv.port, { path: '/', headers: { cookie } })).status, 200);
  assert.equal((await request(srv.port, { path: '/lessons/missing', headers: { cookie } })).status, 404);
  assert.equal((await request(srv.port, { path: '/', headers: { cookie: `ld_t_${srv.port}=wrong` } })).status, 403);
});

test('two running courses keep separate sessions (cookies are shared across ports)', async () => {
  const other = await startServer({ root: makeProject() });
  try {
    const otherCookie = (await request(other.port, { path: `/?t=${other.token}` })).headers['set-cookie'][0].split(';')[0];
    // The browser sends both cookies to both servers: neither may shadow the other.
    const both = `${cookie}; ${otherCookie}`;
    assert.equal((await request(srv.port, { path: '/', headers: { cookie: both } })).status, 200);
    assert.equal((await request(other.port, { path: '/', headers: { cookie: both } })).status, 200);
  } finally {
    await other.close();
  }
});

test('API writes need cookie, token header and Origin', async () => {
  const post = (headers) => request(srv.port, { method: 'POST', path: '/api/edit', headers, body: editBody });
  const good = writeHeaders();
  assert.equal((await post({ ...good, cookie: undefined })).status, 403, 'no cookie');
  assert.equal((await post({ ...good, 'x-learndoc-token': undefined })).status, 403, 'no header');
  assert.equal((await post({ ...good, 'x-learndoc-token': 'f'.repeat(64) })).status, 403, 'wrong header');
  assert.equal((await post({ ...good, origin: 'http://evil.example' })).status, 403, 'bad Origin');
  assert.equal((await post({ ...good, origin: undefined })).status, 403, 'no Origin');
  const del = await request(srv.port, { method: 'DELETE', path: '/api/changesets/cs-x', headers: { cookie } });
  assert.equal(del.status, 403, 'DELETE is a write');

  const res = await post(good);
  assert.equal(res.status, 202);
  const { changesetId } = res.json;
  const locked = await post(good);
  assert.deepEqual([locked.status, locked.json.error.code], [409, 'changeset_open']);
  const view = await waitFor(async () => {
    const v = (await request(srv.port, { path: `/api/changesets/${changesetId}`, headers: { cookie } })).json;
    return v.status !== 'running' && v;
  });
  assert.equal(view.status, 'ready', view.error);

  const lesson = await request(srv.port, { path: '/api/lessons/01-intro', headers: { cookie } });
  assert.deepEqual(lesson.json.openChangeset, { id: changesetId, mode: 'replace', status: 'ready' });
  assert.deepEqual(lesson.json.config, { boxTypes: {}, language: 'en', features: { math: true }, editModel: 'sonnet' });

  const accepted = await request(srv.port, { method: 'POST', path: `/api/changesets/${changesetId}/accept`, headers: good, body: {} });
  assert.equal(accepted.status, 200, accepted.body);
  assert.match(accepted.json.lesson.blocks[1].html, /norm/);
  const standalone = () => fs.readFileSync(path.join(root, 'html', '01-intro.html'), 'utf8');
  assert.match(standalone(), /<strong>norm<\/strong>/, 'accept refreshes the standalone page');
  const again = await request(srv.port, { method: 'DELETE', path: `/api/changesets/${changesetId}`, headers: good });
  assert.deepEqual([again.status, again.json], [200, { ok: true }], 'DELETE on a terminal changeset is ok');
  assert.equal((await request(srv.port, { path: '/api/lessons/01-intro', headers: { cookie } })).json.openChangeset, null);

  const history = (await request(srv.port, { path: '/api/lessons/01-intro/history', headers: { cookie } })).json;
  assert.deepEqual(history.map((h) => [h.summary, h.restorable]), [['learndoc: Say norm.', true], ['init', false]]);

  const saved = await request(srv.port, { path: `/api/lessons/01-intro/history/${history[0].commit}`, headers: { cookie } });
  assert.equal(saved.status, 200, saved.body);
  assert.deepEqual(saved.json.changes.map((c) => [c.op, c.blockId]), [['replace', 'b-prose1']]);
  assert.match(saved.json.before.blocks[1].html, /<strong>length<\/strong>/);
  assert.match(saved.json.preview.blocks[1].html, /<strong>norm<\/strong>/);
  const first = await request(srv.port, { path: `/api/lessons/01-intro/history/${history[1].commit}`, headers: { cookie } });
  assert.deepEqual([first.json.restorable, first.json.before.blocks, first.json.changes.every((c) => c.op === 'insert')], [false, [], true]);
  assert.equal((await request(srv.port, { path: `/api/lessons/01-intro/history/${'0'.repeat(40)}`, headers: { cookie } })).status, 404);

  const reverted = await request(srv.port, { method: 'POST', path: '/api/lessons/01-intro/revert', headers: good, body: { commit: history[0].commit } });
  assert.equal(reverted.status, 200, reverted.body);
  assert.match(reverted.json.lesson.blocks[1].html, /<strong>length<\/strong>/);
  assert.match(standalone(), /<strong>length<\/strong>/, 'restore refreshes the standalone page');
  assert.equal(git(root, 'log', '-1', '--format=%s').trim(), `learndoc: restore before ${history[0].commit.slice(0, 7)}`);
  assert.equal((await request(srv.port, { method: 'POST', path: '/api/lessons/01-intro/revert', headers: good, body: { commit: 'HEAD' } })).status, 400);
});

test('errors are JSON', async () => {
  const res = await request(srv.port, { method: 'POST', path: '/api/edit', headers: writeHeaders(), body: { lessonId: '01-intro', mode: 'rewrite' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'bad_request');
  const missing = await request(srv.port, { path: '/api/changesets/cs-none', headers: { cookie } });
  assert.deepEqual([missing.status, missing.json.error.code], [404, 'not_found']);
  assert.equal((await request(srv.port, { path: '/api/lessons/01-intro/notes', headers: { cookie } })).body, '[]');
  const gone = await request(srv.port, { method: 'DELETE', path: '/api/lessons/01-intro/notes/cs-none', headers: writeHeaders() });
  assert.deepEqual([gone.status, gone.json.error.code], [404, 'not_found']);
  assert.equal((await request(srv.port, { method: 'DELETE', path: '/api/lessons/01-intro/notes/cs-none', headers: { cookie } })).status, 403);
});

test('server start indexes the references and removes what earlier versions generated', async () => {
  const project = makeProject();
  const legacy = path.join(project, 'references', 'chunks', 'notes');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'index.json'), '{}');
  fs.mkdirSync(path.join(project, '.learndoc', 'build'), { recursive: true });
  fs.rmSync(path.join(project, '.learndoc', 'refs'), { recursive: true, force: true });
  const other = await startServer({ root: project });
  try {
    assert.ok(fs.readdirSync(path.join(project, '.learndoc', 'refs')).length > 0, 'references indexed');
    assert.ok(!fs.existsSync(path.join(project, 'references', 'chunks')));
    assert.ok(!fs.existsSync(path.join(project, '.learndoc', 'build')));
  } finally {
    await other.close();
  }
});
