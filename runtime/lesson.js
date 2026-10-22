// Lesson page boot: theme, KaTeX rendering, widget mounting, TOC highlighting.
// Also the API the editor and browser-check use, exported and on window.learndoc.
import { katexOptions } from '../shared/katex-options.mjs';

const THEME_KEY = 'learndoc-theme';
const RENDER_URL = '/static/shared/render.mjs';

// ---------- theme ----------

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const themeListeners = new Set();

function currentTheme() {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  return darkQuery.matches ? 'dark' : 'light';
}

function notifyTheme() {
  const theme = currentTheme();
  syncToggle(theme);
  for (const fn of themeListeners) {
    try {
      fn(theme);
    } catch (err) {
      console.error('learndoc: theme listener failed', err);
    }
  }
}

function syncToggle(theme) {
  for (const button of document.querySelectorAll('.ld-theme-toggle')) {
    const next = theme === 'dark' ? 'light' : 'dark';
    button.textContent = theme === 'dark' ? '☀' : '☾';
    button.setAttribute('aria-label', `Switch to ${next} theme`);
    button.title = `Switch to ${next} theme`;
  }
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    // Storage can be blocked (private mode, sandboxed previews): follow the system theme.
  }
  if (stored === 'light' || stored === 'dark') document.documentElement.dataset.theme = stored;
  syncToggle(currentTheme());

  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('.ld-theme-toggle')) return;
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Not persisted; the choice still applies to this page view.
    }
    notifyTheme();
  });
  darkQuery.addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) notifyTheme();
  });
}

// ---------- math ----------

const within = (root, selector) => [
  ...(root.matches?.(selector) ? [root] : []),
  ...root.querySelectorAll(selector),
];

export function renderMath(root = document) {
  const katex = window.katex;
  for (const span of within(root, 'span.math')) {
    const latex = span.dataset.latex ?? span.textContent;
    if (!katex) {
      span.textContent = latex;
      continue;
    }
    try {
      katex.render(latex, span, katexOptions(span.dataset.display === '1', false));
    } catch (err) {
      span.textContent = latex;
      console.error('learndoc: KaTeX failed', latex, err);
    }
  }
}

// ---------- widgets ----------

// The block <section> is also `.ld-widget` (ld-<type>); the mount point is the element with data-widget.
const WIDGET_SELECTOR = '.ld-widget[data-widget]';

// el -> { name, props, handle, listeners, error }
const instances = new WeakMap();
let widgetUrls = null;

function widgetUrl(name) {
  if (!widgetUrls) {
    const script = document.getElementById('ld-widgets');
    try {
      widgetUrls = script ? JSON.parse(script.textContent) : {};
    } catch (err) {
      console.error('learndoc: #ld-widgets is not valid JSON', err);
      widgetUrls = {};
    }
  }
  return widgetUrls[name];
}

async function loadWidget(name) {
  const url = widgetUrl(name);
  if (!url) throw new Error(`no module URL for widget "${name}" in #ld-widgets`);
  const mod = await import(url);
  if (typeof mod.default?.mount !== 'function') throw new Error(`widget "${name}" has no default export with mount()`);
  return mod.default;
}

function makeContext(listeners) {
  return {
    get theme() {
      return currentTheme();
    },
    katex: window.katex,
    onThemeChange(fn) {
      listeners.add(fn);
      themeListeners.add(fn);
    },
  };
}

async function mountOne(el) {
  const name = el.dataset.widget;
  const entry = { name, props: null, handle: null, listeners: new Set(), error: null };
  instances.set(el, entry);
  try {
    entry.props = JSON.parse(el.dataset.props || '{}');
    const widget = await loadWidget(name);
    if (instances.get(el) !== entry) return; // destroyed while loading
    entry.handle = widget.mount(el, entry.props, makeContext(entry.listeners));
    el.dataset.mounted = '1';
  } catch (err) {
    entry.error = err;
    console.error(`learndoc: widget "${name}" failed to mount`, err);
    el.replaceChildren();
    const note = document.createElement('p');
    note.className = 'ld-widget-error';
    note.textContent = `Widget "${name}" failed: ${err.message}`;
    el.append(note);
  }
}

export async function mountWidgets(root = document) {
  const pending = within(root, WIDGET_SELECTOR).filter((el) => !instances.has(el));
  await Promise.all(pending.map(mountOne));
}

function destroyOne(el) {
  const entry = instances.get(el);
  if (!entry) return;
  instances.delete(el);
  for (const fn of entry.listeners) themeListeners.delete(fn);
  delete el.dataset.mounted;
  if (entry.handle) entry.handle.destroy();
  else el.replaceChildren(); // drop the error note
}

export function destroyWidgets(root = document) {
  for (const el of within(root, WIDGET_SELECTOR)) {
    try {
      destroyOne(el);
    } catch (err) {
      console.error(`learndoc: widget "${el.dataset.widget}" failed to destroy`, err);
    }
  }
}

// ---------- block replacement ----------

