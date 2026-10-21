// History drawer: saved changesets (git commits). Restoring to before a commit undoes
// that change and every later one (as a new commit), so it asks for confirmation first.

import { h, ui, shortHash, openDialog } from './dom.js';
import { errorText } from './i18n.js';

export function createHistory({ api, lessonId, t, onRevert }) {
  const list = h('ol', { class: 'ld-ed-history' });
  const closeButton = h('button', { type: 'button', class: 'ld-ed-btn', onclick: () => close() }, t('close'));
  const drawer = ui('aside', { class: 'ld-ed-drawer', role: 'dialog', 'aria-label': t('history'), hidden: true },
    h('div', { class: 'ld-ed-drawer-head' }, h('h2', {}, t('history')), closeButton),
    list);
  drawer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  document.body.append(drawer);

  function close() {
    drawer.hidden = true;
  }

  function confirmRestore(entry, button) {
    openDialog({
      title: t('restoreTitle'),
      body: h('div', {},
        h('p', {}, entry.summary),
        h('p', {}, t('restoreBody', shortHash(entry.commit)))),
      actions: [
        { label: t('cancel'), onClick: () => {} },
        {
          label: t('restore'),
          primary: true,
          onClick: () => {
            button.disabled = true;
            onRevert(entry.commit).finally(refresh);
          },
        },
      ],
    });
  }

  async function refresh() {
    list.replaceChildren(h('li', { class: 'ld-ed-muted' }, t('loading')));
    try {
      const entries = await api.get(`/api/lessons/${encodeURIComponent(lessonId)}/history`);
      if (!entries.length) {
        list.replaceChildren(h('li', { class: 'ld-ed-muted' }, t('historyEmpty')));
        return;
      }
      list.replaceChildren(...entries.map((entry) => h('li', {},
        h('div', {}, entry.summary),
        h('div', { class: 'ld-ed-muted' },
          h('code', {}, shortHash(entry.commit)), ' · ', new Date(entry.date).toLocaleString(t.lang)),
        entry.restorable === false
          ? h('div', { class: 'ld-ed-muted' }, t('notRestorable'))
          : h('button', {
            type: 'button', class: 'ld-ed-btn',
            onclick: (e) => confirmRestore(entry, e.currentTarget),
          }, t('restoreBefore')))));
    } catch (err) {
      list.replaceChildren(h('li', { class: 'ld-ed-error' }, t('error', errorText(err, t))));
    }
  }

  return {
    toggle() {
      drawer.hidden = !drawer.hidden;
      if (!drawer.hidden) {
        refresh();
        closeButton.focus();
      }
    },
  };
}
