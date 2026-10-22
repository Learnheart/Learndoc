// In-page extractor for `learndoc import`. Runs inside headless Chrome (page scripts disabled, CSS loaded)
// through Runtime.evaluate, serialized with Function.prototype.toString — so it must stay self-contained.
//
// opts = { profile (resolved import profile), whitelist (schemas/html-whitelist.json),
//         codeLanguage: pattern a code block language must match (lesson schema) }
// -> { lang, title, lede, kicker, chips: [{ label, text, html }], blocks, demos, measure: { math, svg, svgInDemos },
//      stats: { dropped: {}, approx: {} } }
// Blocks are raw (no ids or sources; untitled boxes have title null). Links keep their source href as
// href="RAW:<href>" for Node to resolve.
export function extractPage(opts) {
  const P = opts.profile;
  const WL = opts.whitelist.html;
  const SVGWL = opts.whitelist.svg;
  const stats = { dropped: {}, approx: {} };
  const bump = (bucket, key) => { stats[bucket][key] = (stats[bucket][key] || 0) + 1; };

  const root = document.querySelector(P.lesson.root) || document.body;

  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta']);
  const FORM_TAGS = new Set(['input', 'select', 'button', 'textarea', 'option', 'label', 'canvas', 'output', 'progress', 'meter']);
  const EMBED_TAGS = new Set(['iframe', 'video', 'audio', 'object', 'embed']);
  const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'ul', 'ol', 'li', 'table',
    'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'pre', 'blockquote', 'figure', 'figcaption', 'details', 'summary', 'dl', 'dt', 'dd',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'main', 'caption', 'form', 'fieldset']);
  const INLINE_TAGS = new Set(['a', 'span', 'em', 'strong', 'b', 'i', 'code', 'sub', 'sup', 'br', 'small', 'mark', 'u', 's', 'kbd',
    'var', 'abbr', 'cite', 'q', 'time', 'img', 'dfn', 'del', 'ins']);
  const MATH_PART = /(\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\\])+\$)/;
  const classes = (el) => (el.getAttribute && el.getAttribute('class') ? el.getAttribute('class').split(/\s+/).filter(Boolean) : []);
  const isKatex = (el) => el.nodeType === 1 && (el.classList.contains('katex') || el.classList.contains('katex-display'));
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (t) => esc(t).replace(/"/g, '&quot;');
  const collapse = (t) => t.replace(/\s+/g, ' ').trim();
  const inVerbatim = (n) => Boolean(n.parentElement && n.parentElement.closest('pre, code'));
  // Collapses whitespace outside math only; math source stays byte-exact.
  const collapseOutsideMath = (t) => t.split(MATH_PART).map((part, i) => (i % 2 ? part : part.replace(/\s+/g, ' '))).join('');

  // KaTeX-rendered math -> $…$ / $$…$$ from its TeX annotation.
  function katexToTex(el) {
    const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
    if (!annotation) { bump('dropped', 'katex-without-annotation'); return ''; }
    const display = el.classList.contains('katex-display') || Boolean(el.closest('.katex-display'));
    return display ? `$$${annotation.textContent}$$` : `$${annotation.textContent}$`;
  }
  // \( \) and \[ \] (KaTeX auto-render delimiters) -> $ and $$, the only delimiters learndoc accepts.
  const normDelims = (t) => t.replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `$$${m}$$`).replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m}$`);

  // Plain text for plain fields (headings, titles, captions, questions); keeps $…$ math.
  function plain(node) {
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) {
        out += inVerbatim(n) ? n.data.replace(/\$/g, '\\$') : normDelims(n.data);
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.localName;
      if (SKIP_TAGS.has(tag) || tag === 'svg') return;
      if (isKatex(n)) { out += katexToTex(n); return; }
      if (tag === 'br') { out += ' '; return; }
      if (tag === 'img') { out += n.getAttribute('alt') || ''; return; }
      const block = BLOCK_TAGS.has(tag);
      if (block) out += ' ';
      for (const c of n.childNodes) walk(c);
      if (block) out += ' ';
    };
    walk(node);
    return collapseOutsideMath(out).trim();
  }

  // ---------- html fields (whitelisted tags and classes only) ----------
  function serAttrs(el, tag) {
    const allowed = WL.tags[tag] || [];
    let out = '';
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (name === 'class') continue;
      if (!allowed.includes(name)) { bump('dropped', name === 'id' || name === 'style' ? `attr:${name}` : `attr:${tag}[${name}]`); continue; }
      if (name === 'colspan' && !/^[1-9][0-9]?$/.test(attr.value)) continue;
      out += ` ${name}="${escAttr(name === 'href' ? `RAW:${attr.value}` : attr.value)}"`;
    }
    const own = classes(el);
    const keep = own.filter((c) => WL.classes.includes(c));
    const drop = own.filter((c) => !WL.classes.includes(c));
    if (drop.length) bump('dropped', `class:${tag}.${drop.join('.')}`);
    if (keep.length && allowed.includes('class')) out += ` class="${keep.join(' ')}"`;
    return out;
  }
  const serChildren = (el, ctx) => [...el.childNodes].map((c) => ser(c, ctx)).join('');
  function ser(n, ctx = {}) {
    if (n.nodeType === 3) {
      if (ctx.pre || inVerbatim(n)) return esc(n.data);
      return collapseOutsideMath(esc(normDelims(n.data)));
    }
    if (n.nodeType !== 1) return '';
    const tag = n.localName;
    if (SKIP_TAGS.has(tag)) return '';
    if (isKatex(n)) return esc(katexToTex(n));
    if (FORM_TAGS.has(tag) || EMBED_TAGS.has(tag)) { bump('dropped', `tag:${tag}`); return ''; }
    if (tag === 'svg') { bump('dropped', 'svg-inside-text'); return ''; }
    if (tag === 'img') { bump('approx', 'img-inside-text->alt'); return esc(n.getAttribute('alt') || ''); }
    if (tag === 'span') {
      const keep = classes(n).filter((c) => WL.classes.includes(c));
      if (!keep.length) {
        const styling = classes(n).filter((c) => !P.code.highlightClasses.includes(c));
        if (styling.length) bump('dropped', `class:span.${styling.join('.')}`);
        return serChildren(n, ctx);
      }
      return `<span class="${keep.join(' ')}">${serChildren(n, ctx)}</span>`;
    }
    if (tag === 'pre') return `<pre>${serChildren(n, { ...ctx, pre: true })}</pre>`;
    if (Object.hasOwn(WL.tags, tag)) {
      const attrs = serAttrs(n, tag);
      if (tag === 'a' && !attrs.includes('href=')) return serChildren(n, ctx);
      return WL.voidTags.includes(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${serChildren(n, ctx)}</${tag}>`;
    }
    if (/^h[1-6]$/.test(tag) || tag === 'dt') { bump('approx', `${tag}-inside-text->p>strong`); return `<p><strong>${serChildren(n, ctx)}</strong></p>`; }
    if (BLOCK_TAGS.has(tag)) {
      // Generic container: unwrap; inline-only content keeps its own paragraph.
      const inner = serChildren(n, ctx);
      const hasBlockChild = [...n.children].some((c) => BLOCK_TAGS.has(c.localName));
      return !hasBlockChild && collapse(n.textContent) && ctx.blockLevel ? `<p>${inner.trim()}</p>` : inner;
    }
    if (!INLINE_TAGS.has(tag)) bump('dropped', `tag:${tag}(unwrapped)`);
    return serChildren(n, ctx);
  }
  // Tidies whitespace around block tags; never touches <pre> content.
  function tidy(html) {
    return html.split(/(<pre>[\s\S]*?<\/pre>)/).map((part, i) => (i % 2 ? part : part
      .replace(/\s*(<\/?(?:p|ul|ol|li|table|thead|tbody|tr|td|th|blockquote)(?:\s[^>]*)?>)\s*/g, '$1')
      .replace(/(<\/(?:p|ul|ol|table|blockquote|li|tr)>)(?=<)/g, '$1\n')
      .replace(/(<(?:ul|ol|table|thead|tbody)(?:\s[^>]*)?>)(?=<)/g, '$1\n'))).join('').trim();
  }
  const serBlocks = (nodes) => tidy(nodes.map((c) => ser(c, { blockLevel: true })).join(''));

  // ---------- svg (whitelist; computed paint -> palette classes) ----------
  const probe = document.createElement('span');
  document.body.appendChild(probe);
  const resolveColor = (value) => { probe.style.color = ''; probe.style.color = value; return getComputedStyle(probe).color; };
  const palette = new Map();
  for (const [cssVar, cls] of P.svg.palette) {
    const rgb = resolveColor(`var(${cssVar})`);
    if (rgb && !palette.has(rgb)) palette.set(rgb, cls);
  }
  const surfaceColors = new Set(P.svg.surfaceVars.map((v) => resolveColor(`var(${v})`)));
  const PRESENTATION = new Set(SVGWL.presentationAttributes);
  const SVG_CLASSES = new Set(SVGWL.classes);
  const isColorClass = (c) => /^c[1-6]$/.test(c);

  // Palette classes for an element whose own styling (inline style, foreign classes, var() paint) cannot be kept.
  function paintClasses(el, tag, keep) {
    const add = (c) => { if (c && !keep.includes(c)) keep.push(c); };
    const cs = getComputedStyle(el);
    const fillClass = palette.get(cs.fill) || null;
    const strokeClass = palette.get(cs.stroke) || null;
    if (tag === 'text' || tag === 'tspan') {
      if (fillClass) add(isColorClass(fillClass) ? fillClass : 'muted');
    } else if (strokeClass && (cs.fill === 'none' || surfaceColors.has(cs.fill))) {
      add(strokeClass);
      add('stroke-only');
    } else if (fillClass) {
      if (isColorClass(fillClass)) add(fillClass);
      else bump('approx', `svg:fill-${fillClass}-dropped`);
    } else if (strokeClass) {
      add(strokeClass);
    }
  }

  function svgString(svg) {
    const out = [];
    const emit = (el) => {
      if (el.nodeType === 3) { out.push(esc(el.data)); return; }
      if (el.nodeType !== 1) return;
      const tag = el.localName;
      if (!Object.hasOwn(SVGWL.tags, tag)) {
        if (['foreignObject', 'image', 'script', 'style', 'use'].includes(tag)) { bump('dropped', `svg-tag:${tag}`); return; }
        bump('dropped', `svg-tag:${tag}(unwrapped)`);
        for (const c of el.childNodes) emit(c);
        return;
      }
      const attrs = [];
      const own = classes(el);
      const keep = own.filter((c) => SVG_CLASSES.has(c));
      const foreign = own.filter((c) => !SVG_CLASSES.has(c));
      const style = el.getAttribute('style') || '';
      let opacity = el.getAttribute('opacity');
      for (const attr of el.attributes) {
        const name = attr.name;
        if (name === 'class' || name === 'style' || name === 'opacity') continue;
        if (name === 'id') {
          if (tag === 'marker' || tag === 'clipPath') attrs.push(`id="${escAttr(attr.value)}"`);
          else if (tag !== 'svg') bump('dropped', 'svg-attr:id');
          continue;
        }
        if (name === 'fill-opacity' || name === 'stroke-opacity') {
          if (opacity == null) { opacity = attr.value; bump('approx', `svg:${name}->opacity`); }
          continue;
        }
        if (!(SVGWL.tags[tag] || []).includes(name) && !PRESENTATION.has(name)) { bump('dropped', `svg-attr:${name}`); continue; }
        if ((name === 'fill' || name === 'stroke') && /var\(/.test(attr.value)) continue; // becomes a palette class below
        attrs.push(`${name}="${escAttr(attr.value)}"`);
      }
      const styleOpacity = /(?:^|;)\s*(fill-opacity|stroke-opacity|opacity)\s*:\s*([0-9.]+)/.exec(style);
      if (styleOpacity && opacity == null) opacity = styleOpacity[2];
      if (/stroke\s*:\s*none/.test(style) && !el.hasAttribute('stroke')) attrs.push('stroke="none"');
      if (/fill\s*:\s*none/.test(style) && !el.hasAttribute('fill') && tag !== 'text' && !keep.includes('stroke-only')) keep.push('stroke-only');
      const styled = /(fill|stroke)\s*:/.test(style) || foreign.length
        || /var\(/.test(el.getAttribute('fill') || '') || /var\(/.test(el.getAttribute('stroke') || '');
      if (styled && !keep.some(isColorClass)) paintClasses(el, tag, keep);
      if (foreign.length) bump('approx', `svg-class:${foreign.join('.')}->palette`);
      if (opacity != null && opacity !== '' && Number(opacity) < 1) attrs.push(`opacity="${escAttr(String(opacity))}"`);
      if (keep.length) attrs.push(`class="${keep.join(' ')}"`);
      if (tag === 'svg') {
        const width = parseFloat(el.getAttribute('width'));
        const height = parseFloat(el.getAttribute('height'));
        if (!el.hasAttribute('viewBox') && width && height) attrs.push(`viewBox="0 0 ${width} ${height}"`);
        if (!el.hasAttribute('role')) attrs.push('role="img"');
      }
      out.push(`<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`);
      for (const c of el.childNodes) emit(c);
      out.push(`</${tag}>`);
    };
    emit(svg);
    return out.join('').replace(/>\s+</g, '>\n<');
  }

  // ---------- classification ----------
  const BOX_CLASS = new RegExp(P.boxes.classPattern);
  const isDemo = (el) => {
    if (el.matches(P.demos.selector)) return true;
    // Anything else holding form controls, a canvas or an empty (script-drawn) svg is a demo too.
    if (el.matches('figure, details, table, pre, ul, ol, p')) return false;
    const controls = el.querySelector('input, select, button, textarea, canvas');
    const emptySvg = [...el.querySelectorAll('svg')].some((s) => s.children.length === 0);
    return Boolean(controls || emptySvg) && /^(div|section|aside|form)$/.test(el.localName);
  };
  const isBox = (el) => (el.localName === 'aside')
    || ((el.localName === 'div' || el.localName === 'section') && classes(el).some((c) => BOX_CLASS.test(c)));
  const boxVariant = (el) => {
    const own = classes(el);
    return own.find((c) => P.boxes.variants.includes(c))
      || P.boxes.variantMap[own.find((c) => Object.hasOwn(P.boxes.variantMap, c))]
      || 'note';
  };
  const titleChild = (el) => [...el.children].find((c, i) => classes(c).some((k) => /(^|-)(title|heading|header)$/.test(k))
    || (i === 0 && /^h[2-6]$/.test(c.localName)));

  const blocks = [];
  const demos = [];
  let loose = [];
  const flushLoose = () => {
    if (!loose.length) return;
    const nodes = loose;
    loose = [];
    const text = nodes.map((n) => n.textContent).join('').trim();
    if (!text) return;
    const display = /^\$\$([\s\S]*?)\$\$$/.exec(text);
    if (display && !display[1].includes('$$') && nodes.every((n) => n.nodeType === 3)) {
      blocks.push({ type: 'math', latex: display[1].trim() });
      return;
    }
    blocks.push({ type: 'prose', html: `<p>${tidy(nodes.map((c) => ser(c)).join(''))}</p>` });
  };

  function demoBlock(el) {
    const titleEl = el.querySelector(P.demos.title) || titleChild(el);
    const hints = [...el.querySelectorAll(P.demos.hint)];
    const title = (titleEl && plain(titleEl)) || 'Interactive demo';
    const svgs = el.querySelectorAll('svg').length;
    demos.push({
      id: el.id || `demo-${demos.length + 1}`,
      title,
      hintText: hints.map(plain).join(' '),
      controls: el.querySelectorAll('input, select, button').length,
      svgs,
      canvases: el.querySelectorAll('canvas').length,
      outerHTML: el.outerHTML,
    });
    const html = hints.map((h) => `<p>${tidy(serChildren(h, {}))}</p>`).join('\n') || '<p>Interactive demo (not converted yet).</p>';
    blocks.push({ type: 'box', variant: 'note', title, html, demo: demos.length - 1 });
  }

  function figureBlocks(el) {
    const svgs = el.localName === 'svg' ? [el] : [...el.querySelectorAll('svg')].filter((s) => !s.parentElement.closest('svg'));
    const imgs = el.localName === 'img' ? [el] : [...el.querySelectorAll('img')];
    const captionEl = el.querySelector && el.querySelector('figcaption');
    const caption = captionEl ? plain(captionEl) : '';
    const items = [...svgs.map((svg) => ({ svg })), ...imgs.map((img) => ({ img }))];
    if (!items.length) {
      const html = serBlocks([...el.childNodes]);
      if (collapse(html)) blocks.push({ type: 'prose', html });
      return;
    }
    items.forEach((item, i) => {
      const alt = collapse(item.svg
        ? item.svg.getAttribute('aria-label') || item.svg.querySelector('title')?.textContent || ''
        : item.img.getAttribute('alt') || '');
      const ownCaption = i === items.length - 1 ? caption : '';
      const block = { type: 'figure', alt: alt || collapse(ownCaption).slice(0, 120) || 'Figure', caption: ownCaption || alt || 'Figure' };
      if (item.svg) block.svg = svgString(item.svg);
      else block.imgSrc = item.img.getAttribute('src') || '';
      blocks.push(block);
    });
  }

  function quizBlock(el) {
    const summary = el.querySelector(':scope > summary');
    const rest = [...el.childNodes].filter((c) => c !== summary);
    const elements = rest.filter((c) => c.nodeType === 1);
    const answerEl = elements.length === 1 && elements[0].matches(P.quiz.answer) ? elements[0] : null;
    const html = serBlocks(answerEl ? [...answerEl.childNodes] : rest);
    blocks.push({ type: 'quiz', question: (summary && plain(summary)) || 'Question', answer: html || '<p>—</p>' });
    for (const media of el.querySelectorAll('figure, svg')) {
      if (!media.parentElement.closest('figure, svg')) { bump('approx', 'figure-lifted-out-of-quiz'); figureBlocks(media); }
    }
  }

  function boxBlock(el) {
    const titleEl = titleChild(el);
    const variant = boxVariant(el);
    const body = [...el.childNodes].filter((c) => c !== titleEl);
    // Objects an html field cannot hold follow the box as their own blocks.
    const lifted = body.filter((c) => c.nodeType === 1 && (c.matches('figure, svg, details') || isDemo(c)));
    const html = serBlocks(body.filter((c) => !lifted.includes(c)));
    blocks.push({ type: 'box', variant, title: (titleEl && plain(titleEl)) || null, html: html || '<p></p>' });
    for (const c of lifted) { bump('approx', 'object-lifted-out-of-box'); walkBlock(c); }
  }

  function codeBlock(el) {
    const codeEl = el.querySelector('code');
    const languageClass = [...classes(el), ...(codeEl ? classes(codeEl) : [])].find((c) => /^(language|lang)-/.test(c));
    const language = languageClass?.replace(/^(language|lang)-/, '').toLowerCase();
    const valid = new RegExp(opts.codeLanguage).test(language ?? '');
    blocks.push({ type: 'code', language: valid ? language : P.code.defaultLanguage, code: el.textContent.replace(/^\n+|\s+$/g, '') });
  }

  function walkBlock(el) {
    if (el.nodeType === 3) { if (el.data.trim() || loose.length) loose.push(el); return; }
    if (el.nodeType !== 1) return;
    const tag = el.localName;
    if (SKIP_TAGS.has(tag)) return;
    if (EMBED_TAGS.has(tag)) { bump('dropped', `tag:${tag}`); return; }
    if ((INLINE_TAGS.has(tag) && tag !== 'img') || (isKatex(el) && !el.classList.contains('katex-display'))) { loose.push(el); return; }
    flushLoose();
    if (el.classList.contains('katex-display')) { blocks.push({ type: 'math', latex: katexToTex(el).slice(2, -2) }); return; }
    if (/^h[1-6]$/.test(tag)) {
      const text = plain(el);
      if (!text) { bump('dropped', `empty-${tag}`); return; }
      const level = P.lesson.headingLevels[tag] || 3;
      if (Number(tag[1]) !== level) bump('approx', `${tag}->heading level ${level}`);
      blocks.push({ type: 'heading', level, text, sourceId: el.id || null });
      return;
    }
    if (tag === 'hr') return;
    if (tag === 'pre') { codeBlock(el); return; }
    if (el.matches(P.quiz.selector)) { quizBlock(el); return; }
    if (tag === 'figure' || tag === 'svg' || tag === 'img') { figureBlocks(el); return; }
    if (['p', 'ul', 'ol', 'table', 'dl', 'blockquote'].includes(tag)) {
      const html = serBlocks([el]);
      if (collapse(el.textContent)) blocks.push({ type: 'prose', html });
      for (const svg of el.querySelectorAll('svg')) { bump('approx', 'svg-lifted-out-of-text'); figureBlocks(svg); }
      return;
    }
    if (isDemo(el)) { demoBlock(el); return; }
    if (isBox(el)) { boxBlock(el); return; }
    if (tag === 'header' || tag === 'nav' || tag === 'footer') { bump('dropped', `container:${tag}`); return; }
    for (const c of el.childNodes) walkBlock(c);
    flushLoose();
  }

  // ---------- header ----------
  const headerEl = root.querySelector(P.lesson.header);
  const h1 = (headerEl && headerEl.querySelector('h1')) || root.querySelector('h1');
  const page = { title: (h1 && plain(h1)) || collapse(document.title), lede: '', kicker: '', chips: [] };
  if (headerEl) {
    const lede = headerEl.querySelector(P.lesson.lede);
    if (lede && lede !== h1) page.lede = plain(lede);
    const kicker = headerEl.querySelector(P.lesson.kicker);
    if (kicker) page.kicker = plain(kicker);
    for (const chip of headerEl.querySelectorAll(P.lesson.chips)) {
      const label = chip.querySelector('b, strong');
      page.chips.push({ label: label ? plain(label).replace(/:\s*$/, '') : '', text: plain(chip), html: tidy(serChildren(chip, {})) });
    }
  }
  for (const c of root.childNodes) {
    if (c !== headerEl && c !== h1) walkBlock(c);
  }
  flushLoose();

  // ---------- source measurements (for the import report) ----------
  const demoEls = new Set(root.querySelectorAll(P.demos.selector));
  const inDemo = (n) => { for (let e = n.parentElement; e; e = e.parentElement) if (demoEls.has(e)) return true; return false; };
  let math = 0;
  const countMath = (s) => {
    for (let i = 0; i < s.length;) {
      if (s[i] === '\\' && s[i + 1] === '$') { i += 2; continue; }
      if (s[i] !== '$') { i += 1; continue; }
      const open = s[i + 1] === '$' ? 2 : 1;
      let j = i + open;
      while (j < s.length && !(s[j] === '$' && (open === 1 || s[j + 1] === '$'))) j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) return;
      math += 1;
      i = j + open;
    }
  };
  const measureWalk = (n, verbatim) => {
    if (n.nodeType === 3) { if (!verbatim) countMath(normDelims(n.data)); return; }
    if (n.nodeType !== 1) return;
    const tag = n.localName;
    if (SKIP_TAGS.has(tag) || FORM_TAGS.has(tag) || EMBED_TAGS.has(tag) || tag === 'svg') return;
    if (isKatex(n)) { math += 1; return; }
    if (inDemo(n) && n.matches(P.demos.chrome)) return;
    for (const c of n.childNodes) measureWalk(c, verbatim || tag === 'pre' || tag === 'code');
  };
  measureWalk(root, false);
  const topSvgs = [...root.querySelectorAll('svg')].filter((s) => !s.parentElement.closest('svg'));
  const svgInDemos = topSvgs.filter(inDemo).length;
  probe.remove();
  return { lang: document.documentElement.lang, ...page, blocks, demos, measure: { math, svg: topSvgs.length - svgInDemos, svgInDemos }, stats };
}
