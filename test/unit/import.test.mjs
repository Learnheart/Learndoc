import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../../lib/chrome.mjs';
import { sha256, UsageError } from '../../lib/finalize.mjs';
import { runImport } from '../../lib/import.mjs';
import { formatJson } from '../../lib/project.mjs';
import { codes, GIT_ENV, readJson, SKILL } from './helpers.mjs';

const SOURCE = fileURLToPath(new URL('../fixtures/import-html', import.meta.url));
const PROFILE = path.join(SOURCE, 'profile.json');
const CLI = path.join(SKILL, 'bin', 'learndoc.mjs');
const skip = !findChrome() && 'Chrome not found';

// The import commits; give git an identity even where none is configured.
Object.assign(process.env, GIT_ENV);

function emptyProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learndoc-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
const lessonIds = (root) => readJson(path.join(root, 'course.json')).modules.flatMap((module) => module.lessons.map((lesson) => lesson.id));
const blockCounts = (lesson) => lesson.blocks.reduce((counts, block) => ({ ...counts, [block.type]: (counts[block.type] || 0) + 1 }), {});

test('import with a profile: lessons with origin, assets, demos, links, one commit', { skip }, async (t) => {
  const root = emptyProject(t);
  const { exitCode, receipt } = await runImport({ source: SOURCE, cwd: root, profileFile: PROFILE });
  assert.equal(exitCode, 0, JSON.stringify(receipt.diagnostics));
  assert.deepEqual({ ok: receipt.ok, status: receipt.status, lessons: receipt.lessons, pendingDemos: receipt.pendingDemos },
    { ok: true, status: 'pass', lessons: { total: 2, pass: 2, fail: 0 }, pendingDemos: { total: 1, withCandidate: 1 } });

  const course = readJson(path.join(root, 'course.json'));
  assert.equal(course.title, 'Import Fixture Course');
  assert.deepEqual(course.modules.map((module) => [module.id, module.lessons.map((lesson) => lesson.id)]), [['basics', ['a']], ['advanced', ['b']]],
    'globals order (a, b) and modules, not the index order (b, a)');
  assert.deepEqual(course.modules[1].lessons[0].prereq, ['a'], 'prereq chip "Lesson 1" → lesson key 1');

  const config = readJson(path.join(root, 'learndoc.json'));
  assert.equal(config.references, undefined, 'an imported page is the content, not a reference');
  assert.ok(!fs.existsSync(path.join(root, 'references')), 'no snapshot copies of the imported pages');
  assert.ok(course.modules.every((module) => module.lessons.every((lesson) => lesson.sources === undefined)));

  const a = readJson(path.join(root, 'lessons/a.json'));
  assert.deepEqual(blockCounts(a), { prose: 6, heading: 5, math: 1, code: 1, box: 4, quiz: 1, figure: 2 });
  assert.deepEqual(a.meta, { duration: '10 min' });
  assert.deepEqual(a.origin, {
    file: path.relative(root, path.join(SOURCE, 'a.html')).split(path.sep).join('/'),
    sha256: sha256(fs.readFileSync(path.join(SOURCE, 'a.html'))),
  });
  assert.ok(a.blocks.every((block) => block.sources === undefined), 'imported blocks cite nothing');
  const text = JSON.stringify(a);
  assert.doesNotMatch(text, /SCRIPT RAN|Fixture site|Fixture footer/, 'page scripts and site chrome are not imported');
  assert.match(text, /\$y \+ 1\$/, '\\( \\) becomes $ $');
  assert.match(text, /<code>\$HOME<\/code>/);
  const byType = (type) => a.blocks.filter((block) => block.type === type);
  assert.deepEqual(byType('heading').map((h) => [h.level, h.anchor]), [[2, 'intro'], [3, 'details'], [3, 'deeper'], [2, 'boxes-and-quiz'], [2, 'figures']]);
  assert.deepEqual(byType('box').map((box) => [box.variant, box.title]),
    [['warn', 'Careful with $k$'], ['note', 'Side note'], ['note', 'The <BOS> token'], ['note', 'Slide the value $s$']]);
  assert.deepEqual(byType('code')[0], { ...byType('code')[0], language: 'python', code: 'def square(x):\n    return x * x  # $not math$' });
  assert.match(byType('prose').find((p) => p.html.includes('<table>')).html, /<th colspan="2">Header<\/th>/);
  assert.match(byType('prose').find((p) => p.html.includes('blockquote')).html, /^<blockquote>A quoted remark\.<\/blockquote>$/);
  const svg = byType('figure')[0].svg;
  for (const fragment of ['class="c1"', 'opacity="0.5"', 'dy="2"', 'baseline-shift="sub"', 'marker-end="url(#arr)"', '<marker id="arr"']) assert.ok(svg.includes(fragment), fragment);
  assert.doesNotMatch(svg, /<a[\s>]|style=|fill-opacity/);
  assert.deepEqual(byType('figure')[1], { ...byType('figure')[1], src: 'assets/dot.png', alt: 'A dot', caption: 'The dot $d$' });
  assert.ok(fs.existsSync(path.join(root, 'assets/dot.png')));
  const links = byType('prose').at(-1).html;
  assert.equal(links, '<p>Links: <a href="lesson:b#sec-2">part two of B</a>, <a href="#intro">the intro</a>, an insecure site and <a href="https://example.com/">a secure site</a>.</p>');
  assert.match(JSON.stringify(readJson(path.join(root, 'lessons/b.json'))), /<a href=\\"lesson:a#intro\\">/, './a.html#intro resolves');

  const report = readJson(receipt.report);
  assert.equal(report.commit, receipt.commit);
  assert.equal(report.order, 'globals');
  assert.deepEqual(report.totals.math, { source: 13, output: 13 });
  assert.deepEqual(report.lessons[0].linksUnwrapped, { http: 1 });
  assert.equal(report.lessons[0].status, 'pass');
  assert.deepEqual(report.pendingDemos, [{
    lesson: 'a',
    blockId: byType('box')[3].id,
    demoId: 'demo-x',
    title: 'Slide the value $s$',
    hintText: 'Drag the slider to change $s$.',
    htmlFile: '.learndoc/import/demos/a--demo-x.html',
    jsFile: '.learndoc/import/demos/a--demo-x.js',
    controls: 1,
    svgs: 1,
    canvases: 0,
    candidate: { widget: 'function-plot', reason: 'title/hint match /slide/; 1 control(s) ≤ 2' },
    status: 'pending',
  }]);
  assert.match(fs.readFileSync(path.join(root, '.learndoc/import/demos/a--demo-x.html'), 'utf8'), /^<div class="demo" id="demo-x">/);
  assert.match(fs.readFileSync(path.join(root, '.learndoc/import/demos/a--demo-x.js'), 'utf8'), /^\(\(\) => \{\n\s+const demo = document\.getElementById\("demo-x"\);[\s\S]*\}\)\(\);\n$/);

  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1', 'exactly one commit');
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'learndoc: import 2 lessons from import-html');
  assert.deepEqual(git(root, 'ls-files').split('\n'), ['assets/dot.png', 'course.json', 'import-profile.json', 'learndoc.json',
    'lessons/a.json', 'lessons/b.json']);
  assert.equal(git(root, 'status', '--porcelain', '--', 'lessons'), '', 'lessons are committed in canonical form');
  const saved = fs.readFileSync(path.join(root, 'import-profile.json'), 'utf8');
  assert.equal(saved, formatJson(readJson(PROFILE)), 'the given profile is kept as written (canonical JSON)');
  assert.equal(report.profileSha, sha256(saved));
});

