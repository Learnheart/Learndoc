// Whole-lesson chat: a request for the entire lesson, without selecting blocks. It goes through
// the same preview / accept / cancel flow as a selection edit; while its preview is open, the next
// message refines it. Closing (× or Esc) drops the unsent draft; the conversation stays.

import { h, ui, shortHash } from './dom.js';
import { MODELS } from './ui.js';

const NO_SELECTION = { payload: { focusBlockIds: [], ranges: [] } };

// session: { phase, mode, edit, refine, subscribe }
export function createChat({ t, defaultModel, session }) {
  const log = h('div', { class: 'ld-ed-chat-log', 'aria-live': 'polite' },
    h('p', { class: 'ld-ed-muted' }, t('chatIntro')));
  const textarea = h('textarea', {
    class: 'ld-ed-input', rows: 3, placeholder: t('chatPlaceholder'), 'aria-label': t('chat'),
  });
  const select = h('select', { class: 'ld-ed-select', 'aria-label': t('model') },
    MODELS.map((m) => h('option', { value: m, selected: m === (MODELS.includes(defaultModel) ? defaultModel : MODELS[0]) }, m)));
  const sendButton = h('button', { type: 'button', class: 'ld-ed-btn is-primary', onclick: () => submit() }, t('send'));
  const hint = h('p', { class: 'ld-ed-muted ld-ed-chat-hint', hidden: true });
  const panel = ui('aside', { class: 'ld-ed-chat', role: 'dialog', 'aria-label': t('chat'), hidden: true },
    h('div', { class: 'ld-ed-prompt-head' },
      h('strong', {}, t('chat')),
      h('span', { class: 'ld-ed-chip' }, t('wholeLesson')),
      h('button', { type: 'button', class: 'ld-ed-prompt-x', title: t('close'), 'aria-label': t('close'), onclick: () => close() }, '×')),
    log,
    textarea,
    hint,
    h('div', { class: 'ld-ed-prompt-foot' },
      h('label', { class: 'ld-ed-muted' }, `${t('model')} `, select),
      h('span', { class: 'ld-ed-muted ld-ed-hint' }, t('keysHint')),
      sendButton));
  document.body.append(panel);

  // A new request when idle, a refinement while this chat's own preview is open; otherwise wait.
  const action = () => {
    if (session.phase === 'idle') return 'edit';
    if (session.phase === 'ready' && session.mode === 'lesson') return 'refine';
    return null;
  };

  function sync() {
    const next = action();
    sendButton.disabled = !next;
    hint.hidden = !!next;
    hint.textContent = session.phase === 'running' ? t('chatWaiting') : t('chatBusy');
  }

  function say(role, ...content) {
    log.append(h('div', { class: `ld-ed-chat-msg is-${role}` }, ...content));
    log.scrollTop = log.scrollHeight;
  }

  function submit() {
    const instruction = textarea.value.trim();
    const next = action();
    if (!instruction || !next) {
      textarea.focus();
      return;
    }
    textarea.value = '';
    say('user', instruction);
    if (next === 'edit') session.edit('lesson', instruction, NO_SELECTION, select.value);
    else session.refine(instruction, null, select.value);
  }

  function close() {
    textarea.value = '';
    panel.hidden = true;
  }

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });

  session.subscribe((event) => {
    sync();
    if (event.mode !== 'lesson') return;
    if (event.type === 'ready') say('claude', h('strong', {}, event.summary || t('chatNoSummary')), h('div', { class: 'ld-ed-muted' }, t('chatReview')));
    else if (event.type === 'failed') say('error', event.message || t('failedTitle'));
    else if (event.type === 'accepted') say('system', event.commit ? t('accepted', shortHash(event.commit)) : t('nothingChanged'));
    else if (event.type === 'cancelled') say('system', t('cancelled'));
    // Back to the chat for the next message (a failure opens a dialog, which keeps the focus).
    if (!panel.hidden && ['ready', 'accepted', 'cancelled'].includes(event.type)) textarea.focus({ preventScroll: true });
  });

  return {
    toggle() {
      if (!panel.hidden) return close();
      panel.hidden = false;
      sync();
      textarea.focus();
    },
  };
}
