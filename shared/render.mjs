// Lesson / block → HTML string. Shared by Node (finalize, server preview) and the browser (replaceBlock),
// so the DOM is identical everywhere. Isomorphic: no node: imports, no DOM access.
import { decodeEntities, escapeAttr, escapeHtml, tokenize } from './html.mjs';

export const DEFAULT_BOX_TYPES = {
  def: { label: { vi: 'Định nghĩa', en: 'Definition' }, color: 'c1' },
  warn: { label: { vi: 'Cạm bẫy', en: 'Pitfall' }, color: 'c2' },
  example: { label: { vi: 'Ví dụ', en: 'Example' }, color: 'c3' },
  formula: { label: { vi: 'Công thức', en: 'Formula' }, color: 'c4' },
  note: { label: { vi: 'Ghi chú', en: 'Note' }, color: 'c5' },
  intuition: { label: { vi: 'Trực giác', en: 'Intuition' }, color: 'c6' },
};

const ANSWER_LABEL = { vi: 'Đáp án', en: 'Answer' };

// Text fields per block type and their kind ('html' | 'plain' | 'raw').
export const FIELD_KINDS = {
  heading: { text: 'plain' },
  prose: { html: 'html' },
  box: { title: 'plain', html: 'html' },
  math: { latex: 'raw' },
  code: { code: 'raw', caption: 'plain' },
  figure: { alt: 'plain', caption: 'plain' },
  widget: {},
  quiz: { question: 'plain', answer: 'html' },
};

function baseLanguage(language) {
  return String(language || 'en').split('-')[0];
}

// -> labels[language] for the base language (vi-VN → vi), falling back to English.
export function localized(labels, language) {
  return labels[baseLanguage(language)] ?? labels.en;
}

export function resolveBoxTypes(config = {}) {
  const resolved = {};
  for (const [name, { label, color }] of Object.entries(DEFAULT_BOX_TYPES)) {
    resolved[name] = { label: localized(label, config.language), color };
  }
  for (const [name, custom] of Object.entries(config.boxTypes || {})) {
    resolved[name] = DEFAULT_BOX_TYPES[name]
      ? { ...resolved[name], label: custom.label }
      : { label: custom.label, color: custom.color };
  }
  return resolved;
}

// Elements whose text is never scanned for math (code samples may contain literal '$').
const VERBATIM_TAGS = new Set(['code', 'pre']);

// Scans one run of text for $…$ / $$…$$. `\$` outside math is a literal dollar; inside math a
// backslash escapes the next character. Pushes text/math segments; returns an error or null.
function scanMath(src, start, end, segments) {
  let textStart = start;
  let i = start;
  while (i < end) {
    const ch = src[i];
    if (ch === '\\' && src[i + 1] === '$') {
      i += 2;
      continue;
    }
    if (ch !== '$') {
      i += 1;
      continue;
    }
    const display = src[i + 1] === '$';
    const open = display ? 2 : 1;
    let j = i + open;
    let close = -1;
    while (j < end) {
      if (src[j] === '\\') {
        j += 2;
      } else if (src[j] === '$' && (!display || src[j + 1] === '$')) {
        close = j;
        break;
      } else {
        j += 1;
      }
    }
    if (close < 0 || close + open > end) {
      segments.push({ type: 'text', start: textStart, end });
      return { start: i, message: `unclosed ${display ? '$$' : '$'} math delimiter` };
    }
    if (i > textStart) segments.push({ type: 'text', start: textStart, end: i });
    segments.push({ type: 'math', start: i, end: close + open, innerStart: i + open, innerEnd: close, display });
    i = close + open;
    textStart = i;
  }
  if (end > textStart) segments.push({ type: 'text', start: textStart, end });
  return null;
}

// Splits a field source into segments covering it end to end:
//   { type: 'tag', token } | { type: 'error', token }        (html only)
//   { type: 'text', start, end, verbatim? }                    verbatim = inside <code>/<pre>
//   { type: 'math', start, end, innerStart, innerEnd, display, latex }
// Math errors (unclosed delimiters) are returned separately; the offending text stays a text segment.
export function segmentField(src, kind) {
  const segments = [];
  const errors = [];
  const pushText = (start, end, verbatim) => {
    if (verbatim) {
      segments.push({ type: 'text', start, end, verbatim: true });
      return;
    }
    const error = scanMath(src, start, end, segments);
    if (error) errors.push(error);
  };
  if (kind === 'plain') {
    pushText(0, src.length, false);
  } else {
    let verbatimDepth = 0;
    for (const token of tokenize(src)) {
      if (token.type === 'text') {
        pushText(token.start, token.end, verbatimDepth > 0);
        continue;
      }
      segments.push({ type: token.type === 'error' ? 'error' : 'tag', token });
      if (VERBATIM_TAGS.has(token.name?.toLowerCase())) {
        if (token.type === 'open' && !token.selfClosing) verbatimDepth += 1;
        if (token.type === 'close') verbatimDepth = Math.max(0, verbatimDepth - 1);
      }
    }
  }
  for (const segment of segments) {
    if (segment.type !== 'math') continue;
    const inner = src.slice(segment.innerStart, segment.innerEnd);
    segment.latex = kind === 'html' ? decodeEntities(inner) : inner;
  }
  return { segments, errors };
}

export function mathSpan(latex, display, n) {
  return `<span class="math" data-math="${n}" data-display="${display ? 1 : 0}" data-latex="${escapeAttr(latex)}">${escapeHtml(latex)}</span>`;
}

