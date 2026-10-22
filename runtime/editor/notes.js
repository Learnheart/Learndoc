// Ask-mode answers as notes. The asked passages are marked in the text (CSS highlights);
// clicking a mark opens or closes its note, clicking a note's question scrolls back to
// the passage. Notes live inside the block section as data-chrome, so selection and text
// views ignore them; place() re-attaches them after any body re-render.

import { wrapMath } from '/static/shared/render.mjs';
import { textViewFromDom } from '/static/shared/textview.mjs';
import { renderMath } from '../lesson.js';
import { h, ui, openDialog, toast } from './dom.js';
import { errorText } from './i18n.js';

const MARK = 'ld-asked';
const MARK_OPEN = 'ld-asked-open';
const MARK_FLASH = 'ld-asked-flash';
const LIST_WORDS = 14;
const LIST_CHARS = 90;

// The question cut to a few words for the notes list (the full text goes in the tooltip).
function shortQuestion(text) {
  const words = String(text ?? '').trim().split(/\s+/);
  let short = words.slice(0, LIST_WORDS).join(' ');
  if (short.length > LIST_CHARS) short = short.slice(0, LIST_CHARS).replace(/\s+\S*$/, '');
  return short.length < String(text ?? '').trim().length ? `${short}…` : short;
}

function commonSuffix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// DOM Range of a quote ({ exact, prefix, suffix }) in a rendered field; the occurrence whose
// surroundings match prefix/suffix best wins. null when the text no longer contains it.
function locate(field, quote) {
  const exact = quote?.exact ?? '';
  if (!exact) return null;
  const { text, points } = textViewFromDom(field);
  let best = -1;
  let bestScore = -1;
  for (let i = text.indexOf(exact); i >= 0; i = text.indexOf(exact, i + 1)) {
    const score = commonSuffix(text.slice(0, i), quote.prefix ?? '') + commonPrefix(text.slice(i + exact.length), quote.suffix ?? '');
    if (score > bestScore) [best, bestScore] = [i, score];
  }
  if (best < 0) return null;
  const first = points[best];
  const last = points[best + exact.length - 1];
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    return pos && { node: pos.offsetNode, offset: pos.offset };
  }
  const range = document.caretRangeFromPoint?.(x, y);
  return range && { node: range.startContainer, offset: range.startOffset };
}

const setHighlight = (name, ranges) => {
  if (!CSS.highlights) return;
  if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
  else CSS.highlights.delete(name);
};

