// In-page editor (loaded only on pages served by the local edit server): wires the
// selection gestures, toolbar, prompt, notes and history to the changeset session.

import { resolveBoxTypes } from '/static/shared/render.mjs';
import { makeT } from './editor/i18n.js';
import { createApi } from './editor/api.js';
import { ui, isUi, toast } from './editor/dom.js';
import { createSelection } from './editor/selection.js';
import { createBody, findSection } from './editor/body.js';
import { createToolbar, createPrompt, createBar } from './editor/ui.js';
import { createNotes } from './editor/notes.js';
import { createHistory } from './editor/history.js';
import { createSession } from './editor/session.js';

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content;

async function boot() {
  const main = document.querySelector('main.ld-lesson');
  const lessonId = meta('learndoc-lesson') ?? main?.dataset.lessonId;
  if (!main || !lessonId) return;
  await window.learndoc.ready;

  const api = createApi(meta('learndoc-token') ?? '');
  const initial = await api.get(`/api/lessons/${encodeURIComponent(lessonId)}`);
  const config = initial.config ?? {};
  const t = makeT(config.language ?? document.documentElement.lang);
  const sectionOf = (id) => findSection(main, id);

  const topbar = document.querySelector('.ld-topbar');
  const topButton = (label, extra = {}) => ui('button', { type: 'button', class: 'ld-ed-topbtn', ...extra }, label);
  const addToTopbar = (...buttons) => {
    const toggle = topbar?.querySelector('.ld-theme-toggle');
    if (toggle) toggle.before(...buttons);
    else (topbar ?? document.body).append(...buttons);
  };

  const notesButton = topButton('', { hidden: true, title: t('notesToggle') });
  addToTopbar(notesButton);
  const notes = createNotes({ api, lessonId, main, sectionOf, t, button: notesButton });
  notes.load().catch((err) => console.error('learndoc editor: notes failed to load', err));

  if (!matchMedia('(hover: hover) and (pointer: fine)').matches || innerWidth < 900) {
    toast(t('desktopOnly'));
    return;
  }

  const ctx = { boxTypes: resolveBoxTypes(config), lessonId, linkBase: '/lessons/', language: config.language };
  const body = createBody({ main, ctx, lesson: initial.lesson, t });
  let lastPoint = null;

  // Selecting starts an edit, or points at preview content to refine it.
  const canSelect = () => session.phase === 'idle' || (session.phase === 'ready' && session.previewMode === 'new');

  const selection = createSelection({
    main,
    sectionOf,
    enabled: canSelect,
    onChange(model, point) {
      if (!model) {
        toolbar.hide();
        return;
      }
      lastPoint = point;
      toolbar.show(session.phase === 'idle' ? ['replace', 'insert', 'ask'] : ['refine'], point);
    },
  });
  const toolbar = createToolbar({ t, onAction: (action, point) => openPrompt(action, point) });
  const prompt = createPrompt({
    t,
    defaultModel: config.editModel,
    onSubmit({ mode, instruction, model }) {
      const sel = selection.current;
      selection.clear();
      getSelection().removeAllRanges();
      if (mode === 'refine') session.refine(instruction, sel, model);
      else session.edit(mode, instruction, sel, model);
    },
  });

  // The prompt sits by the selection when there is one, else at `fallback` or under the bar.
  function openPrompt(mode, fallback) {
    toolbar.hide();
    let point = selection.current ? lastPoint : fallback;
    if (!point) {
      const rect = document.querySelector('.ld-ed-bar')?.getBoundingClientRect();
      point = { x: scrollX + innerWidth / 2 - 240, y: scrollY + (rect?.height ? rect.bottom : 80) };
    }
    prompt.open({ mode, selection: selection.current, point });
  }

  const session = createSession({
    api, t, lessonId, lesson: initial.lesson, main, body, bar: createBar(), notes, selection, toolbar, prompt, openPrompt,
  });

  const history = createHistory({ api, lessonId, t, onRevert: session.revert });
  addToTopbar(topButton(t('history'), { onclick: () => history.toggle() }));

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !prompt.isOpen) {
      if (session.phase === 'idle' && selection.current) {
        e.preventDefault();
        openPrompt('replace');
      } else if (session.phase === 'ready') {
        e.preventDefault();
        openPrompt('refine');
      }
    } else if (e.key === 'Escape' && !prompt.isOpen && !isUi(e.target)) {
      selection.clear();
    }
  });

  session.resume(initial);
}

boot().catch((err) => {
  console.error('learndoc editor: failed to start', err);
  toast(`learndoc editor: ${err.message}`, { error: true });
});
