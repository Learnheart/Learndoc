import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createStaticHandler } from '../../lib/static-server.mjs';
import { copyFixture } from './helpers.mjs';

async function serve(t, root) {
  const handler = createStaticHandler({ projectRoot: root });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(418).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  // Raw paths: fetch() would normalize ../ before sending.
  return (rawPath, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request(`${base}${rawPath}`, { method, path: rawPath }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves skill static dirs and project widgets/assets with MIME types', async (t) => {
  const root = copyFixture(t);
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'a b.svg'), '<svg/>');
  const get = await serve(t, root);
  const cases = [
    ['/static/shared/render.mjs', 'text/javascript; charset=utf-8'],
    ['/static/runtime/vendor/katex/katex.min.css', 'text/css; charset=utf-8'],
    ['/static/runtime/vendor/katex/fonts/KaTeX_Main-Regular.woff2', 'font/woff2'],
    ['/project/widgets/counter.js', 'text/javascript; charset=utf-8'],
    ['/project/assets/a%20b.svg', 'image/svg+xml'],
  ];
  for (const [url, type] of cases) {
    const res = await get(url);
    assert.equal(res.status, 200, url);
    assert.equal(res.type, type, url);
  }
  assert.equal((await get('/project/widgets/counter.js', 'HEAD')).body, '');
  assert.equal((await get('/project/widgets/counter.js', 'POST')).status, 405);
});

test('rejects traversal, other dirs, symlink escapes and missing files; ignores other routes', async (t) => {
  const root = copyFixture(t);
  fs.mkdirSync(path.join(root, 'assets'));
  fs.symlinkSync(path.join(root, 'learndoc.json'), path.join(root, 'assets', 'link.json'));
  const get = await serve(t, root);
  for (const url of [
    '/static/../package.json', '/static/runtime/../../package.json', '/static/runtime/%2e%2e/%2e%2e/package.json',
    '/static/lib/finalize.mjs', '/project/lessons/intro.json', '/project/assets/link.json', '/project/widgets/nope.js',
    '/project/widgets/', '/static/runtime/widgets', '/static/shared/%E0%A4%A.mjs', '/project/widgets/..%2fcourse.json',
  ]) {
    assert.equal((await get(url)).status, 404, url);
  }
  assert.equal((await get('/lessons/intro')).status, 418);
});