// linkBase is a prefix ('/lessons/') or a function of the link target '<id>[#anchor]'.
const lessonHref = (linkBase, target) => (typeof linkBase === 'function' ? linkBase(target) : linkBase + target);

function renderTag(token, src, linkBase) {
  const raw = src.slice(token.start, token.end);
  if (token.type !== 'open' || token.name.toLowerCase() !== 'a' || !linkBase) return raw;
  const href = token.attrs.find((attr) => attr.name.toLowerCase() === 'href')?.value;
  if (!href?.startsWith('lesson:')) return raw;
  const attrs = token.attrs.map((attr) => (attr.name.toLowerCase() === 'href'
    ? ` href="${escapeAttr(lessonHref(linkBase, href.slice('lesson:'.length)))}"`
    : ` ${attr.name}${attr.value == null ? '' : `="${escapeAttr(attr.value)}"`}`));
  return `<a${attrs.join('')}>`;
}

// Renders a list of field segments; `counter.n` numbers math spans across calls.
export function renderSegments(src, kind, segments, { linkBase, counter = { n: 0 } } = {}) {
  let out = '';
  for (const segment of segments) {
    if (segment.type === 'math') {
      out += mathSpan(segment.latex, segment.display, counter.n++);
    } else if (segment.type === 'text') {
      const raw = src.slice(segment.start, segment.end);
      const text = segment.verbatim ? raw : raw.replaceAll('\\$', '$');
      out += kind === 'html' ? text : escapeHtml(text);
    } else if (segment.type === 'tag') {
      out += renderTag(segment.token, src, linkBase);
    } else {
      out += escapeHtml(src.slice(segment.token.start, segment.token.end));
    }
  }
  return out;
}

function renderField(src, kind, linkBase) {
  return renderSegments(src, kind, segmentField(src, kind).segments, { linkBase });
}

export function wrapMath(text, kind) {
  return renderField(text, kind, null);
}

function sectionOpen(block, extraClass = '', style = '') {
  const classes = `ld-block ld-${block.type}${extraClass ? ` ${extraClass}` : ''}`;
  return `<section class="${classes}" data-block-id="${escapeAttr(block.id)}" data-type="${block.type}"${style}>`;
}

const figcaption = (block) => `<figcaption data-field="caption">${wrapMath(block.caption, 'plain')}</figcaption>`;

const BLOCK_RENDERERS = {
  heading(block) {
    const tag = block.level === 3 ? 'h3' : 'h2';
    return `<${tag} id="${escapeAttr(block.anchor)}" data-field="text">${wrapMath(block.text, 'plain')}</${tag}>`;
  },
  prose(block, ctx) {
    return `<div class="ld-prose-body" data-field="html">${renderField(block.html, 'html', ctx.linkBase)}</div>`;
  },
  box(block, ctx) {
    const type = ctx.boxTypes?.[block.variant];
    return '<div class="ld-box-head">'
      + `<span class="ld-box-label" data-chrome>${escapeHtml(type?.label ?? block.variant)}</span>`
      + `<span class="ld-box-title" data-field="title">${wrapMath(block.title, 'plain')}</span></div>`
      + `<div class="ld-box-body" data-field="html">${renderField(block.html, 'html', ctx.linkBase)}</div>`;
  },
  math(block) {
    return `<div class="ld-math-body" data-field="latex">${mathSpan(block.latex, true, 0)}</div>`;
  },
  code(block) {
    const language = escapeAttr(block.language);
    const caption = block.caption
      ? `<div class="ld-code-caption" data-field="caption">${wrapMath(block.caption, 'plain')}</div>`
      : '';
    return `<pre><code class="language-${language}" data-field="code">${escapeHtml(block.code)}</code></pre>${caption}`;
  },
  figure(block, ctx) {
    if (block.svg != null) return `<figure>${block.svg}${figcaption(block)}</figure>`;
    const src = ctx.assetUrl ? ctx.assetUrl(block.src) : `/project/${block.src}`;
    return `<figure><img src="${escapeAttr(src)}" alt="${escapeAttr(block.alt)}">${figcaption(block)}</figure>`;
  },
  widget(block) {
    return `<div class="ld-widget" data-widget="${escapeAttr(block.widget)}" data-props="${escapeAttr(JSON.stringify(block.props))}"></div>`;
  },
  quiz(block, ctx) {
    return '<details class="ld-quiz">'
      + `<summary data-field="question">${wrapMath(block.question, 'plain')}</summary>`
      + '<div class="ld-quiz-answer">'
      + `<span class="ld-answer-label" data-chrome>${escapeHtml(localized(ANSWER_LABEL, ctx.language))}</span>`
      + `<div data-field="answer">${renderField(block.answer, 'html', ctx.linkBase)}</div></div></details>`;
  },
};

// ctx = { boxTypes, lessonId, linkBase: '/lessons/', language?, assetUrl? } (language localizes the quiz
// answer label; assetUrl maps a figure's project-relative src, default /project/<src>).
export function renderBlock(block, ctx = {}) {
  const render = BLOCK_RENDERERS[block.type];
  if (!render) throw new Error(`renderBlock: unknown block type "${block.type}"`);
  if (block.type === 'box') {
    const color = ctx.boxTypes?.[block.variant]?.color ?? 'c5';
    const variant = escapeAttr(block.variant);
    return `${sectionOpen(block, `ld-box-${variant}`, ` style="--box-c: var(--${color})"`)}${render(block, ctx)}</section>`;
  }
  return `${sectionOpen(block)}${render(block, ctx)}</section>`;
}

export function renderLessonBody(lesson, ctx = {}) {
  return lesson.blocks.map((block) => renderBlock(block, ctx)).join('\n');
}
