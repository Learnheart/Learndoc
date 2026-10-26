// Tiny static file handler for skill assets (/static/{runtime,shared,delta,schemas}/*) and project files
// (/project/{widgets,assets}/*). Shared by browser-check and the edit server.
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_ROOT } from './project.mjs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const SKILL_DIRS = new Set(['runtime', 'shared', 'delta', 'schemas']);
const PROJECT_DIRS = new Set(['widgets', 'assets']);

// Resolves `relative` (URL-decoded, '/'-separated) inside `base`; null on traversal, symlink escape
// or a missing/non-regular file.
function resolveInside(base, relative) {
  const segments = relative.split('/');
  if (relative.includes('\0') || relative.includes('\\') || segments.some((s) => s === '..' || s === '.' || s === '')) return null;
  let realBase;
  let real;
  try {
    realBase = fs.realpathSync(base);
    real = fs.realpathSync(path.join(base, ...segments));
  } catch {
    return null;
  }
  if (!real.startsWith(realBase + path.sep) || !fs.statSync(real).isFile()) return null;
  return real;
}

export function sendFile(req, res, file) {
  const type = MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const { size } = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
}

function sendStatus(res, status) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(status === 405 ? 'method not allowed\n' : 'not found\n');
}

// -> (req, res) => boolean; true when the request was under /static/ or /project/ and has been answered.
export function createStaticHandler({ projectRoot, skillRoot = SKILL_ROOT }) {
  return (req, res) => {
    // The raw path (not URL-normalized), so '/static/../x' is refused here instead of escaping the prefix.
    const pathname = req.url.split(/[?#]/)[0];
    const match = /^\/(static|project)\/([^/]+)\/(.+)$/.exec(pathname);
    if (!match && !/^\/(static|project)\//.test(pathname)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendStatus(res, 405);
      return true;
    }
    let file = null;
    if (match) {
      const [, scope, dir, rest] = match;
      const allowed = scope === 'static' ? SKILL_DIRS : PROJECT_DIRS;
      const base = scope === 'static' ? skillRoot : projectRoot;
      let relative = null;
      try {
        relative = decodeURIComponent(rest);
      } catch {
        // Malformed escapes fall through to 404.
      }
      if (allowed.has(dir) && relative !== null) file = resolveInside(path.join(base, dir), relative);
    }
    if (file) sendFile(req, res, file);
    else sendStatus(res, 404);
    return true;
  };
}