test('import without a profile: generic defaults, index-links order, one module', { skip }, async (t) => {
  const root = emptyProject(t);
  const { exitCode, receipt } = await runImport({ source: SOURCE, cwd: root });
  assert.equal(exitCode, 0, JSON.stringify(receipt.diagnostics));
  assert.deepEqual(receipt.lessons, { total: 2, pass: 2, fail: 0 });
  const course = readJson(path.join(root, 'course.json'));
  assert.deepEqual(course.modules.map((module) => module.id), ['lessons']);
  assert.deepEqual(lessonIds(root), ['b', 'a'], 'index.html links b before a');
  const a = readJson(path.join(root, 'lessons/a.json'));
  assert.equal(a.meta, undefined, 'no chip rules: chips stay prose');
  assert.equal(a.blocks.filter((block) => block.type === 'figure').length, 2);
  const report = readJson(receipt.report);
  assert.equal(report.order, 'index-links');
  assert.equal(report.profileSha, null);
  assert.equal(fs.existsSync(path.join(root, 'import-profile.json')), false, 'no profile given: none is written');
  assert.match(receipt.commit, /^[0-9a-f]{40}$/);
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1');
  assert.doesNotMatch(git(root, 'ls-files'), /import-profile\.json/);
});

test('./import-profile.json in the project folder is used when --profile is omitted', { skip }, async (t) => {
  const root = emptyProject(t);
  fs.copyFileSync(PROFILE, path.join(root, 'import-profile.json'));
  const { exitCode, receipt } = await runImport({ source: SOURCE, cwd: root });
  assert.equal(exitCode, 0, JSON.stringify(receipt.diagnostics));
  assert.deepEqual(lessonIds(root), ['a', 'b']);
  assert.equal(fs.readFileSync(path.join(root, 'import-profile.json'), 'utf8'), formatJson(readJson(PROFILE)));
  assert.match(git(root, 'ls-files'), /^import-profile\.json$/m);
});

