// Manual edit: the user types straight into one block's text fields (MANUAL_FIELDS) on the page,
// no Claude involved. Formulas stay atomic (they can be deleted, not typed into); the edited DOM is
// serialized back to field source (html whitelist, $…$ math, lesson: links) on save.

import { FIELD_KINDS, MANUAL_FIELDS } from '/static/shared/render.mjs';

const WHITELIST = await fetch('/static/schemas/html-whitelist.json').then((r) => r.json()).then((w) => w.html);
const ALLOWED_CLASSES = new Set(WHITELIST.classes);
const VERBATIM = new Set(['code', 'pre']);
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'ul', 'ol', 'table', 'tr', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4']);
const LINK_BASE = '/lessons/';

const escapeText = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeAttr = (s) => escapeText(s).replaceAll('"', '&quot;');
const isMath = (node) => node.nodeType === Node.ELEMENT_NODE && node.matches('span.math[data-latex]');
const isChrome = (node) => node.nodeType === Node.ELEMENT_NODE && node.matches('[data-chrome], [data-ld-ui]');
const mathSource = (el, escape) => {
  const fence = el.dataset.display === '1' ? '$$' : '$';
  return fence + escape(el.dataset.latex) + fence;
};

export const canEditManually = (block) => (MANUAL_FIELDS[block?.type] ?? []).length > 0;

// Plain text of a field: math as $…$, literal dollars as \$, line breaks as spaces (raw: kept).
function serializeText(field, kind) {
  let out = '';
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.data.replaceAll(' ', ' ');
        out += kind === 'raw' ? text : text.replaceAll('$', '\\$').replace(/\s*\n\s*/g, ' ');
      } else if (child.nodeType !== Node.ELEMENT_NODE || isChrome(child)) {
        continue;
      } else if (isMath(child)) {
        out += mathSource(child, (s) => s);
      } else if (child.localName === 'br') {
        out += kind === 'raw' ? '\n' : ' ';
      } else {
        if (kind === 'raw' && BLOCK_TAGS.has(child.localName) && out && !out.endsWith('\n')) out += '\n';
        walk(child);
      }
    }
  };
  walk(field);
  return kind === 'raw' ? out.replace(/\n$/, '') : out.replace(/ {2,}/g, ' ').trim();
}

// Whitelisted HTML of a field. Unknown elements are unwrapped (a stray <div> from the browser
// becomes a <p>), unknown attributes and classes dropped.
function serializeHtml(field) {
  const walk = (node, verbatim, inParagraph) => {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = escapeText(child.data.replaceAll(' ', ' '));
        out += verbatim ? text : text.replaceAll('$', '\\$');
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE || isChrome(child)) continue;
      if (isMath(child)) {
        out += mathSource(child, escapeText);
        continue;
      }
      const tag = child.localName;
      const allowedAttrs = WHITELIST.tags[tag];
      if (!allowedAttrs) {
        const inner = walk(child, verbatim, inParagraph || tag === 'div');
        out += tag === 'div' && !inParagraph ? (inner.trim() ? `<p>${inner}</p>` : '') : inner;
        continue;
      }
      let attrs = '';
      for (const name of allowedAttrs) {
        let value = child.getAttribute(name);
        if (value == null) continue;
        if (name === 'class') value = value.split(/\s+/).filter((c) => ALLOWED_CLASSES.has(c)).join(' ');
        if (name === 'href' && value.startsWith(LINK_BASE)) value = `lesson:${value.slice(LINK_BASE.length)}`;
        if (value) attrs += ` ${name}="${escapeAttr(value)}"`;
      }
      if (WHITELIST.voidTags.includes(tag)) {
        out += `<${tag}${attrs}>`;
        continue;
      }
      const inner = walk(child, verbatim || VERBATIM.has(tag), inParagraph || tag === 'p' || tag === 'li');
      // An emptied inline element (e.g. bold text deleted) leaves nothing behind.
      if (!inner && tag !== 'td' && tag !== 'th') continue;
      out += `<${tag}${attrs}>${inner}</${tag}>`;
    }
    return out;
  };
  return walk(field, false, false).trim();
}

export function serializeField(field, kind) {
  return kind === 'html' ? serializeHtml(field) : serializeText(field, kind);
}

// Starts editing `section` (the rendered `block`); onSave / onCancel run on ⌘/Ctrl+Enter / Esc.
// -> { fields(): changed fields { name: source }, focus() (keeps a caret already inside), stop() }
export function startManualEdit(section, block, { onSave, onCancel }) {
  const kinds = FIELD_KINDS[block.type];
  const editable = (MANUAL_FIELDS[block.type] ?? [])
    .map((name) => ({ name, kind: kinds[name], el: section.querySelector(`[data-field="${name}"]`) }))
    .filter((f) => f.el);
  const original = new Map(editable.map((f) => [f.name, serializeField(f.el, f.kind)]));
  const cleanups = [];
  const on = (target, type, fn) => {
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };

  section.classList.add('is-manual');
  document.execCommand('defaultParagraphSeparator', false, 'p');
  for (const { el, kind } of editable) {
    el.contentEditable = kind === 'html' ? 'true' : 'plaintext-only';
    el.spellcheck = false;
    for (const math of el.querySelectorAll('span.math[data-latex]')) math.contentEditable = 'false';
  }
  const details = section.querySelector('details');
  if (details) {
    details.open = true;
    // Clicking or pressing space in a <summary> toggles the <details>; while editing it types.
    on(details, 'toggle', () => { details.open = true; });
    const summary = details.querySelector('summary');
    on(summary, 'click', (e) => e.preventDefault());
    on(summary, 'keyup', (e) => { if (e.key === ' ') e.preventDefault(); });
  }

  on(section, 'keydown', (e) => {
    const field = editable.find((f) => f.el.contains(e.target));
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter' && field?.kind === 'plain') {
      e.preventDefault();
    } else if (e.key === ' ' && e.target.closest?.('summary')) {
      e.preventDefault();
      document.execCommand('insertText', false, ' ');
    }
  });
  // Pasted content arrives as plain text, so no foreign markup or styles get in.
  on(section, 'paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
  on(section, 'drop', (e) => e.preventDefault());

  return {
    fields() {
      const changed = {};
      for (const f of editable) {
        const value = serializeField(f.el, f.kind);
        if (value !== original.get(f.name)) changed[f.name] = value;
      }
      return changed;
    },
    focus() {
      const sel = getSelection();
      const inside = sel.rangeCount && editable.some((f) => f.el.contains(sel.anchorNode));
      const target = inside ? editable.find((f) => f.el.contains(sel.anchorNode)).el : editable[0]?.el;
      target?.focus({ preventScroll: true });
      if (!inside && target) sel.collapse(target, target.childNodes.length);
    },
    stop() {
      cleanups.forEach((fn) => fn());
      section.classList.remove('is-manual');
      for (const { el } of editable) el.removeAttribute('contenteditable');
    },
  };
}
