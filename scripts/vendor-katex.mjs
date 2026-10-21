#!/usr/bin/env node
// Copies the KaTeX browser bundle, woff2 fonts and the Node ESM build into runtime/vendor/katex/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules/katex');
const dist = path.join(source, 'dist');
const target = path.join(root, 'runtime/vendor/katex');

if (!fs.existsSync(dist)) {
  console.error('katex is not installed — run npm install first');
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.join(target, 'fonts'), { recursive: true });

for (const file of ['katex.min.js', 'katex.mjs']) {
  fs.copyFileSync(path.join(dist, file), path.join(target, file));
}
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));

// Only woff2 fonts are shipped, so drop the woff/ttf fallbacks from every src list.
const css = fs.readFileSync(path.join(dist, 'katex.min.css'), 'utf8')
  .replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, '');
if (/\.(?:woff|ttf)\)/.test(css)) throw new Error('katex.min.css still references woff/ttf fonts');
fs.writeFileSync(path.join(target, 'katex.min.css'), css);

const fonts = fs.readdirSync(path.join(dist, 'fonts')).filter((name) => name.endsWith('.woff2'));
for (const font of fonts) {
  fs.copyFileSync(path.join(dist, 'fonts', font), path.join(target, 'fonts', font));
}

const { version } = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
console.log(`vendored katex ${version} (${fonts.length} woff2 fonts) into ${path.relative(root, target)}`);
