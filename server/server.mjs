// Edit server: node:http on 127.0.0.1, token auth, pages, static files and the edit API.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { exportSite, launcherName } from '../lib/export.mjs';
import { renderIndexPage, renderLessonPage } from '../lib/page.mjs';
import { coursePdfZip, lessonPdfs, PdfError } from '../lib/pdf.mjs';
import { bootstrapProject, CONFIG_FILE } from '../lib/project.mjs';
import { ensureChunks } from '../lib/refs.mjs';
import { createStaticHandler } from '../lib/static-server.mjs';
import { escapeHtml } from '../shared/html.mjs';
import { localized } from '../shared/render.mjs';
import { DEFAULT_MODEL, HttpError, Store } from './store.mjs';

// Browsers share cookies across ports of one host, so each server names its cookie by its port:
// otherwise opening one course logs every other running course out.
const cookieName = (port) => `ld_t_${port}`;
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

// A download: `name` is ASCII-safe in filename= and exact in filename*= (RFC 6266).
function sendFile(res, { name, type, data }) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function sendHtml(res, html, headers = {}, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
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

const NO_SESSION = {
  vi: {
    title: 'Cần mở lại chế độ sửa',
    body: (launcher) => `Trình duyệt chưa có phiên sửa của server này (server vừa khởi động lại, hoặc trang được mở không qua link của learndoc). Double-click file <strong>${escapeHtml(launcher)}</strong> trong thư mục khoá học để mở lại.`,
  },
  en: {
    title: 'Open editing again',
    body: (launcher) => `This browser has no editing session for this server (it restarted, or the page was not opened from a learndoc link). Double-click <strong>${escapeHtml(launcher)}</strong> in the course folder to open it again.`,
  },
};

// Shown instead of a bare 403 when a page is opened without a valid session, e.g. from a standalone page.
function noSessionPage(language) {
  const text = localized(NO_SESSION, language);
  return `<!doctype html>
<html lang="${escapeHtml(language ?? 'en')}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(text.title)}</title>
<link rel="icon" href="data:,"><link rel="stylesheet" href="/static/runtime/style.css"></head>
<body class="ld-page"><main class="ld-index"><h1>${escapeHtml(text.title)}</h1><p>${text.body(launcherName(language))}</p></main></body>
</html>
`;
}

// Edits validate sources against the reference index, so a project last finalized by an earlier
// version (or whose references changed since) is indexed before the first request.
async function indexReferences(root) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
    await ensureChunks(root, config);
  } catch (error) {
    console.error('learndoc: indexing references failed', error);
  }
}

