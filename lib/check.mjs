// Content checks that need more than the schema: KaTeX parsing, HTML/SVG whitelists, links and anchors,
// course consistency.
import fs from 'node:fs';
import katex from '../runtime/vendor/katex/katex.mjs';
import { diagnostic } from './diagnostics.mjs';
import { COURSE_FILE, lessonFile, readJson } from './project.mjs';
import { readEntity, tokenize } from '../shared/html.mjs';
import { FIELD_KINDS, segmentField } from '../shared/render.mjs';

const WHITELIST = JSON.parse(fs.readFileSync(new URL('../schemas/html-whitelist.json', import.meta.url), 'utf8'));

// Diagnostics for one field: the message is prefixed with `where`, `subject` locates the field.
// -> report(code, message, supportedFixes, extra?) where extra may set severity, evidence or subject.
function reporter(where, subject) {
  return (code, message, supportedFixes, extra = {}) => diagnostic({ code, message: `${where}: ${message}`, subject, supportedFixes, ...extra });
}

// -> a diagnostic, or null when KaTeX parses the formula.
function katexDiagnostic(latex, display, report) {
  // KaTeX warns on the console about missing font metrics for non-Latin text in \text{…}; the browser
  // falls back to system fonts, so those warnings are noise here.
  const { warn } = console;
  console.warn = () => {};
  try {
    katex.renderToString(latex, { displayMode: display, throwOnError: true, strict: 'ignore' });
    return null;
  } catch (error) {
    return report('math/katex', `KaTeX cannot parse ${JSON.stringify(latex.slice(0, 120))}: ${error.message}`,
      ['fix the LaTeX so KaTeX can parse it', 'write a literal < inside math as \\lt or &lt;'],
      { evidence: { latex: latex.slice(0, 300) } });
  } finally {
    console.warn = warn;
  }
}

// `inMath(offset)` tells whether an offset lies inside $…$ / $$…$$, where a bare & is LaTeX
// (matrix columns); math is escaped into its span and is one OBJ in the text view, so it cannot drift.
function entityDiagnostics(src, start, end, report, inMath) {
  const out = [];
  for (let i = src.indexOf('&', start); i >= 0 && i < end; i = src.indexOf('&', i + 1)) {
    const entity = readEntity(src, i);
    if (entity && entity.value == null) {
      out.push(report('html/entity', `unsupported entity ${src.slice(i, i + entity.length)}`,
        ['write the character itself (UTF-8) instead of the named entity', 'use &amp; &lt; &gt; &quot; &nbsp; or a numeric entity']));
    } else if (!entity && /[A-Za-z]/.test(src[i + 1] ?? '') && !inMath(i)) {
      // Browsers decode legacy entities without ';' (&copy 2024 → © 2024); the source text view would not.
      const excerpt = src.length > i + 12 ? `${src.slice(i, i + 12)}…` : src.slice(i);
      out.push(report('html/entity', `"${excerpt}": an & followed by a letter must be written as &amp; (or as a complete entity ending in ;)`,
        ['write & as &amp;'], { evidence: { offset: i } }));
    }
  }
  return out;
}

// Walks a tag stream checking syntax, entities and balance; `allowed(token)` returns diagnostics for one open tag.
function checkMarkup(src, { prefix, voidTags, report, allowed, inMath = () => false }) {
  const out = [];
  const stack = [];
  for (const token of tokenize(src)) {
    if (token.type === 'error') {
      out.push(report(`${prefix}/syntax`, `${token.message} (offset ${token.start})`,
        ["escape a literal '<' as &lt;", 'inside math use \\lt'],
        { evidence: { excerpt: src.slice(Math.max(0, token.start - 20), token.start + 40) } }));
    } else if (token.type === 'text') {
      out.push(...entityDiagnostics(src, token.start, token.end, report, inMath));
    } else if (token.type === 'open') {
      out.push(...allowed(token));
      if (!voidTags.has(token.name) && !token.selfClosing) stack.push(token.name);
    } else if (stack.at(-1) === token.name) {
      stack.pop();
    } else {
      // Recover at the matching open tag so one mistake is reported once.
      const depth = stack.lastIndexOf(token.name);
      const unclosed = depth >= 0 ? stack.splice(depth).slice(1) : [];
      out.push(report(`${prefix}/unbalanced`, depth >= 0
        ? `${unclosed.map((name) => `<${name}>`).join(', ')} not closed before </${token.name}>`
        : `closing </${token.name}> has no matching open tag`,
      ['close tags in the reverse order they were opened']));
    }
  }
  if (stack.length) {
    out.push(report(`${prefix}/unbalanced`, `unclosed ${stack.map((name) => `<${name}>`).join(', ')}`, ['close every opened tag']));
  }
  return out;
}