export async function replaceBlock(sectionEl, block, ctx) {
  const { renderBlock } = await import(RENDER_URL);
  const template = document.createElement('template');
  template.innerHTML = renderBlock(block, ctx).trim();
  const next = template.content.firstElementChild;
  destroyWidgets(sectionEl);
  sectionEl.replaceWith(next);
  renderMath(next);
  observeHeadings(next);
  await mountWidgets(next);
  return next;
}

// ---------- self test (browser-check) ----------

// For every widget on the page: initial mount, update(props), destroy() (must
// leave the element empty), then a fresh mount. Leaves every widget mounted.
export async function selfTest() {
  const results = [];
  for (const el of document.querySelectorAll(WIDGET_SELECTOR)) {
    const entry = instances.get(el);
    const result = { name: el.dataset.widget, mount: false, update: false, destroy: false };
    results.push(result);
    if (!entry?.handle) {
      result.error = entry?.error?.message ?? 'not mounted';
      continue;
    }
    let step = 'update';
    try {
      entry.handle.update(entry.props);
      result.update = true;
      step = 'destroy';
      destroyOne(el);
      if (el.childNodes.length) throw new Error('destroy() left content in the widget element');
      result.destroy = true;
      step = 'mount';
      await mountOne(el);
      const fresh = instances.get(el);
      if (!fresh?.handle) throw fresh?.error ?? new Error('re-mount failed');
      result.mount = true;
    } catch (err) {
      result.error = `${step}: ${err.message}`;
      if (!instances.has(el)) await mountOne(el);
    }
  }
  return { widgets: results };
}

// ---------- TOC highlighting ----------

let tocObserver = null;
const tocLinks = new Map(); // heading id -> TOC link

function setActive(id) {
  for (const [key, link] of tocLinks) {
    const active = key === id;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
}

function observeHeadings(root) {
  if (!tocObserver) return;
  for (const id of tocLinks.keys()) {
    const heading = document.getElementById(id);
    if (heading && (root === document || root.contains(heading))) tocObserver.observe(heading);
  }
}

function initToc() {
  for (const link of document.querySelectorAll('.ld-toc a[href^="#"]')) {
    tocLinks.set(decodeURIComponent(link.hash.slice(1)), link);
  }
  if (!tocLinks.size || !('IntersectionObserver' in window)) return;
  // The band near the top of the viewport decides which section is "current";
  // the active heading is the last one whose top has scrolled above the band's bottom.
  tocObserver = new IntersectionObserver(() => {
    let current = null;
    for (const id of tocLinks.keys()) {
      const heading = document.getElementById(id);
      if (heading && heading.getBoundingClientRect().top < innerHeight * 0.3) current = id;
    }
    setActive(current ?? tocLinks.keys().next().value);
  }, { rootMargin: '0px 0px -70% 0px' });
  observeHeadings(document);
}

// ---------- print ----------

// A closed <details> prints only its summary, so quiz answers are opened for printing
// and the ones the reader had not opened are closed again afterwards.
function initPrint() {
  let opened = [];
  addEventListener('beforeprint', () => {
    opened = [...document.querySelectorAll('details.ld-quiz:not([open])')];
    for (const details of opened) details.open = true;
  });
  addEventListener('afterprint', () => {
    for (const details of opened) details.open = false;
    opened = [];
  });
}

// ---------- PDF export ----------

// File name from Content-Disposition (filename* first), else `fallback`.
function downloadName(res, fallback) {
  const header = res.headers.get('Content-Disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded) return decodeURIComponent(encoded[1]);
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? fallback;
}

// The topbar Export PDF link on server pages: fetched rather than followed, so the link can show
// that the server is busy printing. Standalone (file://) pages handle it in their own script.
function initPdf() {
  if (location.protocol === 'file:') return;
  document.addEventListener('click', async (e) => {
    const link = e.target.closest?.('a.ld-pdf');
    if (!link) return;
    e.preventDefault();
    if (link.getAttribute('aria-busy') === 'true') return;
    const label = link.textContent;
    link.setAttribute('aria-busy', 'true');
    link.textContent = link.dataset.busy;
    try {
      const res = await fetch(link.href, { cache: 'no-store' });
      if (!res.ok) {
        const error = await res.json().catch(() => null);
        if (error?.error?.code === 'no_chrome') {
          if (link.dataset.kind === 'lesson' && confirm(`${link.dataset.noChrome}\n${link.dataset.print}`)) print();
          else if (link.dataset.kind !== 'lesson') alert(link.dataset.noChrome);
          return;
        }
        throw new Error(error?.error?.message ?? `HTTP ${res.status}`);
      }
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: downloadName(res, link.getAttribute('download') || 'export') });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      alert(`${link.dataset.failed}: ${err.message}`);
    } finally {
      link.removeAttribute('aria-busy');
      link.textContent = label;
    }
  });
}

// ---------- boot ----------

initTheme();
renderMath(document);
initToc();
initPrint();
initPdf();
const ready = mountWidgets(document);

window.learndoc = { ready, renderMath, mountWidgets, destroyWidgets, replaceBlock, selfTest };
