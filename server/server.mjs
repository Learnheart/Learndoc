// Edit server: node:http on 127.0.0.1, token auth, pages, static files and the edit API.

import crypto from 'node:crypto';
import http from 'node:http';
import { renderIndexPage, renderLessonPage } from '../lib/page.mjs';
import { bootstrapProject } from '../lib/project.mjs';
import { createStaticHandler } from '../lib/static-server.mjs';
import { DEFAULT_MODEL, HttpError, Store } from './store.mjs';

const COOKIE = 'ld_t';
const BODY_LIMIT = 1024 * 1024;
const SLUG = '[a-z0-9][a-z0-9-]{0,63}';

function sameSecret(value, secret) {
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieValue(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

const sendError = (res, status, code, message) => sendJson(res, status, { error: { code, message } });

function sendHtml(res, html, headers = {}) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(html);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, 'too_large', 'request body is too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'bad_request', 'body must be a JSON object');
}

// -> { server, store, port, token, close() }
export async function startServer({ root, port = 0, token = crypto.randomBytes(32).toString('hex') }) {
  bootstrapProject(root);
  const store = new Store({ root });
  store.load();
  const serveStatic = createStaticHandler({ projectRoot: root });
  let listeningPort = null;

  const routes = [
    ['GET', '/', () => ({ html: renderIndexPage({ config: store.config(), course: store.course() }) })],
    ['GET', `/lessons/(${SLUG})`, ({ id }) => ({
      html: renderLessonPage({ root, config: store.config(), course: store.course(), lesson: store.lesson(id).lesson, editable: true, token }),
    })],
    ['GET', '/api/health', () => ({ ok: true, pid: process.pid, projectRoot: root })],
    ['GET', `/api/lessons/(${SLUG})`, ({ id }) => lessonPayload(store, id)],
    ['POST', '/api/edit', ({ body }) => [202, { changesetId: store.startEdit(body) }]],
    ['GET', '/api/changesets/([a-z0-9-]+)', ({ id }) => store.view(id)],
    ['POST', '/api/changesets/([a-z0-9-]+)/confirm', ({ id }) => [202, { changesetId: store.confirm(id) }]],
    ['POST', '/api/changesets/([a-z0-9-]+)/refine', ({ id, body }) => [202, { changesetId: store.refine(id, body) }]],
    ['POST', '/api/changesets/([a-z0-9-]+)/accept', ({ id, body }) => store.accept(id, body)],
    ['DELETE', '/api/changesets/([a-z0-9-]+)', ({ id }) => {
      store.cancel(id);
      return { ok: true };
    }],
    ['GET', `/api/lessons/(${SLUG})/history`, ({ id }) => store.history(id)],
    ['POST', `/api/lessons/(${SLUG})/revert`, ({ id, body }) => store.restoreBefore(id, body.commit)],
    ['GET', `/api/lessons/(${SLUG})/notes`, ({ id }) => {
      store.lesson(id);
      return store.notes(id);
    }],
  ].map(([method, pattern, handler]) => ({ method, re: new RegExp(`^${pattern}$`), handler }));

  // Static skill files are public, but only when the raw and the parsed path agree, so a
  // dot-segment can never turn a /static/ request into an unauthenticated route.
  const isStatic = (req, url) => req.url.startsWith('/static/') && url.pathname.startsWith('/static/');

  const authorized = (req, url) => {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${listeningPort}` && host !== `localhost:${listeningPort}`) return { ok: false };
    if (url.pathname === '/api/health' || isStatic(req, url)) return { ok: true };
    const isPage = url.pathname === '/' || url.pathname.startsWith('/lessons/');
    const viaQuery = isPage && req.method === 'GET' && sameSecret(url.searchParams.get('t'), token);
    if (!viaQuery && !sameSecret(cookieValue(req, COOKIE), token)) return { ok: false };
    if (url.pathname.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD') {
      if (!sameSecret(req.headers['x-learndoc-token'], token)) return { ok: false };
      if (req.headers.origin !== `http://127.0.0.1:${listeningPort}`) return { ok: false };
    }
    return { ok: true, setCookie: viaQuery };
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = authorized(req, url);
    if (!auth.ok) return sendError(res, 403, 'forbidden', 'forbidden');
    if (serveStatic(req, res)) return;
    const pathMatches = routes.filter((r) => r.re.test(url.pathname));
    const route = pathMatches.find((r) => r.method === req.method || (req.method === 'HEAD' && r.method === 'GET'));
    if (!route && pathMatches.length) return sendError(res, 405, 'method_not_allowed', 'method not allowed');
    if (!route) return sendError(res, 404, 'not_found', 'not found');
    const [, id] = route.re.exec(url.pathname);
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const result = await route.handler({ id, body });
    const cookie = auth.setCookie ? { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` } : {};
    if (result?.html !== undefined) return sendHtml(res, result.html, cookie);
    const [status, payload] = Array.isArray(result) && typeof result[0] === 'number' ? result : [200, result];
    sendJson(res, status, payload);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) return res.end();
      if (error instanceof HttpError) return sendError(res, error.status, error.code, error.message);
      console.error(error);
      sendError(res, 500, 'internal', error.message);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  listeningPort = server.address().port;

  const close = () => {
    store.cancelAll();
    return new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  };
  return { server, store, port: listeningPort, token, close };
}

function lessonPayload(store, id) {
  const { lesson, rev } = store.lesson(id);
  const config = store.config();
  const open = store.openFor(id);
  return {
    lesson, rev,
    config: { boxTypes: config.boxTypes ?? {}, language: config.language, features: config.features ?? {}, editModel: config.editModel ?? DEFAULT_MODEL },
    openChangeset: open && { id: open.id, mode: open.mode, status: open.status },
  };
}
