// Builds the prompt (context pack) for one `claude -p` edit call. Section names match
// references/edit-contract.md.

import fs from 'node:fs';
import path from 'node:path';
import { markFocus } from '../delta/selection.mjs';
import { resolveBoxTypes } from '../shared/render.mjs';
import { importWidget, otherLessons, resolveWidget } from '../lib/project.mjs';
import { chunksDir, pageFileName } from '../lib/refs.mjs';
import { parseSourceRef } from '../lib/validate.mjs';

const EXCERPT_BUDGET = 20_000;
const MAX_PAGES_PER_REF = 6;
const MAX_INBOUND = 30;

// opts = { root, config, lesson (the original, or the preview when refining), mode, instruction,
//          focus (resolved selection), maxRelated, previousSummaries?: [string], confirmedScope?: [id],
//          retry?: { output, diagnostics } }
export async function buildContextPack(opts) {
  const { root, config, lesson, mode, instruction, focus } = opts;
  const sections = [
    ['MODE', mode],
    ['INSTRUCTION', instruction],
    ['FOCUS', focusText(lesson, focus)],
    ['LESSON', lessonJson(withFocusMarkers(lesson, focus))],
    ['NOTATION', JSON.stringify(lesson.notation ?? {}, null, 1)],
    ['ANCHORS', anchorsText(lesson)],
    ['INBOUND', inboundText(root, lesson)],
    ['REFERENCES', referencesText(root, lesson, focus)],
    ['CONFIG', JSON.stringify(await configInfo(root, config, lesson, opts.maxRelated))],
  ];
  if (opts.previousSummaries?.length) sections.push(['PREVIOUS ROUNDS', previousText(opts.previousSummaries)]);
  if (opts.confirmedScope) sections.push(['CONFIRMED', confirmedText(opts.confirmedScope)]);
  if (opts.retry) sections.push(['ERRORS', retryText(opts.retry)]);
  return sections.map(([name, body]) => `=== ${name} ===\n${String(body).trim() || '(none)'}\n`).join('\n');
}

// ---------- focus ----------

function focusText(lesson, focus) {
  const lines = [`Focus block ids: ${focus.focusBlockIds.join(', ') || '(none)'}`];
  for (const r of focus.ranges) {
    if (r.whole) lines.push(`- ${r.blockId}: the whole block`);
    else lines.push(`- ${r.blockId}.${r.field}: ${JSON.stringify(r.exact)}${r.math.length ? ` (formulas: ${r.math.map((m) => `$${m}$`).join(', ')})` : ''}`);
  }
  const covered = new Set(focus.ranges.map((r) => r.blockId));
  for (const id of focus.focusBlockIds) if (!covered.has(id)) lines.push(`- ${id}: the whole block`);
  for (const w of focus.warnings ?? []) {
    if (w.code === 'selection_unresolved' && w.blockId) lines.push(`Note: the selected text in ${w.blockId} could not be located; the whole block is the focus.`);
  }
  if (!lesson.blocks.length) lines.push('The lesson has no blocks.');
  return lines.join('\n');
}

// Copy of the lesson with ⟦focus⟧ markers around each resolved range (later ranges first,
// so earlier offsets stay valid).
function withFocusMarkers(lesson, focus) {
  const copy = JSON.parse(JSON.stringify(lesson));
  const ranges = focus.ranges.filter((r) => !r.whole).sort((a, b) => b.start - a.start);
  for (const r of ranges) {
    const block = copy.blocks.find((b) => b.id === r.blockId);
    if (block && typeof block[r.field] === 'string') block[r.field] = markFocus(block[r.field], r.start, r.end);
  }
  return copy;
}

// One block per line keeps the JSON compact but readable.
function lessonJson(lesson) {
  const { blocks, ...head } = lesson;
  const headJson = JSON.stringify(head);
  return `${headJson.slice(0, -1)},"blocks":[\n${blocks.map((b) => JSON.stringify(b)).join(',\n')}\n]}`;
}

function anchorsText(lesson) {
  return lesson.blocks
    .filter((b) => b.type === 'heading')
    .map((b) => `#${b.anchor} (h${b.level}, ${b.id}): ${b.text}`)
    .join('\n');
}

// ---------- inbound references from other lessons ----------

const stringFields = (block) => Object.entries(block).filter(([k, v]) => k !== 'id' && k !== 'type' && typeof v === 'string').map(([, v]) => v);

