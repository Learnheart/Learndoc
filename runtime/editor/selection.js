// Selection gestures and mapping to the selection payload (contracts §5).
//
//   drag-select text      → per-field quotes; blocks between first and last are whole
//   click .ld-handle      → one whole block; Shift+click → contiguous range of blocks
//   Alt+drag              → rectangle; every block it touches, whole
//   drag inside a widget  → belongs to the widget, ignored here
//
// A selection model is
//   { blockIds, payload: { focusBlockIds, ranges }, mathCount, quote, range? }
// where quote = [{ blockId, whole?, parts: [{ text } | { latex }] }] feeds the prompt
// preview, and range (text selections only) feeds the highlight.

import { OBJ, textViewFromDom, domPointToIndex } from '/static/shared/textview.mjs';
import { ui, isUi } from './dom.js';

const CONTEXT_CHARS = 32;
const HIGHLIGHT = 'ld-selection';
const MATH = 'span.math[data-latex]';

// A boundary inside a rendered formula snaps to the formula's edge, so touching
// a formula selects all of it.
function snapOutOfMath(field, node, offset, side) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const math = el?.closest(MATH);
  if (!math || !field.contains(math)) return [node, offset];
  const index = Array.prototype.indexOf.call(math.parentNode.childNodes, math);
  return [math.parentNode, side === 'start' ? index : index + 1];
}

// Text-view slice [start, end) of a field as preview parts, plus the formula indices in it.
function slice(field, text, start, end) {
  const spans = field.querySelectorAll(MATH);
  let ordinal = [...text.slice(0, start)].filter((c) => c === OBJ).length;
  const mathIdx = [];
  const parts = [];
  let run = '';
  for (const char of text.slice(start, end)) {
    if (char !== OBJ) {
      run += char;
      continue;
    }
    const span = spans[ordinal++];
    if (run) parts.push({ text: run });
    run = '';
    mathIdx.push(Number(span?.dataset.math ?? ordinal - 1));
    parts.push({ latex: span?.dataset.latex ?? '' });
  }
  if (run) parts.push({ text: run });
  return { parts, mathIdx };
}

// All field text of a block as preview parts (for whole-block quotes and scope lists).
export function sectionParts(section) {
  return [...section.querySelectorAll('[data-field]')].flatMap((field) => {
    const { text } = textViewFromDom(field);
    return [...slice(field, text, 0, text.length).parts, { text: ' ' }];
  });
}

function fieldRange(blockId, field, range) {
  const { text } = textViewFromDom(field);
  let start = field.contains(range.startContainer)
    ? domPointToIndex(field, ...snapOutOfMath(field, range.startContainer, range.startOffset, 'start'))
    : 0;
  let end = field.contains(range.endContainer)
    ? domPointToIndex(field, ...snapOutOfMath(field, range.endContainer, range.endOffset, 'end'))
    : text.length;
  while (start < end && text[start] === ' ') start++;
  while (end > start && text[end - 1] === ' ') end--;
  if (start >= end) return null;
  const { parts, mathIdx } = slice(field, text, start, end);
  return {
    range: {
      blockId,
      field: field.dataset.field,
      quote: {
        exact: text.slice(start, end),
        prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
        suffix: text.slice(end, end + CONTEXT_CHARS),
      },
      mathIdx,
    },
    parts,
  };
}

function buildModel(entries, range = null) {
  const ranges = entries.flatMap((e) => e.ranges);
  const blockIds = entries.map((e) => e.blockId);
  return {
    blockIds,
    payload: { focusBlockIds: blockIds, ranges },
    mathCount: ranges.reduce((n, r) => n + (r.mathIdx?.length ?? 0), 0),
    quote: entries.flatMap((e) => e.quote),
    range,
  };
}

function wholeEntry(section) {
  const blockId = section.dataset.blockId;
  return { blockId, ranges: [{ blockId, whole: true }], quote: [{ blockId, whole: true, parts: sectionParts(section) }] };
}

