// Schema validation (precompiled validators) + semantic checks for learndoc.json, course.json and lessons.
import fs from 'node:fs';
import path from 'node:path';
import { diagnostic } from './diagnostics.mjs';
import * as validators from './generated-validators.mjs';
import { CONFIG_FILE, COURSE_FILE, importWidget, relativePath, resolveWidget } from './project.mjs';
import { validate as validateProps } from '../shared/mini-schema.mjs';
import { DEFAULT_BOX_TYPES, FIELD_KINDS, segmentField } from '../shared/render.mjs';

// "/blocks/3/html" reads better as "/blocks/3 (id: "b-91c2")/html" for whoever fixes the JSON.
function annotatedPath(instancePath, data) {
  let node = data;
  let identity = null;
  for (const segment of instancePath.split('/').slice(1)) {
    if (node == null || typeof node !== 'object') break;
    node = node[/^\d+$/.test(segment) ? Number(segment) : segment];
    if (node && typeof node === 'object' && !Array.isArray(node) && typeof node.id === 'string') identity = node.id;
  }
  return { path: instancePath || '/', identity };
}

function supportedFixes(error, where) {
  const p = error.params || {};
  return {
    additionalProperties: [`remove unsupported property ${JSON.stringify(p.additionalProperty)}`],
    required: [`add required property ${JSON.stringify(p.missingProperty)}`],
    type: [`use ${JSON.stringify(p.type)} at ${where}`],
    const: [`use ${JSON.stringify(p.allowedValue)}`],
    enum: [`choose one of ${JSON.stringify(p.allowedValues)}`],
    pattern: [`match the required pattern ${JSON.stringify(p.pattern)}`],
    minimum: [`use a value ${p.comparison || '>='} ${p.limit}`],
    maximum: [`use a value ${p.comparison || '<='} ${p.limit}`],
    minItems: [`provide at least ${p.limit} item(s)`],
    maxItems: [`provide at most ${p.limit} item(s)`],
    minLength: [`provide at least ${p.limit} character(s)`],
    maxLength: [`provide at most ${p.limit} character(s)`],
    uniqueItems: ['remove the duplicate item'],
  }[error.keyword] || [];
}

// Ajv errors -> diagnostics. `if` and `discriminator` errors only restate a sibling error, so they are dropped.
export function schemaDiagnostics(name, data, file) {
  const validate = validators[name];
  if (!validate) throw new Error(`schemaDiagnostics: unknown schema "${name}"`);
  if (validate(data)) return [];
  return validate.errors
    .filter((error) => error.keyword !== 'if' && error.keyword !== 'discriminator')
    .map((error) => {
      const { path: where, identity } = annotatedPath(error.instancePath, data);
      const label = identity ? `${where} (id: ${JSON.stringify(identity)})` : where;
      return diagnostic({
        code: `schema/${error.keyword}`,
        message: `${file}: ${label} ${error.message}`,
        subject: { file, path: where, ...(identity ? { id: identity } : {}) },
        evidence: { keyword: error.keyword, ...error.params },
        supportedFixes: supportedFixes(error, where),
      });
    });
}

const REF = /^([a-z0-9][a-z0-9-]*)#(?:p(\d+)(?:-(\d+))?|([a-z0-9][a-z0-9-]*))(?:\|.*)?$/s;

// -> { alias, page, pageEnd } | { alias, anchor } | null
export function parseSourceRef(ref) {
  const match = REF.exec(ref);
  if (!match) return null;
  const [, alias, page, pageEnd, anchor] = match;
  return anchor ? { alias, anchor } : { alias, page: Number(page), pageEnd: Number(pageEnd ?? page) };
}

