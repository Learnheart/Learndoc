// Ask-mode answers shown as margin notes beside their focus block.
// Notes live inside the block section as data-chrome, so selection and text views
// ignore them; place() re-attaches them after any body re-render.

import { wrapMath } from '/static/shared/render.mjs';
import { renderMath } from '../lesson.js';
import { h } from './dom.js';

export function createNotes({ api, lessonId, main, sectionOf, t, button }) {
  let notes = [];
  let visible = true;

  function render(note) {
    const answer = h('div', { class: 'ld-ed-note-answer' });
    // The answer is server-validated whitelisted HTML (answer.schema.json), like block html.
    answer.innerHTML = wrapMath(note.answer ?? '', 'html');
    const el = h('aside', { class: 'ld-ed-note', 'data-note-id': note.id ?? null },
      h('div', { class: 'ld-ed-note-q' }, h('strong', {}, `${t('noteQuestion')}: `), note.question ?? ''),
      answer,
      note.sources?.length > 0 && h('div', { class: 'ld-ed-note-sources' },
        `${t('sources')}: `, note.sources.map((s) => h('code', {}, s))),
      note.createdAt && h('time', { datetime: note.createdAt }, new Date(note.createdAt).toLocaleString(t.lang)));
    renderMath(el);
    return el;
  }

  function place() {
    for (const el of main.querySelectorAll('.ld-ed-notes')) el.remove();
    button.textContent = t('notes', notes.length);
    button.setAttribute('aria-pressed', String(visible));
    button.hidden = notes.length === 0;
    if (!visible) return;
    const byBlock = Map.groupBy(notes, (n) => n.blockId);
    for (const [blockId, list] of byBlock) {
      sectionOf(blockId)?.append(h('div', { class: 'ld-ed-notes', 'data-chrome': true }, list.map(render)));
    }
  }

  button.addEventListener('click', () => {
    visible = !visible;
    place();
  });

  return {
    place,
    async load() {
      notes = await api.get(`/api/lessons/${encodeURIComponent(lessonId)}/notes`);
      place();
    },
    // Shows a fresh Ask answer and scrolls to it; the server copy wins when already loaded.
    reveal(note) {
      const stored = notes.find((n) => n.blockId === note.blockId && n.answer === note.answer);
      if (!stored) notes.push(note);
      visible = true;
      place();
      sectionOf(note.blockId)?.querySelector('.ld-ed-notes')?.lastElementChild?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
  };
}