// enabled(): gestures active right now. sectionOf(id): the block's section.
// onChange(model | null, point): point is in document coordinates, for placing the toolbar.
export function createSelection({ main, sectionOf, enabled, onChange }) {
  let current = null;
  let anchorBlockId = null;
  let downInWidget = false;
  let marquee = null;

  const blocks = () => [...main.querySelectorAll('section.ld-block[data-block-id]:not(.is-deleted)')];

  function fromRange(range) {
    const sections = blocks().filter((s) => range.intersectsNode(s));
    const entries = [];
    sections.forEach((section, i) => {
      const blockId = section.dataset.blockId;
      const fields = [...section.querySelectorAll('[data-field]')];
      const middle = i > 0 && i < sections.length - 1;
      if (middle || fields.length === 0) {
        entries.push(wholeEntry(section));
        return;
      }
      const hits = fields
        .filter((f) => range.intersectsNode(f))
        .map((f) => fieldRange(blockId, f, range))
        .filter(Boolean);
      // An edge block touched only in chrome or whitespace is not part of the selection.
      if (hits.length) {
        entries.push({ blockId, ranges: hits.map((x) => x.range), quote: [{ blockId, parts: hits.flatMap((x) => x.parts) }] });
      }
    });
    return entries.length ? buildModel(entries, range.cloneRange()) : null;
  }

  function set(model, point) {
    for (const el of main.querySelectorAll('.ld-block.is-selected')) el.classList.remove('is-selected');
    CSS.highlights?.delete(HIGHLIGHT);
    current = model;
    if (model) {
      for (const id of model.blockIds) sectionOf(id)?.classList.add('is-selected');
      if (model.range && CSS.highlights) CSS.highlights.set(HIGHLIGHT, new Highlight(model.range));
    }
    onChange(model, point);
  }

  function readNativeSelection() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) {
      if (current) set(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!main.contains(range.commonAncestorContainer)) return;
    const model = fromRange(range);
    if (!model) {
      set(null);
      return;
    }
    anchorBlockId = model.blockIds[0];
    const rects = range.getClientRects();
    const r = rects[rects.length - 1] ?? range.getBoundingClientRect();
    set(model, { x: r.left + scrollX, y: r.bottom + scrollY });
  }

  function selectBlocks(sections, point) {
    getSelection().removeAllRanges();
    set(buildModel(sections.map(wholeEntry)), point);
  }

  function onHandleClick(e) {
    const handle = e.target.closest('.ld-handle');
    if (!handle || !main.contains(handle) || !enabled()) return;
    const section = handle.closest('section[data-block-id]');
    const all = blocks();
    let sections = [section];
    const from = all.findIndex((s) => s.dataset.blockId === anchorBlockId);
    if (e.shiftKey && from >= 0) {
      const to = all.indexOf(section);
      sections = all.slice(Math.min(from, to), Math.max(from, to) + 1);
    } else {
      anchorBlockId = section.dataset.blockId;
    }
    const r = handle.getBoundingClientRect();
    selectBlocks(sections, { x: r.right + scrollX + 8, y: r.bottom + scrollY });
  }

  function startMarquee(e) {
    const box = ui('div', { class: 'ld-ed-marquee' });
    document.body.append(box);
    marquee = { x0: e.clientX, y0: e.clientY, box, rect: null };
    const move = (ev) => {
      const left = Math.min(marquee.x0, ev.clientX);
      const top = Math.min(marquee.y0, ev.clientY);
      marquee.rect = { left, top, right: Math.max(marquee.x0, ev.clientX), bottom: Math.max(marquee.y0, ev.clientY) };
      Object.assign(box.style, {
        left: `${left}px`, top: `${top}px`,
        width: `${marquee.rect.right - left}px`, height: `${marquee.rect.bottom - top}px`,
      });
    };
    marquee.stop = () => removeEventListener('mousemove', move);
    addEventListener('mousemove', move);
  }

  function finishMarquee(e) {
    const { rect, box, stop } = marquee;
    stop();
    box.remove();
    marquee = null;
    const hits = rect
      ? blocks().filter((s) => {
        const b = s.getBoundingClientRect();
        return b.left < rect.right && b.right > rect.left && b.top < rect.bottom && b.bottom > rect.top;
      })
      : [];
    if (hits.length) selectBlocks(hits, { x: e.clientX + scrollX, y: e.clientY + scrollY + 8 });
    else set(null);
  }

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || isUi(e.target)) return;
    if (e.target.closest('.ld-handle')) {
      e.preventDefault(); // a handle click must not start a text selection
      return;
    }
    downInWidget = !!e.target.closest('.ld-widget');
    if (e.altKey && enabled() && main.contains(e.target) && !downInWidget) {
      e.preventDefault();
      startMarquee(e);
    }
  }, true);

  document.addEventListener('mouseup', (e) => {
    if (marquee) {
      finishMarquee(e);
      return;
    }
    if (downInWidget) {
      downInWidget = false;
      return;
    }
    if (e.button !== 0 || isUi(e.target) || e.target.closest('.ld-handle') || !enabled()) return;
    setTimeout(readNativeSelection); // let the browser finalize the selection first
  }, true);

  document.addEventListener('keyup', (e) => {
    if (e.key.startsWith('Arrow') && e.shiftKey && enabled() && !isUi(document.activeElement)) readNativeSelection();
  });

  main.addEventListener('click', onHandleClick);

  return {
    get current() {
      return current;
    },
    clear() {
      if (current) set(null);
    },
  };
}