// Checks every sourceRef against learndoc.json references and, when chunked, the chunk index.
// `unverified` collects aliases already reported as unverified so each is reported once per file.
function sourceDiagnostics(sources, { config, indexes, file, id, unverified }) {
  const out = [];
  for (const ref of sources || []) {
    const parsed = parseSourceRef(ref);
    if (!parsed) continue;
    const subject = { file, ...(id ? { id } : {}), source: ref };
    const reference = config.references?.[parsed.alias];
    if (!reference) {
      out.push(diagnostic({
        code: 'refs/unknown-alias',
        message: `${file}: source "${ref}" uses alias "${parsed.alias}", which is not declared in learndoc.json references`,
        subject,
        supportedFixes: [
          `use one of ${JSON.stringify(Object.keys(config.references || {}))}`,
          `declare "${parsed.alias}" in learndoc.json references`,
        ],
      }));
      continue;
    }
    const index = indexes[parsed.alias];
    if (!index) {
      if (!unverified.has(parsed.alias)) {
        unverified.add(parsed.alias);
        out.push(diagnostic({
          code: 'refs/unverified',
          severity: 'warning',
          message: `${file}: sources citing "${parsed.alias}" cannot be verified because the reference has no chunk index`,
          subject: { file, reference: parsed.alias },
          supportedFixes: [`make ${reference.file} available so finalize can chunk it`],
        }));
      }
      continue;
    }
    const isPdf = index.type === 'pdf';
    if (isPdf !== (parsed.page !== undefined)) {
      out.push(diagnostic({
        code: 'refs/kind-mismatch',
        message: `${file}: source "${ref}" must cite ${isPdf ? 'a page (#p<n> or #p<n>-<m>)' : 'a heading anchor'} because "${parsed.alias}" is a ${index.type} reference`,
        subject,
        supportedFixes: [isPdf ? `use ${parsed.alias}#p<page>` : `use an anchor listed in references/chunks/${parsed.alias}/index.json`],
      }));
    } else if (isPdf && (parsed.page < 1 || parsed.pageEnd < parsed.page || parsed.pageEnd > index.pages)) {
      out.push(diagnostic({
        code: 'refs/page-out-of-range',
        message: `${file}: source "${ref}" is outside ${parsed.alias} (pages 1–${index.pages}, as 1-based PDF page indexes)`,
        subject,
        evidence: { pages: index.pages },
        supportedFixes: [`cite pages between 1 and ${index.pages}, with the start page not after the end page`],
      }));
    } else if (!isPdf && !index.anchors.some((entry) => entry.anchor === parsed.anchor)) {
      out.push(diagnostic({
        code: 'refs/unknown-anchor',
        message: `${file}: source "${ref}" cites anchor "${parsed.anchor}", which is not a heading in ${parsed.alias}`,
        subject,
        evidence: { anchors: index.anchors.slice(0, 20).map((entry) => entry.anchor) },
        supportedFixes: [`use an anchor listed in references/chunks/${parsed.alias}/index.json`],
      }));
    }
  }
  return out;
}

const FORBIDDEN_DELIMITER = /\\[[\]()]/;

function mathFormatDiagnostics(block, { file }) {
  const out = [];
  const subject = (field) => ({ file, id: block.id, field });
  for (const [field, kind] of Object.entries(FIELD_KINDS[block.type])) {
    const value = block[field];
    if (typeof value !== 'string') continue;
    if (kind === 'raw') {
      if (block.type === 'math' && /(^|[^\\])\$/.test(value)) {
        out.push(diagnostic({
          code: 'math/delimiter',
          message: `${file}: block ${block.id} latex must be the bare formula, without $ or $$ delimiters`,
          subject: subject(field),
          supportedFixes: ['remove the $ / $$ delimiters from latex'],
        }));
      }
      continue;
    }
    const { segments, errors } = segmentField(value, kind);
    for (const error of errors) {
      out.push(diagnostic({
        code: 'math/unclosed',
        message: `${file}: block ${block.id} ${field} has an ${error.message} at offset ${error.start}`,
        subject: subject(field),
        evidence: { excerpt: value.slice(Math.max(0, error.start - 20), error.start + 40) },
        supportedFixes: ['close the math delimiter', 'write a literal dollar as \\$', 'math cannot span HTML tags'],
      }));
    }
    for (const segment of segments) {
      if (segment.type !== 'text' || segment.verbatim) continue;
      const text = value.slice(segment.start, segment.end);
      const match = FORBIDDEN_DELIMITER.exec(text);
      if (!match) continue;
      out.push(diagnostic({
        code: 'math/delimiter',
        message: `${file}: block ${block.id} ${field} uses ${match[0]}; only $…$ and $$…$$ delimit math`,
        subject: subject(field),
        evidence: { excerpt: text.slice(Math.max(0, match.index - 20), match.index + 40) },
        supportedFixes: ['replace \\( … \\) with $…$', 'replace \\[ … \\] with $$…$$'],
      }));
      break;
    }
  }
  return out;
}

