#!/usr/bin/env node
// Copies the pdf.js legacy build (used from Node for text extraction) into runtime/vendor/pdfjs/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules/pdfjs-dist');
const build = path.join(source, 'legacy/build');
const target = path.join(root, 'runtime/vendor/pdfjs');

if (!fs.existsSync(build)) {
  console.error('pdfjs-dist is not installed — run npm install first');
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const file of ['pdf.mjs', 'pdf.worker.mjs']) {
  fs.copyFileSync(path.join(build, file), path.join(target, file));
}
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));

const { version } = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
console.log(`vendored pdfjs-dist ${version} into ${path.relative(root, target)}`);