function linkDiagnostics(href, { lessonAnchors, targetAnchors, report, subject }) {
  const fail = (code, message, supportedFixes, extra = {}) => [report(code, message, supportedFixes, { subject: { ...subject, href }, ...extra })];
  if (href.startsWith('#')) {
    return lessonAnchors.has(href.slice(1)) ? []
      : fail('links/unknown-anchor', `link ${href} does not match any heading anchor in this lesson`, ['link to an existing heading anchor']);
  }
  if (href.startsWith('lesson:')) {
    const [id, anchor] = href.slice('lesson:'.length).split('#');
    const target = targetAnchors(id);
    if (target.status === 'unknown') {
      return fail('links/unknown-lesson', `link ${href} points to lesson "${id}", which is not in course.json`, ['link to a lesson listed in course.json']);
    }
    if (target.status === 'unavailable') {
      return fail('links/target-unavailable', `link ${href} points to lesson "${id}", which has no valid lesson file yet`,
        ['write that lesson, or remove the link'], { severity: 'warning' });
    }
    if (anchor !== undefined && !target.anchors.has(anchor)) {
      return fail('links/unknown-anchor', `link ${href}: lesson "${id}" has no heading anchor "${anchor}"`, [`use one of ${JSON.stringify([...target.anchors].slice(0, 20))}`]);
    }
    return [];
  }
  if (href.startsWith('https://')) return [];
  const insecure = href.startsWith('http://');
  return fail(insecure ? 'links/insecure' : 'links/scheme',
    `link ${JSON.stringify(href)} is not allowed; use https://…, #anchor or lesson:<id>[#anchor]`,
    insecure ? ['use https://'] : ['use https://…, #anchor or lesson:<id>[#anchor]']);
}

const HTML_TAGS = WHITELIST.html.tags;
const HTML_CLASSES = new Set(WHITELIST.html.classes);

function htmlFieldDiagnostics(src, ctx) {
  const { report } = ctx;
  const allowed = (token) => {
    if (!Object.hasOwn(HTML_TAGS, token.name)) {
      return [report('html/tag', `<${token.name}> is not allowed`, [`use only ${Object.keys(HTML_TAGS).join(', ')}`])];
    }
    const out = [];
    if (token.selfClosing && !WHITELIST.html.voidTags.includes(token.name)) {
      out.push(report('html/syntax', `<${token.name}/> cannot be self-closing`, [`write <${token.name}>…</${token.name}>`]));
    }
    for (const attr of token.attrs) {
      if (!HTML_TAGS[token.name].includes(attr.name)) {
        out.push(report('html/attribute', `attribute ${attr.name} is not allowed on <${token.name}>`, [`remove ${attr.name}`]));
      } else if (attr.value == null) {
        out.push(report('html/attribute', `attribute ${attr.name} on <${token.name}> needs a quoted value`, [`write ${attr.name}="…"`]));
      } else if (attr.name === 'class') {
        for (const name of attr.value.split(/\s+/).filter(Boolean)) {
          if (!HTML_CLASSES.has(name)) out.push(report('html/class', `class "${name}" is not allowed`, [`use only ${[...HTML_CLASSES].join(', ')}`]));
        }
      } else if (attr.name === 'colspan' && !/^[1-9][0-9]?$/.test(attr.value)) {
        out.push(report('html/attribute', `colspan="${attr.value}" must be a positive integer`, ['use colspan="2" (1–99)']));
      } else if (attr.name === 'href') {
        out.push(...linkDiagnostics(attr.value, ctx));
      }
    }
    return out;
  };
  const math = segmentField(src, 'html').segments.filter((segment) => segment.type === 'math');
  const inMath = (offset) => math.some((segment) => offset >= segment.start && offset < segment.end);
  return checkMarkup(src, { prefix: 'html', voidTags: new Set(WHITELIST.html.voidTags), report, allowed, inMath });
}

const SVG_TAGS = WHITELIST.svg.tags;
const SVG_PRESENTATION = new Set(WHITELIST.svg.presentationAttributes);
const SVG_CLASSES = new Set(WHITELIST.svg.classes);

function svgDiagnostics(svg, report) {
  const out = [];
  const tokens = tokenize(svg).filter((token) => token.type !== 'text' || svg.slice(token.start, token.end).trim());
  const first = tokens[0];
  const last = tokens.at(-1);
  if (first?.type !== 'open' || first.name !== 'svg' || last?.type !== 'close' || last.name !== 'svg') {
    out.push(report('svg/root', 'svg must be a single <svg>…</svg> element', ['wrap the drawing in one <svg> element with nothing before or after it']));
  }
  const ids = new Set();
  const references = [];
  const allowed = (token) => {
    if (!Object.hasOwn(SVG_TAGS, token.name)) {
      return [report('svg/tag', `<${token.name}> is not allowed in svg`, [`use only ${Object.keys(SVG_TAGS).join(', ')}`])];
    }
    const tagOut = [];
    for (const attr of token.attrs) {
      if (!SVG_TAGS[token.name].includes(attr.name) && !SVG_PRESENTATION.has(attr.name)) {
        tagOut.push(report('svg/attribute', `attribute ${attr.name} is not allowed on <${token.name}>`,
          [`remove ${attr.name}`, 'style with the allowed classes c1..c6, fill-soft, stroke-only, axis, grid, muted']));
        continue;
      }
      const value = attr.value ?? '';
      if (attr.name === 'id') ids.add(value);
      if (attr.name === 'class') {
        for (const name of value.split(/\s+/).filter(Boolean)) {
          if (!SVG_CLASSES.has(name)) tagOut.push(report('svg/class', `svg class "${name}" is not allowed`, [`use only ${[...SVG_CLASSES].join(', ')}`]));
        }
      }
      for (const match of value.matchAll(/url\(\s*([^)]*?)\s*\)/g)) references.push(match[1]);
    }
    return tagOut;
  };
  out.push(...checkMarkup(svg, { prefix: 'svg', voidTags: new Set(), report, allowed }));
  for (const reference of references) {
    if (!reference.startsWith('#') || !ids.has(reference.slice(1))) {
      out.push(report('svg/reference', `url(${reference}) must reference an id defined in the same svg (url(#id))`, ['define the marker/clipPath in <defs> with that id']));
    }
  }
  return out;
}

