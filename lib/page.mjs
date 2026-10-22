// Full HTML page shells: lesson page and course index page.
import { builtinWidgetNames, resolveWidget } from './project.mjs';
import { escapeAttr, escapeHtml } from '../shared/html.mjs';
import { localized, renderLessonBody, resolveBoxTypes, segmentField, wrapMath } from '../shared/render.mjs';

const STATUS_LABELS = {
  vi: { done: 'Đã xong', planned: 'Dự kiến' },
  en: { done: 'Done', planned: 'Planned' },
};
const CONTENTS_LABEL = { vi: 'Mục lục', en: 'Contents' };

export const jsonScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

// Where a page's links and assets point. The default is the edit/check server; lib/export.mjs
// supplies a target for standalone files with every asset inlined.
export const SERVER_TARGET = {
  home: '/',
  lessonHref: (id) => `/lessons/${encodeURIComponent(id)}`,
  linkBase: '/lessons/',
  assetUrl: null,
  styles: (math) => [
    ...(math ? ['<link rel="stylesheet" href="/static/runtime/vendor/katex/katex.min.css">'] : []),
    '<link rel="stylesheet" href="/static/runtime/style.css">',
  ],
  katexScript: () => '<script src="/static/runtime/vendor/katex/katex.min.js"></script>',
  widgetMap: (root, lesson) => widgetUrlMap(root, lesson),
  lessonScript: () => '<script type="module" src="/static/runtime/lesson.js"></script>',
  topbarActions: () => '',
};

// A plain field as text for <title>, where math cannot render: keeps the LaTeX, drops the delimiters.
function titleText(value) {
  return segmentField(value, 'plain').segments
    .map((segment) => (segment.type === 'math' ? segment.latex : value.slice(segment.start, segment.end).replaceAll('\\$', '$')))
    .join('');
}

function head({ title, config, target, metas = [], scripts = [] }) {
  const math = config.features?.math !== false;
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<link rel="icon" href="data:,">',
    ...metas.map(([name, content]) => `<meta name="${name}" content="${escapeAttr(content)}">`),
    ...target.styles(math),
    ...(math ? [target.katexScript()] : []),
    ...scripts,
  ].join('\n');
}

function topbar(course, crumb, target, lessonId) {
  return '<header class="ld-topbar">'
    + `<a class="ld-home" href="${escapeAttr(target.home)}">${wrapMath(course.title, 'plain')}</a>`
    + (crumb ? `<span class="ld-crumb">${crumb}</span>` : '')
    + target.topbarActions(lessonId)
    + '<button class="ld-theme-toggle" type="button"></button></header>';
}

function page({ language, bodyClass, headHtml, bodyHtml }) {
  return `<!doctype html>
<html lang="${escapeAttr(language)}">
<head>
${headHtml}
</head>
<body class="ld-page ${bodyClass}">
${bodyHtml}
</body>
</html>
`;
}

// Every built-in widget (replaceBlock may introduce one later) plus the project widgets the lesson uses.
export function widgetUrlMap(root, lesson) {
  const map = {};
  for (const name of builtinWidgetNames()) map[name] = `/static/runtime/widgets/${name}.js`;
  for (const block of lesson.blocks) {
    if (block.type !== 'widget' || map[block.widget]) continue;
    const widget = resolveWidget(root, block.widget);
    if (widget) map[block.widget] = widget.url;
  }
  return map;
}

function lessonNav(course, lessonId, target) {
  const available = course.modules.flatMap((module) => module.lessons).filter((entry) => entry.status !== 'planned');
  const index = available.findIndex((entry) => entry.id === lessonId);
  if (index < 0) return '';
  const link = (entry, cls) => (entry ? `<a class="${cls}" href="${escapeAttr(target.lessonHref(entry.id))}">${wrapMath(entry.title, 'plain')}</a>` : '');
  return `<nav class="ld-lesson-nav">${link(available[index - 1], 'ld-prev')}${link(available[index + 1], 'ld-next')}</nav>`;
}

