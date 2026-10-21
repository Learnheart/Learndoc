// Floating toolbar, prompt popover and the fixed status/summary bar.

import { mathSpan } from '/static/shared/render.mjs';
import { renderMath } from '../lesson.js';
import { h, ui } from './dom.js';

const QUOTE_CHARS = 220;
const WHOLE_BLOCK_CHARS = 60;
const MODELS = ['sonnet', 'opus'];
const IS_MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.userAgent);

// Places a floating element below a document-coordinate point, flipping above
// when there is no room and clamping to the viewport horizontally.
function place(el, point) {
  const { width, height } = el.getBoundingClientRect();
  const x = Math.min(Math.max(point.x, scrollX + 12), scrollX + innerWidth - width - 12);
  const below = point.y + 8;
  const fits = below + height < scrollY + innerHeight - 8;
  el.style.left = `${x}px`;
  el.style.top = `${fits ? below : Math.max(scrollY + 8, point.y - height - 32)}px`;
}

export function createToolbar({ t, onAction }) {
  const el = ui('div', { class: 'ld-ed-toolbar', role: 'toolbar', hidden: true });
  // Keep the page selection alive while clicking toolbar buttons.
  el.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.append(el);
  let point = null;
  return {
    show(actions, at) {
      point = at;
      el.replaceChildren(...actions.map((action, i) => h('button', {
        type: 'button', class: 'ld-ed-btn', onclick: () => onAction(action, point),
      }, t(action), i === 0 && h('kbd', {}, IS_MAC ? '⌘K' : 'Ctrl K'))));
      el.hidden = false;
      place(el, at);
    },
    hide() {
      el.hidden = true;
    },
  };
}

// Appends text/formula parts to `el`, at most `budget` text characters; returns what is left.
export function appendParts(el, parts, budget) {
  for (const part of parts) {
    if (budget <= 0) {
      el.append('…');
      break;
    }
    if (part.latex !== undefined) {
      el.insertAdjacentHTML('beforeend', mathSpan(part.latex, false, 0));
    } else if (part.text.length > budget) {
      el.append(`${part.text.slice(0, budget).trimEnd()}…`);
      budget = 0;
      break;
    } else {
      el.append(part.text);
      budget -= part.text.length;
    }
  }
  renderMath(el);
  return budget;
}

function quotePreview(model, t) {
  const box = h('div', { class: 'ld-ed-quote' });
  let budget = QUOTE_CHARS;
  for (const item of model?.quote ?? []) {
    if (budget <= 0) break;
    const line = h('div');
    if (item.whole) line.append(h('span', { class: 'ld-ed-tag' }, t('wholeBlock')), ' ');
    if (item.parts.length) {
      // A whole block only gets a short excerpt so several blocks stay visible.
      const allowance = item.whole ? Math.min(budget, WHOLE_BLOCK_CHARS) : budget;
      budget -= allowance - appendParts(line, item.parts, allowance);
    } else {
      line.append(item.blockId);
    }
    box.append(line);
  }
  return box;
}

function scopeLabel(model, t) {
  if (!model) return t('noSelection');
  return [t('blocks', model.blockIds.length), model.mathCount > 0 && t('formulas', model.mathCount)].filter(Boolean).join(' · ');
}

// onSubmit({ mode, instruction, model }) where model is the chosen Claude model.
export function createPrompt({ t, defaultModel, onSubmit }) {
  let currentEl = null;
  let chosenModel = MODELS.includes(defaultModel) ? defaultModel : MODELS[0];

  function close() {
    currentEl?.remove();
    currentEl = null;
  }

  function open({ mode, selection, point }) {
    close();
    const textarea = h('textarea', {
      class: 'ld-ed-input', rows: 3,
      placeholder: t(mode === 'ask' ? 'placeholderAsk' : 'placeholderEdit'),
      'aria-label': t(mode),
    });
    const select = h('select', { class: 'ld-ed-select', 'aria-label': t('model') },
      MODELS.map((m) => h('option', { value: m, selected: m === chosenModel }, m)));
    const submit = () => {
      const instruction = textarea.value.trim();
      if (!instruction) {
        textarea.focus();
        return;
      }
      chosenModel = select.value;
      close();
      onSubmit({ mode, instruction, model: chosenModel });
    };
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        submit();
      }
    });
    const el = ui('div', { class: 'ld-ed-prompt', role: 'dialog', 'aria-label': t(mode) },
      h('div', { class: 'ld-ed-prompt-head' },
        h('strong', {}, t(mode)),
        h('span', { class: 'ld-ed-chip' }, scopeLabel(selection, t))),
      selection && quotePreview(selection, t),
      textarea,
      h('div', { class: 'ld-ed-prompt-foot' },
        h('label', { class: 'ld-ed-muted' }, `${t('model')} `, select),
        h('span', { class: 'ld-ed-muted ld-ed-hint' }, t('keysHint')),
        h('button', { type: 'button', class: 'ld-ed-btn is-primary', onclick: submit }, t('send'))));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    });
    document.body.append(el);
    place(el, point);
    textarea.focus();
    currentEl = el;
  }

  return { open, close, get isOpen() { return currentEl !== null; } };
}

// Fixed bar under the topbar; body gets padding so it never covers the content.
export function createBar() {
  const el = ui('div', { class: 'ld-ed-bar', hidden: true });
  document.body.append(el);
  const syncHeight = () => {
    document.documentElement.style.setProperty('--ld-ed-bar-h', `${el.hidden ? 0 : el.offsetHeight}px`);
  };
  new ResizeObserver(syncHeight).observe(el);
  return {
    set(content) {
      el.replaceChildren(...(content ? [content] : []));
      el.hidden = !content;
      document.body.classList.toggle('ld-ed-has-bar', !!content);
      syncHeight();
    },
  };
}

// "Claude is working… 12s [Cancel]"; tick() refreshes the elapsed time.
export function runningStatus({ t, startedAt, onCancel }) {
  const elapsed = h('span', { class: 'ld-ed-muted' });
  const node = ui('div', { class: 'ld-ed-running', role: 'status' },
    h('span', { class: 'ld-ed-spinner', 'aria-hidden': 'true' }),
    h('span', {}, t('running')),
    elapsed,
    h('button', { type: 'button', class: 'ld-ed-btn', onclick: onCancel }, t('cancel')));
  const tick = () => {
    elapsed.textContent = t('seconds', Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
  };
  tick();
  return { node, tick };
}
