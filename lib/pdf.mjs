// PDF export: the standalone lesson pages (lib/export.mjs) printed by headless Chrome, so the
// print stylesheet in runtime/style.css decides what is on paper (no page chrome, no widgets,
// quiz answers open). One lesson -> one PDF; the whole course -> a .zip of one PDF per lesson.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChromeBrowser, findChrome } from './chrome.mjs';
import { exportSite } from './export.mjs';
import { zip } from './zip.mjs';

const READY_TIMEOUT_MS = 20000;
const FOOTER = '<div style="width:100%;font:8px system-ui,sans-serif;color:#888;text-align:center">'
  + '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';

// code: 'no_chrome' | 'not_found'
export class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Math, widgets and fonts are done before printing, so nothing is printed half-rendered.
const WAIT_READY = `(async () => {
  const deadline = Date.now() + ${READY_TIMEOUT_MS};
  while (!(window.learndoc && window.learndoc.ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await window.learndoc?.ready;
  await document.fonts.ready;
  return true;
})()`;

const pageName = (id) => `${encodeURIComponent(id)}.html`;

// -> [{ id, file: '<id>.pdf', data: Buffer }] in course order. `ids` defaults to every lesson
// that has a standalone page (planned lessons and lessons that fail to render have none).
export async function lessonPdfs(root, ids = null, { env = process.env } = {}) {
  const chromePath = findChrome({ env });
  if (!chromePath) throw new PdfError('no_chrome', 'Google Chrome or Chromium is needed to export PDF; set LEARNDOC_CHROME to its path');
  // Refreshes html/ first, so the PDF matches the lesson file as it is now.
  const site = exportSite(root);
  if (!site) throw new PdfError('not_found', 'no learndoc course in this folder');
  const lessons = site.pages.filter((name) => name !== 'index.html');
  const wanted = ids ?? lessons.map((name) => decodeURIComponent(name.slice(0, -'.html'.length)));
  for (const id of wanted) {
    if (!lessons.includes(pageName(id))) throw new PdfError('not_found', `lesson "${id}" has no page to print`);
  }
  const browser = new ChromeBrowser(chromePath, { env });
  try {
    const pdfs = [];
    for (const id of wanted) {
      await browser.navigate(pathToFileURL(path.join(site.dir, pageName(id))).href, 30000);
      await browser.evaluate(WAIT_READY, { awaitPromise: true, timeoutMs: READY_TIMEOUT_MS + 5000 });
      const data = await browser.printToPdf({ displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: FOOTER });
      pdfs.push({ id, file: `${id}.pdf`, data });
    }
    return pdfs;
  } finally {
    await browser.close();
  }
}

// -> Buffer of a .zip holding one PDF per lesson.
export async function coursePdfZip(root, options) {
  const pdfs = await lessonPdfs(root, null, options);
  return zip(pdfs.map(({ file, data }) => ({ name: file, data })));
}
