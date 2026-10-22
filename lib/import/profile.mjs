// Import profile: how `learndoc import` reads an existing HTML course. Generic defaults, merged with a
// project profile (schemas/import-profile.schema.json), then checked beyond the schema.
import { diagnostic } from '../diagnostics.mjs';
import { builtinWidgetNames } from '../project.mjs';
import { schemaDiagnostics } from '../validate.mjs';
import { DEFAULT_BOX_TYPES } from '../../shared/render.mjs';

export const PROFILE_FILE = 'import-profile.json';

// `language` has no default: without one, import reads it from the first lesson page's <html lang>.
export const DEFAULT_PROFILE = {
  schemaVersion: 1,
  files: { include: '\\.html?$', exclude: ['^index\\.html?$'] },
  course: {
    title: { from: 'index.html', selector: 'h1' },
    order: 'index-links',
    globals: { page: 'index.html', lessonFields: { key: 'id', file: 'file', module: 'module', title: 'title' } },
    modules: [],
  },
  lesson: {
    root: 'main, article',
    header: 'header',
    lede: 'p',
    kicker: '.kicker',
    chips: '.chip',
    chipRules: [],
    headingLevels: { h1: 2, h2: 2, h3: 3, h4: 3, h5: 3, h6: 3 },
  },
  boxes: {
    classPattern: '^(box|callout|admonition|note|warning|tip|alert|info)$',
    variants: Object.keys(DEFAULT_BOX_TYPES),
    variantMap: {
      warning: 'warn', danger: 'warn', caution: 'warn', pitfall: 'warn', important: 'warn',
      tip: 'intuition', hint: 'intuition', info: 'note', definition: 'def', theorem: 'def',
    },
    fallbackTitles: {},
    boxTypes: {},
  },
  demos: { selector: '.demo', title: '.demo-title', hint: '.hint', chrome: '.controls, .readout', candidates: [] },
  quiz: { selector: 'details', answer: '.answer' },
  code: { highlightClasses: [], defaultLanguage: 'text' },
  svg: { palette: [], surfaceVars: [] },
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Objects merge key by key; arrays and scalars from `override` replace the default.
function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = merge(base[key], value);
  return out;
}

// Regex-valued settings, as [path, source] pairs.
function regexes(profile) {
  return [
    ['files.include', profile.files.include],
    ...profile.files.exclude.map((source, i) => [`files.exclude/${i}`, source]),
    ['boxes.classPattern', profile.boxes.classPattern],
    ...profile.course.modules.map((module, i) => [`course.modules/${i}/match`, module.match]),
    ...profile.lesson.chipRules.flatMap((rule, i) => [[`lesson.chipRules/${i}/label`, rule.label], [`lesson.chipRules/${i}/ref`, rule.ref]]),
    ...profile.demos.candidates.flatMap((candidate, i) => [[`demos.candidates/${i}/words`, candidate.words], [`demos.candidates/${i}/js`, candidate.js]]),
  ].filter(([, source]) => source !== undefined);
}

// -> { profile, diagnostics }; `profile` is the defaults merged with `user` (null when invalid).
export function resolveProfile(user, file) {
  const schema = schemaDiagnostics('importProfile', user, file);
  if (schema.length) return { profile: null, diagnostics: schema };
  const profile = merge(structuredClone(DEFAULT_PROFILE), user);
  const out = [];
  const fail = (path, message, supportedFixes) => out.push(diagnostic({
    code: 'import/profile-invalid', message: `${file}: ${path} ${message}`, subject: { file, path }, supportedFixes,
  }));
  for (const [path, source] of regexes(profile)) {
    try {
      new RegExp(source);
    } catch (error) {
      fail(path, `is not a valid regular expression: ${error.message}`, ['fix the regular expression (JSON strings need \\\\ for a backslash)']);
    }
  }
  const knownVariants = new Set([...Object.keys(DEFAULT_BOX_TYPES), ...Object.keys(profile.boxes.boxTypes)]);
  for (const variant of [...profile.boxes.variants, ...Object.values(profile.boxes.variantMap)]) {
    if (!knownVariants.has(variant)) {
      fail('boxes', `uses box variant "${variant}", which is neither a default type nor in boxes.boxTypes`, [`declare "${variant}" in boxes.boxTypes`]);
    }
  }
  if (profile.course.order === 'globals' && !profile.course.globals.expr) {
    fail('course.globals.expr', 'is required when course.order is "globals"', ['set course.globals.expr, e.g. "LESSONS"', 'use course.order "index-links"']);
  }
  const widgets = new Set(builtinWidgetNames());
  profile.demos.candidates.forEach((candidate, i) => {
    if (!widgets.has(candidate.widget)) {
      fail(`demos.candidates/${i}/widget`, `"${candidate.widget}" is not a built-in widget`, [`use one of ${JSON.stringify([...widgets])}`]);
    }
  });
  return { profile: out.length ? null : profile, diagnostics: out };
}
