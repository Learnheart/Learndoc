// Flat text view of one field, computed identically from the source string (Node or browser) and from
// the rendered DOM (browser), so a DOM selection can be mapped back to source offsets.
// Isomorphic: no node: imports; the DOM functions touch DOM APIs only when called.
import { readEntity } from './html.mjs';
import { segmentField } from './render.mjs';

export const OBJ = '\ufffc';

const BLOCK_TAGS = new Set(['p', 'li', 'ul', 'ol', 'table', 'tr', 'td', 'th', 'pre', 'blockquote', 'br', 'div']);
const WHITESPACE = /\s/; // includes U+00A0

// raw: [{ ch, at }] where `at` is a source offset or a DOM point. Collapses whitespace runs to one
// space (positioned at the run's first character) and trims both ends.
// -> { chars, rawToText } where rawToText[r] is the text index for raw index r (dropped chars map
// to the next kept character).
function collapse(raw) {
  const chars = [];
  const rawToText = new Int32Array(raw.length + 1);
  let pendingSpace = null;
  for (let r = 0; r < raw.length; r++) {
    const item = raw[r];
    if (WHITESPACE.test(item.ch)) {
      if (chars.length && !pendingSpace) pendingSpace = { ch: ' ', at: item.at, raw: r };
      rawToText[r] = chars.length;
      continue;
    }
    if (pendingSpace) {
      rawToText[pendingSpace.raw] = chars.length;
      chars.push(pendingSpace);
      pendingSpace = null;
    }
    rawToText[r] = chars.length;
    chars.push(item);
  }
  rawToText[raw.length] = chars.length;
  return { chars, rawToText };
}

function pushText(raw, src, start, end, { entities, dollars }) {
  for (let i = start; i < end; i++) {
    if (dollars && src[i] === '\\' && src[i + 1] === '$') {
      raw.push({ ch: '$', at: i });
      i += 1;
      continue;
    }
    if (entities && src[i] === '&') {
      const entity = readEntity(src, i);
      if (entity?.value != null) {
        // Per UTF-16 unit, like DOM text offsets.
        for (let k = 0; k < entity.value.length; k++) raw.push({ ch: entity.value[k], at: i });
        i += entity.length - 1;
        continue;
      }
    }
    raw.push({ ch: src[i], at: i });
  }
}

export function textViewFromSource(str, kind) {
  const raw = [];
  if (kind === 'raw') {
    pushText(raw, str, 0, str.length, { entities: false, dollars: false });
  } else {
    for (const segment of segmentField(str, kind).segments) {
      if (segment.type === 'math') {
        raw.push({ ch: OBJ, at: segment.start });
      } else if (segment.type === 'text') {
        pushText(raw, str, segment.start, segment.end, { entities: kind === 'html', dollars: !segment.verbatim });
      } else if (segment.type === 'tag' && BLOCK_TAGS.has(segment.token.name.toLowerCase())) {
        raw.push({ ch: ' ', at: segment.token.start });
      } else if (segment.type === 'error') {
        raw.push({ ch: '<', at: segment.token.start });
      }
    }
  }
  const { chars } = collapse(raw);
  const map = new Int32Array(chars.length + 1);
  chars.forEach((item, i) => { map[i] = item.at; });
  map[chars.length] = str.length;
  return { text: chars.map((item) => item.ch).join(''), map };
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function isMathSpan(el) {
  return el.tagName === 'SPAN' && el.classList.contains('math') && el.hasAttribute('data-math');
}

// Walks a rendered field element. -> { raw, enter, inner, exit } where enter/exit map a visited node
// to its raw index before/after it, and inner maps an element to the raw index after its opening boundary.
function walkDom(fieldEl) {
  const raw = [];
  const enter = new Map();
  const inner = new Map();
  const exit = new Map();
  const visit = (node) => {
    enter.set(node, raw.length);
    if (node.nodeType === TEXT_NODE) {
      const data = node.data;
      for (let i = 0; i < data.length; i++) raw.push({ ch: data[i], at: { node, offset: i } });
    } else if (node.nodeType === ELEMENT_NODE && !node.hasAttribute('data-chrome')) {
      const parent = node.parentNode;
      const index = Array.prototype.indexOf.call(parent.childNodes, node);
      if (isMathSpan(node)) {
        raw.push({ ch: OBJ, at: { node: parent, offset: index } });
      } else {
        const block = BLOCK_TAGS.has(node.tagName.toLowerCase());
        if (block) raw.push({ ch: ' ', at: { node: parent, offset: index } });
        inner.set(node, raw.length);
        for (const child of node.childNodes) visit(child);
        if (block) raw.push({ ch: ' ', at: { node: parent, offset: index + 1 } });
      }
    }
    exit.set(node, raw.length);
  };
  inner.set(fieldEl, 0);
  for (const child of fieldEl.childNodes) visit(child);
  return { raw, enter, inner, exit };
}

export function textViewFromDom(fieldEl) {
  const { raw } = walkDom(fieldEl);
  const { chars } = collapse(raw);
  const points = chars.map((item) => item.at);
  points.push({ node: fieldEl, offset: fieldEl.childNodes.length });
  return { text: chars.map((item) => item.ch).join(''), points };
}

// A point inside a math span or a data-chrome element maps to the index of that element
// (for math: the index of its OBJ character).
export function domPointToIndex(fieldEl, node, offset) {
  const walk = walkDom(fieldEl);
  const { rawToText } = collapse(walk.raw);
  let skipped = null;
  for (let n = node; n && n !== fieldEl; n = n.parentNode) {
    if (n.nodeType === ELEMENT_NODE && (n.hasAttribute('data-chrome') || isMathSpan(n))) skipped = n;
  }
  let r;
  if (skipped) {
    r = walk.enter.get(skipped);
  } else if (node.nodeType === TEXT_NODE) {
    r = walk.enter.get(node) + Math.min(offset, node.data.length);
  } else if (offset < node.childNodes.length) {
    r = walk.enter.get(node.childNodes[offset]);
  } else {
    r = node.lastChild ? walk.exit.get(node.lastChild) : walk.inner.get(node);
  }
  return rawToText[r ?? 0];
}