test('images: URL escapes decoded, names deduplicated, remote and escaping sources dropped; subfolder pages link back', { skip }, async (t) => {
  const source = emptyProject(t);
  const root = emptyProject(t);
  const png = fs.readFileSync(path.join(SOURCE, 'img', 'dot.png'));
  fs.mkdirSync(path.join(source, 'img'));
  fs.mkdirSync(path.join(source, 'part', 'img'), { recursive: true });
  fs.writeFileSync(path.join(source, 'img', 'my dot.png'), png);
  fs.writeFileSync(path.join(source, 'part', 'img', 'my dot.png'), png);
  fs.writeFileSync(path.join(path.dirname(source), `${path.basename(source)}-outside.png`), png);
  t.after(() => fs.rmSync(path.join(path.dirname(source), `${path.basename(source)}-outside.png`), { force: true }));
  const figure = (src) => `<figure><img src="${src}" alt="Dot"><figcaption>Dot</figcaption></figure>`;
  fs.writeFileSync(path.join(source, 'index.html'), '<h1>Images</h1><a href="one.html">1</a><a href="part/two.html">2</a>');
  fs.writeFileSync(path.join(source, 'one.html'), `<main><h1>One</h1><h2 id="top">Top</h2>${figure('img/my%20dot.png')}${figure('https://example.com/x.png')}${figure('data:image/png;base64,AAAA')}</main>`);
  fs.writeFileSync(path.join(source, 'part', 'two.html'), `<main><h1>Two</h1>${figure('img/my%20dot.png')}${figure(`../../${path.basename(source)}-outside.png`)}${figure('/etc/hosts')}${figure('img/gone.png')}<p>Back to <a href="../one.html#top">one</a>.</p></main>`);
  const { exitCode, receipt } = await runImport({ source, cwd: root });
  assert.equal(exitCode, 0, JSON.stringify(receipt.diagnostics));
  assert.deepEqual(lessonIds(root), ['one', 'part-two']);
  const srcs = (id) => readJson(path.join(root, 'lessons', `${id}.json`)).blocks.filter((b) => b.type === 'figure').map((b) => b.src);
  assert.deepEqual(srcs('one'), ['assets/my-dot.png']);
  assert.deepEqual(srcs('part-two'), ['assets/my-dot-2.png'], 'a different file with the same name gets a new name');
  assert.deepEqual(fs.readdirSync(path.join(root, 'assets')).sort(), ['my-dot-2.png', 'my-dot.png']);
  assert.deepEqual(codes(receipt.diagnostics).sort(), ['import/asset-missing', 'import/asset-outside', 'import/asset-outside',
    'import/asset-remote', 'import/asset-remote', 'import/page-load']);
  assert.match(receipt.diagnostics.find((entry) => entry.code === 'import/page-load').message, /^part\/two\.html: .*img\/gone\.png failed to load/,
    'local load failures in the browser are surfaced');
  assert.ok(receipt.diagnostics.every((entry) => entry.severity === 'warning'));
  assert.deepEqual(readJson(receipt.report).lessons[1].dropped, { 'figure:asset-outside': 2, 'figure:asset-missing': 1 });
  assert.match(JSON.stringify(readJson(path.join(root, 'lessons/part-two.json'))), /lesson:one#top/);
});

function numberedSource(t) {
  const source = emptyProject(t);
  const page = (title, chip) => `<!doctype html><html lang="vi_VN"><body><main><header><h1>${title}</h1>`
    + `<div class="meta"><span class="chip"><b>Cần biết trước:</b> ${chip}</span></div></header>`
    + '<h2>Phần một</h2><aside><p>Một ghi chú.</p></aside></main></body></html>';
  fs.writeFileSync(path.join(source, '01-intro.html'), page('Mở đầu', 'không có'));
  fs.writeFileSync(path.join(source, '02-next.html'), page('Tiếp theo', 'Bài 01'));
  return source;
}

test('without a profile language, <html lang> of the first page sets it (normalized); box titles follow it', { skip }, async (t) => {
  const source = numberedSource(t);
  const root = emptyProject(t);
  const { exitCode, receipt } = await runImport({ source, cwd: root });
  assert.equal(exitCode, 0, JSON.stringify(receipt.diagnostics));
  assert.equal(readJson(path.join(root, 'learndoc.json')).language, 'vi-VN');
  const aside = readJson(path.join(root, 'lessons/01-intro.json')).blocks.find((block) => block.type === 'box');
  assert.equal(aside.title, 'Ghi chú', 'untitled note box gets the Vietnamese label');
  assert.deepEqual(codes(receipt.diagnostics), ['import/order-fallback'], 'no index.html: index-links falls back to filename order');
  assert.deepEqual(lessonIds(root), ['01-intro', '02-next']);

  const english = emptyProject(t);
  fs.writeFileSync(path.join(english, 'import-profile.json'), JSON.stringify({ language: 'en' }));
  await runImport({ source, cwd: english });
  assert.equal(readJson(path.join(english, 'learndoc.json')).language, 'en', 'an explicit profile language wins');
  assert.equal(fs.readFileSync(path.join(english, 'import-profile.json'), 'utf8'), formatJson({ language: 'en' }), 'the detected language is not written back');
});

test('prereq references resolve by numeric id prefix without course globals', { skip }, async (t) => {
  const source = numberedSource(t);
  const root = emptyProject(t);
  fs.writeFileSync(path.join(root, 'import-profile.json'), JSON.stringify({
    course: { order: 'filename' },
    lesson: { chipRules: [{ label: 'cần biết trước', to: 'prereq', ref: 'Bài\\s*(\\d+)' }] },
  }));
  const { exitCode, receipt } = await runImport({ source, cwd: root });
  assert.equal(exitCode, 0, JSON.stringify(receipt.diagnostics));
  const lessons = readJson(path.join(root, 'course.json')).modules[0].lessons;
  assert.deepEqual(lessons.map((lesson) => [lesson.id, lesson.prereq]), [['01-intro', []], ['02-next', ['01-intro']]]);
  assert.equal(readJson(receipt.report).order, 'filename');
});

test('import refuses to run in the source folder itself', async (t) => {
  const source = emptyProject(t);
  fs.cpSync(SOURCE, source, { recursive: true });
  const before = fs.readdirSync(source).sort();
  const { exitCode, receipt } = await runImport({ source: '.', cwd: source });
  assert.equal(exitCode, 1);
  assert.deepEqual(codes(receipt.diagnostics), ['import/target-is-source']);
  assert.deepEqual(fs.readdirSync(source).sort(), before);
});

test('import refuses a target folder inside the source folder', async (t) => {
  const source = emptyProject(t);
  fs.cpSync(SOURCE, source, { recursive: true });
  const inside = path.join(source, 'project');
  fs.mkdirSync(inside);
  const { exitCode, receipt } = await runImport({ source: '..', cwd: inside });
  assert.equal(exitCode, 1);
  assert.deepEqual(codes(receipt.diagnostics), ['import/target-inside-source']);
  assert.deepEqual(fs.readdirSync(inside), []);
});

test('existing assets are never overwritten, names clash case-insensitively, and only copied assets are committed', { skip }, async (t) => {
  const root = emptyProject(t);
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'Dot.PNG'), 'keep me');
  const { exitCode, receipt } = await runImport({ source: SOURCE, cwd: root, profileFile: PROFILE });
  assert.equal(exitCode, 0, JSON.stringify(receipt.diagnostics));
  assert.equal(fs.readFileSync(path.join(root, 'assets', 'Dot.PNG'), 'utf8'), 'keep me');
  const figure = readJson(path.join(root, 'lessons/a.json')).blocks.find((block) => block.type === 'figure' && block.src);
  assert.equal(figure.src, 'assets/dot-2.png');
  assert.deepEqual(git(root, 'ls-files', 'assets').split('\n'), ['assets/dot-2.png'], 'the pre-existing file is not committed');
});