function inboundText(root, lesson) {
  const linkRe = new RegExp(`lesson:${lesson.id}(#[a-z0-9-]+)?`, 'g');
  // One-character symbols (x, n) appear everywhere; only longer notation keys are traced.
  const symbols = Object.keys(lesson.notation ?? {}).filter((k) => k.length > 1);
  const found = [];
  for (const other of otherLessons(root, lesson.id)) {
    for (const block of other.blocks ?? []) {
      const text = stringFields(block).join('\n');
      const links = [...new Set([...text.matchAll(linkRe)].map((m) => m[0]))];
      const uses = symbols.filter((s) => text.includes(s));
      if (!links.length && !uses.length) continue;
      const why = [links.length && `links ${links.join(', ')}`, uses.length && `uses notation ${uses.join(', ')}`].filter(Boolean).join('; ');
      found.push(`- lesson ${other.id}, block ${block.id} (${why}):\n  ${JSON.stringify(block)}`);
    }
  }
  if (found.length > MAX_INBOUND) return [...found.slice(0, MAX_INBOUND), `(${found.length - MAX_INBOUND} more not shown)`].join('\n');
  return found.join('\n');
}

// ---------- references ----------

function referencesText(root, lesson, focus) {
  const focusIds = new Set(focus.focusBlockIds);
  const refs = [...new Set(lesson.blocks.filter((b) => focusIds.has(b.id)).flatMap((b) => b.sources ?? []))];
  let budget = EXCERPT_BUDGET;
  const parts = [];
  for (const ref of refs) {
    const excerpt = readExcerpt(root, ref);
    if (!excerpt) {
      parts.push(`--- ${ref} ---\n(no excerpt available)`);
      continue;
    }
    if (budget <= 0) {
      parts.push(`--- ${ref} ---\n(omitted: excerpt budget reached)`);
      continue;
    }
    const text = excerpt.length > budget ? `${excerpt.slice(0, budget)}\n(truncated)` : excerpt;
    budget -= text.length;
    parts.push(`--- ${ref} ---\n${text.trim()}`);
  }
  return parts.join('\n\n');
}

function readExcerpt(root, ref) {
  const parsed = parseSourceRef(ref);
  if (!parsed) return null;
  const dir = chunksDir(root, parsed.alias);
  const files = parsed.anchor
    ? [`${parsed.anchor}.md`]
    : Array.from({ length: Math.min(parsed.pageEnd - parsed.page + 1, MAX_PAGES_PER_REF) }, (_, i) => pageFileName(parsed.page + i));
  const texts = files.map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8'));
  return texts.length ? texts.join('\n') : null;
}

// ---------- config ----------

async function configInfo(root, config, lesson, maxRelated) {
  const boxTypes = Object.fromEntries(Object.entries(resolveBoxTypes(config)).map(([name, t]) => [name, t.label]));
  return {
    language: config.language,
    audience: config.audience ?? null,
    math: config.features?.math !== false,
    boxVariants: boxTypes,
    maxRelated,
    widgets: await widgetSchemas(root, lesson),
  };
}

async function widgetSchemas(root, lesson) {
  const names = [...new Set(lesson.blocks.filter((b) => b.type === 'widget').map((b) => b.widget))];
  const out = {};
  for (const name of names) {
    const widget = resolveWidget(root, name);
    if (!widget) continue;
    try {
      out[name] = (await importWidget(widget))?.propsSchema ?? null;
    } catch {
      out[name] = null;
    }
  }
  return out;
}

// ---------- rounds ----------

function previousText(summaries) {
  return [
    'This is a follow-up on changes the user has not accepted yet. LESSON above already includes them (it is the current preview); apply INSTRUCTION on top of it.',
    ...summaries.map((s, i) => `Round ${i + 1}: ${s}`),
  ].join('\n');
}

function confirmedText(scope) {
  return `The user approved changing these blocks: ${scope.join(', ')}. Return the changes now (maxRelated is raised accordingly).`;
}

function retryText({ output, diagnostics }) {
  return [
    'Your previous answer was rejected. Fix exactly these problems and return the full corrected answer.',
    ...diagnostics.map((d) => `- [${d.code}] ${d.message}`),
    '',
    'Previous answer:',
    JSON.stringify(output),
  ].join('\n');
}