async function widgetDiagnostics(block, { root, file }) {
  const subject = { file, id: block.id, widget: block.widget };
  const widget = resolveWidget(root, block.widget);
  if (!widget) {
    return [diagnostic({
      code: 'widget/unknown',
      message: `${file}: block ${block.id} uses widget "${block.widget}", which is neither built in nor in widgets/${block.widget}.js`,
      subject,
      supportedFixes: ['use a widget from references/widget-catalog.md', `write widgets/${block.widget}.js in the project`],
    })];
  }
  let mod;
  try {
    mod = await importWidget(widget);
  } catch (error) {
    return [diagnostic({
      code: 'widget/load-failed',
      message: `${file}: widget "${block.widget}" (${relativePath(root, widget.file)}) cannot be imported in Node: ${error.message}`,
      subject,
      supportedFixes: ['fix the module syntax', 'do not touch the DOM at import time', 'keep project widgets self-contained (no relative imports)'],
    })];
  }
  if (!mod || typeof mod.mount !== 'function' || !mod.propsSchema || typeof mod.propsSchema !== 'object') {
    return [diagnostic({
      code: 'widget/invalid-module',
      message: `${file}: widget "${block.widget}" must default-export { name, propsSchema, mount }`,
      subject,
      supportedFixes: ['export default { name, propsSchema, mount(el, props, ctx) { return { update, destroy } } }'],
    })];
  }
  return validateProps(mod.propsSchema, block.props, '/props').map((error) => diagnostic({
    code: 'widget/props-invalid',
    message: `${file}: block ${block.id} widget "${block.widget}" props ${error.path} ${error.message}`,
    subject: { ...subject, path: error.path },
    evidence: { keyword: error.keyword },
    supportedFixes: [`change props to satisfy the propsSchema of "${block.widget}" (see references/widget-catalog.md)`],
  }));
}

// Semantic checks for one schema-valid block.
// ctx = { root, file, config, indexes, unverified }
export async function validateBlock(block, ctx) {
  const out = [
    ...sourceDiagnostics(block.sources, { ...ctx, id: block.id }),
    ...mathFormatDiagnostics(block, ctx),
  ];
  if (block.type === 'box') {
    const known = new Set([...Object.keys(DEFAULT_BOX_TYPES), ...Object.keys(ctx.config.boxTypes || {})]);
    if (!known.has(block.variant)) {
      out.push(diagnostic({
        code: 'box/unknown-variant',
        message: `${ctx.file}: block ${block.id} uses box variant "${block.variant}", which is neither a default type nor declared in learndoc.json boxTypes`,
        subject: { file: ctx.file, id: block.id, variant: block.variant },
        supportedFixes: [`use one of ${JSON.stringify([...known])}`, `declare "${block.variant}" in learndoc.json boxTypes`],
      }));
    }
  }
  if (block.type === 'figure' && (block.svg === undefined) === (block.src === undefined)) {
    out.push(diagnostic({
      code: 'figure/source',
      message: `${ctx.file}: figure block ${block.id} needs exactly one of svg or src`,
      subject: { file: ctx.file, id: block.id },
      supportedFixes: ['keep either the inline svg or the assets/ src, not both'],
    }));
  }
  if (block.type === 'figure' && block.src !== undefined && !fs.existsSync(path.join(ctx.root, block.src))) {
    out.push(diagnostic({
      code: 'figure/missing-asset',
      message: `${ctx.file}: figure block ${block.id} src ${block.src} does not exist in the project`,
      subject: { file: ctx.file, id: block.id, src: block.src },
      supportedFixes: [`add ${block.src}`, 'fix the src path'],
    }));
  }
  if (block.type === 'widget') out.push(...await widgetDiagnostics(block, ctx));
  return out;
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated];
}