test('symlinked images that leave the source are refused; sanitized demo file names stay unique', { skip }, async (t) => {
  const source = emptyProject(t);
  const root = emptyProject(t);
  const outside = path.join(emptyProject(t), 'secret.png');
  fs.copyFileSync(path.join(SOURCE, 'img', 'dot.png'), outside);
  fs.symlinkSync(outside, path.join(source, 'link.png'));
  const demo = (id) => `<div class="demo" id="${id}"><div class="demo-title">Demo ${id}</div><input type="range"></div>`;
  fs.writeFileSync(path.join(source, 'one.html'), `<main><h1>One</h1><figure><img src="link.png" alt="x"><figcaption>x</figcaption></figure>${demo('demo x')}${demo('demo-x')}`
    + '<pre class="language-Weird!"><code>x</code></pre><pre><code class="language-C++">y</code></pre></main>');
  const { exitCode, receipt } = await runImport({ source, cwd: root });
  assert.equal(exitCode, 0, JSON.stringify(receipt.diagnostics));
  assert.deepEqual(codes(receipt.diagnostics).filter((code) => code.startsWith('import/asset')), ['import/asset-outside']);
  assert.equal(fs.existsSync(path.join(root, 'assets')), false);
  const report = readJson(receipt.report);
  assert.deepEqual(report.pendingDemos.map((entry) => entry.htmlFile), ['.learndoc/import/demos/one--demo-x.html', '.learndoc/import/demos/one--demo-x-2.html']);
  for (const entry of report.pendingDemos) assert.ok(fs.existsSync(path.join(root, entry.htmlFile)));
  const languages = readJson(path.join(root, 'lessons/one.json')).blocks.filter((block) => block.type === 'code').map((block) => block.language);
  assert.deepEqual(languages, ['text', 'c++'], 'a language class outside the schema pattern falls back to code.defaultLanguage');
});