export function createNotes({ api, lessonId, main, sectionOf, t, button }) {
  let notes = [];
  const open = new Set(); // keys of the notes shown
  let marks = new Map(); // note key -> Range[] of its passage in the current DOM
  let localSeq = 0;
  let flashTimer = null;

  // Dropdown under the topbar button: one line per note, in lesson order.
  const list = ui('div', { class: 'ld-ed-notelist', role: 'dialog', 'aria-label': t('notesList'), hidden: true });
  document.body.append(list);

  const keyOf = (note) => {
    note.key ??= note.id ?? `local-${++localSeq}`;
    return note.key;
  };

  function render(note) {
    const key = keyOf(note);
    const answer = h('div', { class: 'ld-ed-note-answer' });
    // The answer is server-validated whitelisted HTML (answer.schema.json), like block html.
    answer.innerHTML = wrapMath(note.answer ?? '', 'html');
    const el = h('aside', { class: 'ld-ed-note', 'data-note-key': key },
      h('div', { class: 'ld-ed-note-head' },
        h('button', {
          type: 'button', class: 'ld-ed-note-q', title: t('noteGoTo'), onclick: () => goTo(note),
        }, h('strong', {}, `${t('noteQuestion')}: `), note.question ?? ''),
        h('button', {
          type: 'button', class: 'ld-ed-note-x', title: t('noteHide'), 'aria-label': t('noteHide'),
          onclick: () => toggle(key, false),
        }, '–'),
        h('button', {
          type: 'button', class: 'ld-ed-note-x', title: t('noteDelete'), 'aria-label': t('noteDelete'),
          onclick: () => confirmDelete(note),
        }, '×')),
      answer,
      note.sources?.length > 0 && h('div', { class: 'ld-ed-note-sources' },
        `${t('sources')}: `, note.sources.map((s) => h('code', {}, s))),
      note.createdAt && h('time', { datetime: note.createdAt }, new Date(note.createdAt).toLocaleString(t.lang)));
    renderMath(el);
    return el;
  }

  function rangesOf(note) {
    const found = [];
    for (const r of note.ranges ?? []) {
      if (r.whole || !r.quote) continue;
      const section = sectionOf(r.blockId);
      const field = section?.querySelector(r.field ? `[data-field="${CSS.escape(r.field)}"]` : '[data-field]');
      const range = field && locate(field, r.quote);
      if (range) found.push(range);
    }
    return found;
  }

  function place() {
    for (const el of main.querySelectorAll('.ld-ed-notes, .ld-ed-note-mark')) el.remove();
    const known = new Set(notes.map(keyOf));
    for (const key of open) if (!known.has(key)) open.delete(key);
    const allOpen = notes.length > 0 && notes.every((n) => open.has(keyOf(n)));
    button.textContent = t('notes', notes.length);
    button.title = t('notesList');
    button.setAttribute('aria-expanded', String(!list.hidden));
    button.hidden = notes.length === 0;
    if (!notes.length) list.hidden = true;
    if (!list.hidden) renderList(allOpen);

    marks = new Map(notes.map((n) => [keyOf(n), rangesOf(n)]));
    setHighlight(MARK, [...marks.values()].flat());
    setHighlight(MARK_OPEN, notes.filter((n) => open.has(keyOf(n))).flatMap((n) => marks.get(keyOf(n))));

    // A note whose passage cannot be marked in the text (whole block, or the text changed)
    // gets a marker button on its block instead.
    const unmarked = Map.groupBy(notes.filter((n) => !marks.get(keyOf(n)).length), (n) => n.blockId);
    for (const [blockId, list] of unmarked) {
      const keys = list.map(keyOf);
      const shown = keys.every((k) => open.has(k));
      sectionOf(blockId)?.append(ui('button', {
        type: 'button', class: 'ld-ed-note-mark', 'data-chrome': true, 'aria-pressed': String(shown),
        title: t('noteMark'), 'aria-label': t('noteMark'),
        onclick: () => {
          for (const k of keys) toggle(k, !shown, { place: false });
          place();
        },
      }, `? ${list.length > 1 ? list.length : ''}`.trim()));
    }

    const byBlock = Map.groupBy(notes.filter((n) => open.has(keyOf(n))), (n) => n.blockId);
    for (const [blockId, list] of byBlock) {
      sectionOf(blockId)?.append(ui('div', { class: 'ld-ed-notes', 'data-chrome': true }, list.map(render)));
    }
  }

  function toggle(key, show = !open.has(key), { place: replace = true } = {}) {
    if (show) open.add(key);
    else open.delete(key);
    if (replace) place();
  }

  const noteEl = (note) => main.querySelector(`.ld-ed-note[data-note-key="${CSS.escape(keyOf(note))}"]`);

  // Scrolls to the asked passage (or its block) and flashes it.
  function goTo(note) {
    const ranges = marks.get(keyOf(note)) ?? [];
    clearTimeout(flashTimer);
    if (ranges.length) {
      const r = ranges[0].getBoundingClientRect();
      scrollTo({ top: scrollY + r.top - innerHeight / 3, behavior: 'smooth' });
      setHighlight(MARK_FLASH, ranges);
      flashTimer = setTimeout(() => setHighlight(MARK_FLASH, []), 1600);
      return;
    }
    const section = sectionOf(note.blockId);
    if (!section) return;
    section.scrollIntoView({ block: 'center', behavior: 'smooth' });
    section.classList.add('is-flash');
    flashTimer = setTimeout(() => section.classList.remove('is-flash'), 1200);
  }

  function confirmDelete(note) {
    openDialog({
      title: t('noteDeleteTitle'),
      body: h('div', {}, h('p', {}, note.question ?? ''), h('p', { class: 'ld-ed-muted' }, t('noteDeleteBody'))),
      actions: [
        { label: t('cancel'), onClick: () => {} },
        { label: t('delete'), primary: true, onClick: () => remove(note) },
      ],
    });
  }

  async function remove(note) {
    try {
      if (note.id) await api.del(`/api/lessons/${encodeURIComponent(lessonId)}/notes/${encodeURIComponent(note.id)}`);
      notes = notes.filter((n) => n !== note);
      place();
      toast(t('noteDeleted'));
    } catch (err) {
      toast(t('error', errorText(err, t)), { error: true });
    }
  }

  // The note whose marked passage is under the viewport point, if any.
  function noteAt(x, y) {
    if (!marks.size) return null;
    const caret = caretAt(x, y);
    if (!caret || !main.contains(caret.node)) return null;
    for (const note of notes) {
      const hit = (marks.get(keyOf(note)) ?? []).some((r) => {
        try {
          return r.isPointInRange(caret.node, caret.offset) && r.getClientRects().length > 0
            && [...r.getClientRects()].some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
        } catch {
          return false;
        }
      });
      if (hit) return note;
    }
    return null;
  }

  main.addEventListener('click', (e) => {
    if (e.button !== 0 || !getSelection().isCollapsed || e.target.closest('[data-ld-ui], .ld-ed-notes, .ld-widget')) return;
    const note = noteAt(e.clientX, e.clientY);
    if (!note) return;
    toggle(keyOf(note));
    if (open.has(keyOf(note))) noteEl(note)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  let hoverFrame = 0;
  main.addEventListener('mousemove', (e) => {
    if (hoverFrame || !marks.size) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      main.classList.toggle('ld-ed-over-note', !!noteAt(e.clientX, e.clientY));
    });
  });

  function renderList(allOpen) {
    const order = new Map([...main.querySelectorAll(':scope > section[data-block-id]')].map((s, i) => [s.dataset.blockId, i]));
    const sorted = notes.toSorted((a, b) => (order.get(a.blockId) ?? Infinity) - (order.get(b.blockId) ?? Infinity)
      || String(a.createdAt).localeCompare(String(b.createdAt)));
    list.replaceChildren(
      h('div', { class: 'ld-ed-notelist-head' },
        h('strong', {}, t('notes', notes.length)),
        h('button', {
          type: 'button', class: 'ld-ed-link',
          onclick: () => {
            for (const n of notes) toggle(keyOf(n), !allOpen, { place: false });
            place();
          },
        }, t(allOpen ? 'notesCloseAll' : 'notesOpenAll'))),
      h('ol', {}, sorted.map((note) => h('li', {},
        h('button', {
          type: 'button', class: 'ld-ed-notelist-item', title: note.question ?? '',
          'aria-current': open.has(keyOf(note)) ? 'true' : null,
          onclick: () => {
            closeList();
            toggle(keyOf(note), true);
            goTo(note);
          },
        }, shortQuestion(note.question))))));
  }

  function closeList() {
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  button.addEventListener('click', () => {
    if (!list.hidden) {
      closeList();
      return;
    }
    list.hidden = false;
    place();
    const r = button.getBoundingClientRect();
    list.style.top = `${r.bottom + 6}px`;
    list.style.right = `${Math.max(8, innerWidth - r.right)}px`;
    list.querySelector('.ld-ed-notelist-item')?.focus();
  });
  document.addEventListener('mousedown', (e) => {
    if (!list.hidden && !list.contains(e.target) && !button.contains(e.target)) closeList();
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeList();
      button.focus();
    }
  });

  return {
    place,
    async load() {
      notes = await api.get(`/api/lessons/${encodeURIComponent(lessonId)}/notes`);
      place();
    },
    // Shows a fresh Ask answer and scrolls to it; the server copy wins when already loaded.
    reveal(note) {
      let shown = notes.find((n) => n.blockId === note.blockId && n.answer === note.answer);
      if (!shown) {
        shown = note;
        notes.push(note);
      }
      open.add(keyOf(shown));
      place();
      noteEl(shown)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
  };
}