export function validateConfig(config) {
  const file = CONFIG_FILE;
  const out = schemaDiagnostics('config', config, file);
  if (out.length) return out;
  for (const [name, type] of Object.entries(config.boxTypes || {})) {
    if (!DEFAULT_BOX_TYPES[name] && !type.color) {
      out.push(diagnostic({
        code: 'config/box-color',
        message: `${file}: custom box type "${name}" needs a color (c1..c6)`,
        subject: { file, boxType: name },
        supportedFixes: [`add "color": "c1" … "c6" to boxTypes.${name}`],
      }));
    }
  }
  return out;
}

// ctx = { config, indexes }
export function validateCourse(course, { config, indexes = {} }) {
  const file = COURSE_FILE;
  const out = schemaDiagnostics('course', course, file);
  if (out.length) return out;
  for (const id of duplicates(course.modules.map((module) => module.id))) {
    out.push(diagnostic({
      code: 'course/duplicate-module',
      message: `${file}: module id "${id}" is used more than once`,
      subject: { file, module: id },
      supportedFixes: ['give every module a unique id'],
    }));
  }
  const lessons = course.modules.flatMap((module) => module.lessons);
  for (const id of duplicates(lessons.map((lesson) => lesson.id))) {
    out.push(diagnostic({
      code: 'course/duplicate-lesson',
      message: `${file}: lesson id "${id}" is listed more than once`,
      subject: { file, lesson: id },
      supportedFixes: ['list every lesson once with a unique id'],
    }));
  }
  const unverified = new Set();
  for (const lesson of lessons) {
    out.push(...sourceDiagnostics(lesson.sources, { config, indexes, file, id: lesson.id, unverified }));
  }
  return out;
}

// ctx = { root, file (project-relative), config, course?, indexes }
export async function validateLesson(lesson, ctx) {
  const { file } = ctx;
  const out = schemaDiagnostics('lesson', lesson, file);
  if (out.length) return out;
  const expectedId = path.basename(file, '.json');
  if (lesson.id !== expectedId) {
    out.push(diagnostic({
      code: 'lesson/id-mismatch',
      message: `${file}: lesson id "${lesson.id}" must equal the file name "${expectedId}"`,
      subject: { file, id: lesson.id },
      supportedFixes: [`set "id": "${expectedId}"`, `rename the file to lessons/${lesson.id}.json`],
    }));
  }
  if (ctx.course && !ctx.course.modules.some((module) => module.lessons.some((entry) => entry.id === lesson.id))) {
    out.push(diagnostic({
      code: 'lesson/not-in-course',
      message: `${file}: lesson "${lesson.id}" is not listed in course.json`,
      subject: { file, id: lesson.id },
      supportedFixes: [`add { "id": "${lesson.id}", "title": …, "status": "done" } to a module in course.json`],
    }));
  }
  for (const id of duplicates(lesson.blocks.map((block) => block.id))) {
    out.push(diagnostic({
      code: 'block/duplicate-id',
      message: `${file}: block id "${id}" is used more than once`,
      subject: { file, id },
      supportedFixes: ['give every block a unique id (b- followed by 4–12 lowercase letters or digits)'],
    }));
  }
  const anchors = lesson.blocks.filter((block) => block.type === 'heading').map((block) => block.anchor);
  for (const anchor of duplicates(anchors)) {
    out.push(diagnostic({
      code: 'heading/duplicate-anchor',
      message: `${file}: heading anchor "${anchor}" is used more than once`,
      subject: { file, anchor },
      supportedFixes: ['give every heading a unique anchor'],
    }));
  }
  const unverified = new Set();
  for (const block of lesson.blocks) out.push(...await validateBlock(block, { ...ctx, unverified }));
  return out;
}