test('pages cannot reach the network (frames, objects, sockets, refreshes included); redirecting pages are skipped', { skip }, async (t) => {
  const connections = [];
  const server = http.createServer((req, res) => res.end('x'));
  server.on('connection', (socket) => connections.push(socket.remoteAddress));
  server.on('upgrade', (req, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const remote = `http://127.0.0.1:${server.address().port}`;
  const source = emptyProject(t);
  const root = emptyProject(t);
  const head = `<link rel="stylesheet" href="${remote}/style.css"><link rel="prefetch" href="${remote}/prefetch"><link rel="icon" href="${remote}/icon">`
    + `<script src="${remote}/script.js"></script><style>@import url("${remote}/import.css"); body { background: url(${remote}/bg.png) }</style>`;
  // The globals page runs its scripts (to read LESSONS); everything they try must still fail.
  fs.writeFileSync(path.join(source, 'index.html'), `<html><head>${head}<script>
    var LESSONS = [{ id: '1', file: 'one.html' }, { id: '2', file: 'moved.html' }, { id: '3', file: 'gone.html' }];
    fetch('${remote}/fetch').catch(() => {}); new Image().src = '${remote}/img';
    try { new WebSocket('${remote.replace('http', 'ws')}/ws'); } catch (e) {}
    const frame = document.createElement('iframe'); frame.src = '${remote}/js-frame'; document.documentElement.append(frame);
  </script></head><body><h1>Net</h1></body></html>`);
  fs.writeFileSync(path.join(source, 'one.html'), `<html><head>${head}</head><body><main><h1>One</h1><h2 id="p2">P2</h2>`
    + `<p>Text <img src="${remote}/inline.png" alt="pic"> and <a href="#p2">back up</a>.</p>`
    + `<iframe src="${remote}/frame.html"></iframe><object data="${remote}/object.svg"></object><video src="${remote}/v.mp4"></video>`
    + `<svg width="10" height="10"><image href="${remote}/svg.png" width="10" height="10"/></svg>`
    + `<picture><source srcset="${remote}/srcset.png"><img src="${remote}/picture.png" alt="pic"></picture>`
    + '<pre class="language-python"><code>print(1)</code></pre></main></body></html>');
  fs.writeFileSync(path.join(source, 'moved.html'), '<html><head><meta http-equiv="refresh" content="0; url=one.html"></head><body><main><h1>Moved</h1><p>x</p></main></body></html>');
  fs.writeFileSync(path.join(source, 'gone.html'), `<html><head><meta http-equiv="refresh" content="0; url=${remote}/away"></head><body><main><h1>Gone</h1><p>x</p></main></body></html>`);
  const profile = path.join(root, 'import-profile.json');
  fs.writeFileSync(profile, JSON.stringify({ course: { order: 'globals', globals: { page: 'index.html', expr: 'LESSONS' } } }));
  const { exitCode, receipt } = await runImport({ source, cwd: root });
  assert.equal(exitCode, 0, JSON.stringify(receipt.diagnostics));
  assert.deepEqual(connections, [], 'nothing reached the local server');
  assert.equal(readJson(receipt.report).order, 'globals', 'the globals page still ran');
  assert.deepEqual(lessonIds(root), ['one'], 'redirecting pages are not imported');
  const redirected = receipt.diagnostics.filter((entry) => entry.code === 'import/redirected').map((entry) => entry.subject.file);
  assert.deepEqual(redirected.sort(), ['gone.html', 'moved.html']);
  const lesson = readJson(path.join(root, 'lessons/one.json'));
  assert.deepEqual(lesson.blocks.filter((block) => block.type === 'heading').map((block) => block.anchor), ['p2-section'], 'no page-ref anchors');
  assert.match(JSON.stringify(lesson), /href=\\"#p2-section\\"/);
  assert.equal(lesson.blocks.find((block) => block.type === 'code').language, 'python', 'language class read from <pre>');
  const { dropped } = readJson(receipt.report).lessons[0];
  assert.deepEqual([dropped['tag:iframe'], dropped['tag:object'], dropped['tag:video']], [1, 1, 1]);
});

test('page scripts get no WebRTC, so the globals page cannot send UDP (STUN)', { skip }, async (t) => {
  const datagrams = [];
  const udp = dgram.createSocket('udp4');
  udp.on('message', (message, from) => datagrams.push(`${message.length} bytes from ${from.address}`));
  await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));
  t.after(() => udp.close());
  const source = emptyProject(t);
  const root = emptyProject(t);
  fs.writeFileSync(path.join(source, 'index.html'), `<html><head><script>
    var LESSONS = [{ id: '1', file: 'p.html' }];
    window.rtc = typeof RTCPeerConnection;
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udp.address().port}' }] });
      pc.createDataChannel('d');
      pc.createOffer().then((offer) => pc.setLocalDescription(offer));
    } catch (e) {}
  </script></head><body><h1>W</h1></body></html>`);
  fs.writeFileSync(path.join(source, 'p.html'), '<html><body><main><h1>Page</h1><p>Text here.</p></main></body></html>');
  fs.writeFileSync(path.join(root, 'import-profile.json'), JSON.stringify({ course: { order: 'globals', globals: { page: 'index.html', expr: 'LESSONS' } } }));
  const { exitCode, receipt } = await runImport({ source, cwd: root });
  assert.equal(exitCode, 0, JSON.stringify(receipt.diagnostics));
  assert.equal(readJson(receipt.report).order, 'globals', 'the globals page ran its scripts');
  await new Promise((resolve) => setTimeout(resolve, 1000)); // ICE gathering would have sent STUN by now
  assert.deepEqual(datagrams, []);
});

