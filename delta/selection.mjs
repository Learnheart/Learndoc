// Resolve an editor selection (block ids + text quotes) to offsets in the lesson source.
// Isomorphic: no node: imports.

import { textViewFromSource, OBJ } from '../shared/textview.mjs';
import { FIELD_KINDS, segmentField } from '../shared/render.mjs';
import { readEntity } from '../shared/html.mjs';

const FOCUS_OPEN = '⟦focus⟧';
const FOCUS_CLOSE = '⟦/focus⟧';

const DEFAULT_FIELD = {
  heading: 'text', prose: 'html', box: 'html', math: 'latex', code: 'code', figure: 'caption', quiz: 'question',
};

export function resolveSelection(lesson, selection) {
  const byId = new Map(lesson.blocks.map((b) => [b.id, b]));
  const warnings = [];
  const unresolved = (blockId, field = null) => warnings.push({ code: 'selection_unresolved', blockId, field });
  const ranges = [];

  for (const range of selection?.ranges ?? []) {
    const block = byId.get(range.blockId);
    if (!block) {
      unresolved(range.blockId ?? null, range.field ?? null);
      continue;
    }
    if (range.whole) {
      ranges.push({ blockId: block.id, whole: true });
      continue;
    }
    const field = range.field ?? DEFAULT_FIELD[block.type];
    const kind = FIELD_KINDS[block.type]?.[field];
    const resolved = kind && typeof block[field] === 'string' ? resolveRange(block[field], kind, range) : null;
    if (resolved) ranges.push({ blockId: block.id, field, ...resolved });
    else {
      unresolved(block.id, field ?? null);
      ranges.push({ blockId: block.id, whole: true });
    }
  }

  const focusBlockIds = [];
  for (const id of [...(selection?.focusBlockIds ?? []), ...ranges.map((r) => r.blockId)]) {
    if (focusBlockIds.includes(id)) continue;
    if (byId.has(id)) focusBlockIds.push(id);
    else if (!warnings.some((w) => w.blockId === id)) unresolved(id);
  }
  return { focusBlockIds, ranges, warnings };
}

function resolveRange(source, kind, { quote, mathIdx = [] }) {
  const exact = quote?.exact ?? '';
  if (!exact.trim()) return null;
  const view = textViewFromSource(source, kind);
  const hit = findQuote(view.text, exact, quote, mathIdx);
  if (!hit) return null;
  const units = atoms(source, kind);
  const start = view.map[hit.start];
  const end = unitEnd(units, view.map[hit.end - 1]);
  const [from, to] = widen(units, start, end);
  const latex = mathLatex(source, kind);
  return {
    start: from,
    end: to,
    exact: view.text.slice(hit.start, hit.end),
    math: mathIdx.map((n) => latex[n]).filter((x) => x !== undefined),
  };
}

// ---------- quote search ----------

function findQuote(text, exact, quote, mathIdx) {
  const best = (hits) => pickBest(hits, text, quote, exact.includes(OBJ) ? mathIdx[0] : undefined);
  const exactHits = occurrences(text, exact).map((start) => ({ start, end: start + exact.length }));
  if (exactHits.length) return best(exactHits);

  // Fallback: compare with whitespace and punctuation removed and case folded.
  const hay = normalized(text);
  const needle = normalized(exact).chars;
  if (!needle) return null;
  const hits = occurrences(hay.chars, needle).map((k) => ({ start: hay.index[k], end: hay.index[k + needle.length - 1] + 1 }));
  return hits.length ? best(hits) : null;
}

function occurrences(hay, needle) {
  const found = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) found.push(i);
  return found;
}

function normalized(text) {
  let chars = '';
  const index = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/[\s\p{P}]/u.test(c)) continue;
    const lower = c.toLowerCase();
    chars += lower.length === 1 ? lower : c;
    index.push(i);
  }
  return { chars, index };
}

// Score = matched prefix chars + matched suffix chars; when the quote contains a formula
// and the editor sent its index, the occurrence starting at that formula wins.
function pickBest(hits, text, quote, firstMath) {
  const prefix = quote.prefix ?? '';
  const suffix = quote.suffix ?? '';
  const score = ({ start, end }) => {
    let s = commonSuffix(text.slice(0, start), prefix) + commonPrefix(text.slice(end), suffix);
    if (firstMath !== undefined && countObjBefore(text, text.indexOf(OBJ, start)) === firstMath) s += 1000;
    return s;
  };
  return hits.reduce((a, b) => (score(b) > score(a) ? b : a));
}

const countObjBefore = (text, at) => text.slice(0, at).split(OBJ).length - 1;

function commonSuffix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// ---------- source structure ----------

// Atomic source units that a range may not cut: tags, math (`$…$`, `$$…$$`), entities, `\$`.
// Segmentation is the renderer's, so the rules match what the page shows.
function atoms(source, kind) {
  if (kind === 'raw') return [];
  const found = [];
  for (const segment of segmentField(source, kind).segments) {
    if (segment.type === 'math') found.push(segment);
    else if (segment.type === 'tag' || segment.type === 'error') found.push(segment.token);
    else found.push(...textAtoms(source, segment, kind));
  }
  return found;
}

function textAtoms(source, { start, end, verbatim }, kind) {
  const found = [];
  for (let i = start; i < end; i++) {
    if (!verbatim && source[i] === '\\' && source[i + 1] === '$') {
      found.push({ start: i, end: i + 2 });
      i += 1;
    } else if (kind === 'html' && source[i] === '&') {
      const entity = readEntity(source, i);
      if (entity?.value != null) {
        found.push({ start: i, end: i + entity.length });
        i += entity.length - 1;
      }
    }
  }
  return found;
}

function mathLatex(source, kind) {
  if (kind === 'raw') return [source];
  return segmentField(source, kind).segments.filter((s) => s.type === 'math').map((s) => s.latex);
}

// End offset of the source unit that starts at `at` (one text-view character).
function unitEnd(units, at) {
  const atom = units.find((a) => a.start === at);
  return atom ? atom.end : at + 1;
}

function widen(units, start, end) {
  for (const a of units) {
    if (start > a.start && start < a.end) start = a.start;
    if (end > a.start && end < a.end) end = a.end;
  }
  return [start, end];
}

export function markFocus(fieldSource, start, end) {
  return fieldSource.slice(0, start) + FOCUS_OPEN + fieldSource.slice(start, end) + FOCUS_CLOSE + fieldSource.slice(end);
}