// -> full lesson page HTML. `editable` adds editor.js and the token meta.
export function renderLessonPage({ root, config, course, lesson, editable = false, token, target = SERVER_TARGET }) {
  const language = config.language;
  const module = course.modules.find((entry) => entry.lessons.some((item) => item.id === lesson.id));
  const ctx = { boxTypes: resolveBoxTypes(config), lessonId: lesson.id, linkBase: target.linkBase, language, assetUrl: target.assetUrl };
  const scripts = [
    `<script type="application/json" id="ld-widgets">${jsonScript(target.widgetMap(root, lesson))}</script>`,
    target.lessonScript(),
    ...(editable ? ['<script type="module" src="/static/runtime/editor.js"></script>'] : []),
  ];
  const metas = [['learndoc-lesson', lesson.id], ...(editable ? [['learndoc-token', token]] : [])];
  const toc = lesson.blocks
    .filter((block) => block.type === 'heading' && block.level === 2)
    .map((block) => `<a href="#${escapeAttr(block.anchor)}">${wrapMath(block.text, 'plain')}</a>`)
    .join('');
  const chips = ['duration', 'level']
    .filter((key) => lesson.meta?.[key])
    .map((key) => `<span class="ld-chip">${escapeHtml(lesson.meta[key])}</span>`)
    .join('');
  const crumb = [module?.title, lesson.title].filter(Boolean).map((part) => wrapMath(part, 'plain')).join(' · ');
  const header = '<header class="ld-lesson-header">'
    + (module ? `<div class="ld-kicker">${wrapMath(module.title, 'plain')}</div>` : '')
    + `<h1>${wrapMath(lesson.title, 'plain')}</h1>`
    + (lesson.lede ? `<p class="ld-lede">${wrapMath(lesson.lede, 'plain')}</p>` : '')
    + (chips ? `<div class="ld-meta">${chips}</div>` : '')
    + '</header>';
  const body = [
    topbar(course, crumb, target, lesson.id),
    '<div class="ld-layout">',
    `<nav class="ld-toc" aria-label="${escapeAttr(localized(CONTENTS_LABEL, language))}">${toc}</nav>`,
    `<main class="ld-lesson" data-lesson-id="${escapeAttr(lesson.id)}">`,
    header,
    renderLessonBody(lesson, ctx),
    lessonNav(course, lesson.id, target),
    '</main>',
    '</div>',
  ].join('\n');
  return page({
    language,
    bodyClass: 'ld-page-lesson',
    headHtml: head({ title: `${titleText(lesson.title)} · ${titleText(course.title)}`, config, target, metas, scripts }),
    bodyHtml: body,
  });
}

export function renderIndexPage({ config, course, target = SERVER_TARGET }) {
  const language = config.language;
  const labels = localized(STATUS_LABELS, language);
  const card = (lesson) => {
    const inner = `<h3>${wrapMath(lesson.title, 'plain')}</h3>`
      + (lesson.summary ? `<p>${wrapMath(lesson.summary, 'plain')}</p>` : '')
      + `<span class="ld-badge ${lesson.status}">${escapeHtml(labels[lesson.status])}</span>`;
    return lesson.status === 'planned'
      ? `<div class="ld-card">${inner}</div>`
      : `<a class="ld-card" href="${escapeAttr(target.lessonHref(lesson.id))}">${inner}</a>`;
  };
  const modules = course.modules.map((module) => `<section class="ld-module"><h2>${wrapMath(module.title, 'plain')}</h2>`
    + `${module.lessons.map(card).join('')}</section>`).join('\n');
  const body = [
    topbar(course, '', target, null),
    '<main class="ld-index">',
    `<h1>${wrapMath(course.title, 'plain')}</h1>`,
    course.description ? `<p>${wrapMath(course.description, 'plain')}</p>` : '',
    modules,
    '</main>',
  ].filter(Boolean).join('\n');
  return page({
    language,
    bodyClass: 'ld-page-index',
    headHtml: head({ title: titleText(course.title), config, target, scripts: [target.lessonScript()] }),
    bodyHtml: body,
  });
}