test('script-built pages are skipped as empty; with every page skipped the import fails', { skip }, async (t) => {
  const source = emptyProject(t);
  const built = '<html><body><main id="app"></main><script>app.innerHTML = "<h1>Built</h1><p>Only with scripts.</p>";</script></body></html>';
  fs.writeFileSync(path.join(source, 'built.html'), built);
  fs.writeFileSync(path.join(source, 'real.html'), '<html><body><main><h1>Real</h1><p>Static text.</p></main></body></html>');
  const root = emptyProject(t);
  const partial = await runImport({ source, cwd: root });
  assert.equal(partial.exitCode, 0, JSON.stringify(partial.receipt.diagnostics));
  assert.deepEqual(lessonIds(root), ['real']);
  const empty = partial.receipt.diagnostics.find((entry) => entry.code === 'import/empty-page');
  assert.deepEqual([empty.severity, empty.subject.file], ['warning', 'built.html']);
  assert.match(empty.message, /may be built by JavaScript/);

  fs.rmSync(path.join(source, 'real.html'));
  const none = emptyProject(t);
  const { exitCode, receipt } = await runImport({ source, cwd: none });
  assert.equal(exitCode, 1);
  assert.deepEqual(codes(receipt.diagnostics), ['import/no-pages', 'import/order-fallback', 'import/empty-page']);
  assert.deepEqual(fs.readdirSync(none), [], 'nothing is written');
});

