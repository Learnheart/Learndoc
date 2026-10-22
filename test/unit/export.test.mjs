import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ChromeBrowser, findChrome } from '../../lib/chrome.mjs';
import { exportSite, launcherName, preferredPort } from '../../lib/export.mjs';
import { copyFixture, readJson, writeJson } from './helpers.mjs';

const browserSkip = !findChrome() && 'Chrome not found';
// 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64');

test('preferredPort is stable per project and inside its range', (t) => {
  const a = copyFixture(t);
  const b = copyFixture(t);
  assert.equal(preferredPort(a), preferredPort(a));
  assert.notEqual(preferredPort(a), preferredPort(b));
  for (const port of [preferredPort(a), preferredPort(b)]) assert.ok(port >= 41000 && port < 49000, String(port));
});

test('exportSite writes self-contained pages for every available lesson plus the launcher', (t) => {
  const root = copyFixture(t);
  const result = exportSite(root);
  assert.deepEqual(result.pages.sort(), ['index.html', 'intro.html', 'second.html'], 'planned lessons have no page');
  assert.deepEqual(result.skipped, []);
  const intro = fs.readFileSync(path.join(root, 'html', 'intro.html'), 'utf8');
  assert.doesNotMatch(intro, /(src|href)="\/(static|project|lessons)\//, 'nothing points at the server');
  assert.ok(intro.indexOf('<link rel="stylesheet" href="_assets/katex.min.css">') < intro.indexOf('<link rel="stylesheet" href="_assets/style.css">'));
  assert.match(intro, /<script src="_assets\/katex\.min\.js"><\/script>/);
  assert.doesNotMatch(intro, /@font-face|<style>/, 'styles and fonts are linked, not copied into each page');
  const assets = fs.readdirSync(path.join(root, 'html', '_assets'), { recursive: true }).sort();
  assert.deepEqual(assets.filter((name) => !name.startsWith('fonts')), ['katex.min.css', 'katex.min.js', 'style.css']);
  assert.ok(assets.includes(path.join('fonts', 'KaTeX_Main-Regular.woff2')));
  assert.match(intro, /<a class="ld-home" href="index\.html">/);
  assert.match(intro, /href="second\.html#topic"/, 'lesson: links point at the sibling file');
  assert.match(intro, /<a class="ld-next" href="second\.html">/);
  assert.match(intro, new RegExp(`<a class="ld-edit-open" href="http://127\\.0\\.0\\.1:${preferredPort(root)}/lessons/intro">`));
  const widgets = JSON.parse(/<script type="application\/json" id="ld-widgets">(.*?)<\/script>/.exec(intro)[1]);
  assert.deepEqual(Object.keys(widgets), ['counter'], 'only the widgets the lesson uses');
  assert.match(widgets.counter, /^data:text\/javascript;base64,/);
  assert.doesNotMatch(intro, /<meta name="learndoc-token"|<script[^>]*editor\.js/);
  const index = fs.readFileSync(path.join(root, 'html', 'index.html'), 'utf8');
  assert.match(index, /<a class="ld-card" href="intro\.html">/);
  assert.match(index, /<a class="ld-edit-open" href="http:\/\/127\.0\.0\.1:\d+\/">/);

  const launcher = path.join(root, result.launcher);
  assert.equal(result.launcher, launcherName('en'));
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(launcher).mode & 0o100, 'executable');
    const script = fs.readFileSync(launcher, 'utf8');
    assert.match(script, /^#!\/bin\/bash\n/);
    assert.ok(script.includes(`${path.join('bin', 'learndoc.mjs')}' serve`));
    assert.equal(spawnSync('bash', ['-n', launcher]).status, 0, 'valid bash');
  }
});