function plainFieldDiagnostics(value, report) {
  const out = [];
  const text = segmentField(value, 'plain').segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => value.slice(segment.start, segment.end))
    .join(' ');
  if (/<[A-Za-z/!]/.test(text)) {
    out.push(report('plain/tag', 'plain text fields cannot contain HTML tags', ['remove the tags; plain fields may only contain text and $…$ math']));
  }
  const entity = /&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9a-fA-F]+);/.exec(text);
  if (entity) {
    out.push(report('plain/entity', `plain fields are not HTML, so ${entity[0]} is shown literally`,
      ['write the character itself (for example & or <)'], { severity: 'warning' }));
  }
  return out;
}

// Anchors of other lessons, loaded lazily. -> (id) => { status: 'ok'|'unknown'|'unavailable', anchors }
function targetAnchorLookup(root, course) {
  const cache = new Map();
  const listed = new Set(course?.modules.flatMap((module) => module.lessons.map((lesson) => lesson.id)) ?? []);
  return (id) => {
    if (!cache.has(id)) {
      let entry = { status: 'unknown', anchors: new Set() };
      if (listed.has(id)) {
        const { value } = readJson(lessonFile(root, id), { root });
        entry = Array.isArray(value?.blocks)
          ? { status: 'ok', anchors: new Set(value.blocks.filter((b) => b.type === 'heading').map((b) => b.anchor)) }
          : { status: 'unavailable', anchors: new Set() };
      }
      cache.set(id, entry);
    }
    return cache.get(id);
  };
}

// ctx = { root, file (project-relative), course? }
export function checkLesson(lesson, { root, file, course }) {
  const out = [];
  const lessonAnchors = new Set(lesson.blocks.filter((block) => block.type === 'heading').map((block) => block.anchor));
  const targetAnchors = targetAnchorLookup(root, course);
  const pushKatex = (latex, display, report) => {
    const problem = katexDiagnostic(latex, display, report);
    if (problem) out.push(problem);
  };
  for (const block of lesson.blocks) {
    for (const [field, kind] of Object.entries(FIELD_KINDS[block.type])) {
      const value = block[field];
      if (typeof value !== 'string') continue;
      const subject = { file, id: block.id, field };
      const report = reporter(`${file}: block ${block.id} ${field}`, subject);
      if (kind === 'raw') {
        if (block.type === 'math') pushKatex(value, true, report);
        continue;
      }
      out.push(...(kind === 'html'
        ? htmlFieldDiagnostics(value, { report, subject, lessonAnchors, targetAnchors })
        : plainFieldDiagnostics(value, report)));
      for (const segment of segmentField(value, kind).segments) {
        if (segment.type === 'math') pushKatex(segment.latex, segment.display, report);
      }
    }
    if (block.type === 'figure' && typeof block.svg === 'string') {
      out.push(...svgDiagnostics(block.svg, reporter(`${file}: block ${block.id} svg`, { file, id: block.id, field: 'svg' })));
    }
  }
  return out;
}

export function checkCourse(course, { root }) {
  const out = [];
  const lessons = course.modules.flatMap((module) => module.lessons);
  const ids = new Set(lessons.map((lesson) => lesson.id));
  for (const lesson of lessons) {
    for (const prereq of lesson.prereq || []) {
      if (ids.has(prereq) && prereq !== lesson.id) continue;
      out.push(diagnostic({
        code: 'course/unknown-prereq',
        message: `${COURSE_FILE}: lesson "${lesson.id}" lists prereq "${prereq}", which is ${prereq === lesson.id ? 'the lesson itself' : 'not a lesson in this course'}`,
        subject: { file: COURSE_FILE, lesson: lesson.id, prereq },
        supportedFixes: ['list only other lesson ids from course.json as prereq'],
      }));
    }
    if (lesson.status === 'done' && !fs.existsSync(lessonFile(root, lesson.id))) {
      out.push(diagnostic({
        code: 'course/missing-lesson-file',
        message: `${COURSE_FILE}: lesson "${lesson.id}" is marked done but lessons/${lesson.id}.json does not exist`,
        subject: { file: COURSE_FILE, lesson: lesson.id },
        supportedFixes: [`write lessons/${lesson.id}.json`, 'set its status to "planned"'],
      }));
    }
  }
  return out;
}