test('an invalid CSS selector in the profile is a profile diagnostic, not a crash', { skip }, async (t) => {
  const root = emptyProject(t);
  fs.writeFileSync(path.join(root, 'import-profile.json'), JSON.stringify({ lesson: { root: 'main[[[' }, demos: { hint: '..hint' } }));
  const { exitCode, receipt } = await runImport({ source: SOURCE, cwd: root });
  assert.equal(exitCode, 1);
  assert.deepEqual(receipt.diagnostics.map((entry) => [entry.code, entry.subject.path]), [['import/profile-invalid', 'lesson.root'], ['import/profile-invalid', 'demos.hint']]);
  assert.deepEqual(fs.readdirSync(root), ['import-profile.json']);
});

test('import refuses a folder that already holds a project and touches nothing', async (t) => {
  const root = emptyProject(t);
  fs.writeFileSync(path.join(root, 'learndoc.json'), '{}\n');
  fs.mkdirSync(path.join(root, 'lessons'));
  const { exitCode, receipt } = await runImport({ source: SOURCE, cwd: root, profileFile: PROFILE });
  assert.equal(exitCode, 1);
  assert.equal(receipt.status, 'fail');
  assert.deepEqual(codes(receipt.diagnostics), ['import/target-exists']);
  assert.deepEqual(receipt.diagnostics[0].subject.existing, ['learndoc.json', 'lessons']);
  assert.deepEqual(fs.readdirSync(root).sort(), ['learndoc.json', 'lessons']);
  assert.equal(fs.readFileSync(path.join(root, 'learndoc.json'), 'utf8'), '{}\n');
});

test('an invalid profile fails before anything is written', async (t) => {
  const root = emptyProject(t);
  const write = (profile) => { fs.writeFileSync(path.join(root, 'bad.json'), JSON.stringify(profile)); return 'bad.json'; };
  const run = async (profile) => (await runImport({ source: SOURCE, cwd: root, profileFile: write(profile) })).receipt;
  assert.deepEqual(codes((await run({ files: { include: '(' } })).diagnostics), ['import/profile-invalid']);
  assert.deepEqual(codes((await run({ lesson: { unknown: 1 } })).diagnostics), ['schema/additionalProperties']);
  fs.writeFileSync(path.join(root, 'bad.json'), '{');
  assert.deepEqual(codes((await runImport({ source: SOURCE, cwd: root, profileFile: 'bad.json' })).receipt.diagnostics), ['json/parse']);
  assert.deepEqual(fs.readdirSync(root), ['bad.json']);
});

test('usage errors: missing source folder or profile file', async (t) => {
  const root = emptyProject(t);
  await assert.rejects(runImport({ source: 'nope', cwd: root }), UsageError);
  await assert.rejects(runImport({ source: SOURCE, cwd: root, profileFile: 'missing.json' }), UsageError);
  const run = (...args) => spawnSync(process.execPath, [CLI, 'import', ...args], { cwd: root, encoding: 'utf8' }).status;
  assert.equal(run(), 64);
  assert.equal(run('nope'), 64);
  assert.equal(run(SOURCE, '--profile'), 64);
  assert.equal(run(SOURCE, '--profile', 'missing.json'), 64);
  assert.equal(run(SOURCE, '--bogus'), 64);
  assert.equal(run(SOURCE, 'extra'), 64);
});