// -> { server, store, port, token, close() }. `exportPages` refreshes the standalone pages
// (lib/export.mjs) at start and after every accept or restore.
export async function startServer({ root, port = 0, token = crypto.randomBytes(32).toString('hex'), exportPages = false }) {
  bootstrapProject(root);
  await indexReferences(root);
  const store = new Store({ root });
  store.load();
  const refreshExport = (result) => {
    if (!exportPages) return result;
    try {
      exportSite(root);
    } catch (error) {
      console.error('learndoc: export failed', error);
    }
    return result;
  };
  const serveStatic = createStaticHandler({ projectRoot: root });
  let listeningPort = null;

  // PDF exports run one at a time: each starts a headless Chrome.
  let exportQueue = Promise.resolve();
  const exportJob = (job) => {
    const run = exportQueue.then(job, job);
    exportQueue = run.catch(() => {});
    return run.catch((error) => {
      if (!(error instanceof PdfError)) throw error;
      throw new HttpError(error.code === 'no_chrome' ? 503 : 404, error.code, error.message);
    });
  };
  const courseZipName = `${path.basename(root).replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'course'}-pdf.zip`;

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
    ['POST', '/api/changesets/([a-z0-9-]+)/accept', async ({ id, body }) => refreshExport(await store.accept(id, body))],
    ['DELETE', '/api/changesets/([a-z0-9-]+)', ({ id }) => {
      store.cancel(id);
      return { ok: true };
    }],
    ['GET', `/api/lessons/(${SLUG})/history`, ({ id }) => store.history(id)],
    ['GET', `/api/lessons/(${SLUG})/history/([0-9a-f]{40,64})`, ({ id, sub }) => store.commitView(id, sub)],
    ['POST', `/api/lessons/(${SLUG})/history/delete`, ({ id, body }) => store.deleteHistory(id, body)],
    ['POST', `/api/lessons/(${SLUG})/revert`, ({ id, body }) => refreshExport(store.restoreBefore(id, body.commit))],
    ['GET', `/api/lessons/(${SLUG})/notes`, ({ id }) => {
      store.lesson(id);
      return store.notes(id);
    }],
    ['DELETE', `/api/lessons/(${SLUG})/notes/([A-Za-z0-9_-]+)`, ({ id, sub }) => store.deleteNote(id, sub)],
    ['GET', `/export/lessons/(${SLUG})\\.pdf`, ({ id }) => exportJob(async () => {
      store.lesson(id);
      const [pdf] = await lessonPdfs(root, [id]);
      return { file: { name: pdf.file, type: 'application/pdf', data: pdf.data } };
    })],
    ['GET', '/export/course\\.zip', () => exportJob(async () => ({
      file: { name: courseZipName, type: 'application/zip', data: await coursePdfZip(root) },
    }))],
  ].map(([method, pattern, handler]) => ({ method, re: new RegExp(`^${pattern}$`), handler }));

  // Static skill files are public, but only when the raw and the parsed path agree, so a
  // dot-segment can never turn a /static/ request into an unauthenticated route.
  const isStatic = (req, url) => req.url.startsWith('/static/') && url.pathname.startsWith('/static/');

  const authorized = (req, url) => {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${listeningPort}` && host !== `localhost:${listeningPort}`) return { ok: false };
    if (url.pathname === '/api/health' || isStatic(req, url)) return { ok: true };
    // Exports are page-like: a standalone page navigates to them, so they get the no-session page too.
    const isPage = url.pathname === '/' || url.pathname.startsWith('/lessons/') || url.pathname.startsWith('/export/');
    const viaQuery = isPage && req.method === 'GET' && sameSecret(url.searchParams.get('t'), token);
    if (!viaQuery && !sameSecret(cookieValue(req, cookieName(listeningPort)), token)) return { ok: false, page: isPage && req.method === 'GET' };
    if (url.pathname.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD') {
      if (!sameSecret(req.headers['x-learndoc-token'], token)) return { ok: false };
      if (req.headers.origin !== `http://127.0.0.1:${listeningPort}`) return { ok: false };
    }
    return { ok: true, setCookie: viaQuery };
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = authorized(req, url);
    if (!auth.ok && auth.page) return sendHtml(res, noSessionPage(store.config().language), {}, 403);
    if (!auth.ok) return sendError(res, 403, 'forbidden', 'forbidden');
    if (serveStatic(req, res)) return;
    const pathMatches = routes.filter((r) => r.re.test(url.pathname));
    const route = pathMatches.find((r) => r.method === req.method || (req.method === 'HEAD' && r.method === 'GET'));
    if (!route && pathMatches.length) return sendError(res, 405, 'method_not_allowed', 'method not allowed');
    if (!route) return sendError(res, 404, 'not_found', 'not found');
    const [, id, sub] = route.re.exec(url.pathname);
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const result = await route.handler({ id, sub, body });
    // Lax, not Strict: the Edit link of a standalone (file://) page is a cross-site navigation. Writes
    // still need the token header and this origin, and cross-site subresource requests get no cookie.
    const cookie = auth.setCookie ? { 'Set-Cookie': `${cookieName(listeningPort)}=${token}; HttpOnly; SameSite=Lax; Path=/` } : {};
    if (result?.html !== undefined) return sendHtml(res, result.html, cookie);
    if (result?.file) return sendFile(res, result.file);
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
  refreshExport();

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