test('figure images are copied once into _assets/media and dropped with the figure', (t) => {
  const root = copyFixture(t);
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'dot one.png'), PNG);
  const file = path.join(root, 'lessons', 'intro.json');
  const lesson = readJson(file);
  lesson.blocks.push({ id: 'b-img', type: 'figure', src: 'assets/dot one.png', alt: 'A dot', caption: 'Dot' });
  writeJson(file, lesson);
  exportSite(root);
  const media = path.join(root, 'html', '_assets', 'media', 'assets', 'dot one.png');
  assert.deepEqual(fs.readFileSync(media), PNG);
  assert.match(fs.readFileSync(path.join(root, 'html', 'intro.html'), 'utf8'), /<img src="_assets\/media\/assets\/dot%20one\.png" alt="A dot">/);
  lesson.blocks.pop();
  writeJson(file, lesson);
  exportSite(root);
  assert.ok(!fs.existsSync(path.join(root, 'html', '_assets', 'media')), 'unused media and emptied folders are removed');
});

test('a course without math gets no KaTeX files', (t) => {
  const root = copyFixture(t);
  const config = readJson(path.join(root, 'learndoc.json'));
  writeJson(path.join(root, 'learndoc.json'), { ...config, features: { ...config.features, math: false } });
  exportSite(root);
  assert.deepEqual(fs.readdirSync(path.join(root, 'html', '_assets')), ['style.css']);
});

test('exportSite removes its own stale pages, keeps foreign files and skips broken lessons', (t) => {
  const root = copyFixture(t);
  exportSite(root);
  const foreign = path.join(root, 'html', 'notes.html');
  fs.writeFileSync(foreign, '<p>mine</p>');
  const course = readJson(path.join(root, 'course.json'));
  course.modules[0].lessons = course.modules[0].lessons.filter((entry) => entry.id !== 'second');
  writeJson(path.join(root, 'course.json'), course);
  fs.writeFileSync(path.join(root, 'lessons', 'intro.json'), '{ broken');
  const result = exportSite(root);
  assert.deepEqual(result.skipped, ['intro']);
  assert.ok(!fs.existsSync(path.join(root, 'html', 'second.html')), 'stale generated page removed');
  assert.ok(fs.existsSync(foreign), 'a file the export did not write is kept');
  assert.equal(exportSite(path.join(root, 'nowhere')), null);
});

test('inside a git work tree the generated files are excluded, once', (t) => {
  const root = copyFixture(t);
  spawnSync('git', ['init', '--quiet'], { cwd: root });
  exportSite(root);
  exportSite(root);
  const exclude = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((line) => line === '/html/').length, 1);
  assert.ok(exclude.includes(`/${launcherName('en')}`));
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).stdout;
  assert.doesNotMatch(status, /html\/|Open course/);
});

test('an exported page works from file:// with no server', { skip: browserSkip }, async (t) => {
  const root = copyFixture(t);
  exportSite(root);
  const browser = new ChromeBrowser(findChrome());
  t.after(() => browser.close());
  await browser.navigate(pathToFileURL(path.join(root, 'html', 'intro.html')).href);
  const result = await browser.evaluate(`(async () => {
    const deadline = Date.now() + 10000;
    while (!(window.learndoc && window.learndoc.ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await window.learndoc.ready;
    return {
      katex: document.querySelectorAll('.katex').length,
      widgets: [...document.querySelectorAll('.ld-widget[data-widget]')].map((el) => el.dataset.mounted === '1'),
      edit: document.querySelector('.ld-edit-open')?.textContent,
      mainFont: getComputedStyle(document.querySelector('.katex')).fontFamily.split(',')[0].replace(/"/g, ''),
      fontLoaded: await document.fonts.ready.then(() => [...document.fonts].some((f) => f.family.includes('KaTeX_Main') && f.status === 'loaded')),
    };
  })()`, { awaitPromise: true });
  assert.ok(result.katex > 0, 'math rendered');
  assert.deepEqual(result.widgets, [true], 'widget mounted');
  assert.match(result.edit, /Edit/);
  assert.equal(result.mainFont, 'KaTeX_Main', 'KaTeX styles load from _assets');
  assert.equal(result.fontLoaded, true, 'KaTeX fonts load from _assets/fonts over file://');
  assert.deepEqual(browser.problems, []);
});
