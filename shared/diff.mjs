// Sentence-level diff of one field for the changeset preview. Isomorphic: no node: imports.
import { escapeHtml } from './html.mjs';
import { renderSegments, segmentField } from './render.mjs';

const SENTENCE_END = /[.!?:]\s+/g;

// Splits a text segment after sentence punctuation followed by whitespace (and after newlines for raw).
function splitText(src, segment, pattern) {
  const pieces = [];
  let start = segment.start;
  pattern.lastIndex = 0;
  const text = src.slice(segment.start, segment.end);
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const end = segment.start + match.index + match[0].length;
    pieces.push({ ...segment, start, end, boundary: true });
    start = end;
  }
  if (start < segment.end) pieces.push({ ...segment, start, end: segment.end, boundary: false });
  return pieces;
}

// -> [{ tag: boolean, segments, key }]
function units(src, kind) {
  const segments = kind === 'raw'
    ? [{ type: 'text', start: 0, end: src.length }]
    : segmentField(src, kind).segments;
  const pattern = kind === 'raw' ? /[.!?:][ \t]+|\n/g : SENTENCE_END;
  const result = [];
  let current = null;
  const close = () => {
    if (current) result.push(current);
    current = null;
  };
  for (const segment of segments) {
    if (segment.type === 'tag') {
      close();
      result.push({ tag: true, segments: [segment] });
      continue;
    }
    const pieces = segment.type === 'text' ? splitText(src, segment, pattern) : [segment];
    for (const piece of pieces) {
      current ??= { tag: false, segments: [] };
      current.segments.push(piece);
      if (piece.boundary) close();
    }
  }
  close();
  for (const unit of result) {
    const raw = unit.segments.map((s) => {
      const { start, end } = s.type === 'tag' || s.type === 'error' ? s.token : s;
      return src.slice(start, end);
    }).join('');
    unit.key = raw.replace(/\s+/g, ' ').trim();
  }
  return result;
}

// Longest common subsequence over unit keys -> [{ op: 'equal'|'del'|'ins', unit }] in document order.
function diffUnits(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i].key === b[j].key
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].key === b[j].key) {
      ops.push({ op: 'equal', unit: b[j], src: 'new' });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      ops.push({ op: 'del', unit: a[i++], src: 'old' });
    } else {
      ops.push({ op: 'ins', unit: b[j++], src: 'new' });
    }
  }
  while (i < a.length) ops.push({ op: 'del', unit: a[i++], src: 'old' });
  while (j < b.length) ops.push({ op: 'ins', unit: b[j++], src: 'new' });
  return ops;
}

export function diffField(oldSrc, newSrc, kind) {
  const sources = { old: oldSrc, new: newSrc };
  const counter = { n: 0 };
  let out = '';
  for (const { op, unit, src } of diffUnits(units(oldSrc, kind), units(newSrc, kind))) {
    // Removed tags are dropped and added tags kept, so the output follows the new structure.
    if (unit.tag && op === 'del') continue;
    const html = kind === 'raw'
      ? escapeHtml(unit.segments.map((s) => sources[src].slice(s.start, s.end)).join(''))
      : renderSegments(sources[src], kind, unit.segments, { counter });
    if (op === 'equal' || unit.tag || !unit.key) out += html;
    else out += op === 'del' ? `<del class="ld-del">${html}</del>` : `<ins class="ld-ins">${html}</ins>`;
  }
  return out;
}
