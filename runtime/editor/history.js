// History drawer: saved changesets (git commits). Clicking an entry scrolls to the blocks
// it changed; "View diff" shows the commit's changes in the page. Restoring to before a
// commit undoes that change and every later one (as a new commit), so it asks first.

import { h, ui, shortHash, openDialog, toast } from './dom.js';
import { errorText } from './i18n.js';

// session: { revert(commit), showCommit(view, { onRestore }), jumpTo(blockIds) }
export function createHistory({ api, lessonId, t, session }) {
  const historyPath = `/api/lessons/${encodeURIComponent(lessonId)}/history`;
  const views = new Map(); // commit -> Promise of its commit view (commits never change)
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

  function commitView(commit) {
    if (!views.has(commit)) {
      const loading = api.get(`${historyPath}/${commit}`);
      loading.catch(() => views.delete(commit));
      views.set(commit, loading);
    }
    return views.get(commit);
  }

  async function jump(entry) {
    try {
      const view = await commitView(entry.commit);
      const ids = view.changes.filter((c) => c.op !== 'delete').map((c) => c.blockId);
      const found = await session.jumpTo(ids);
      if (!found) toast(t(ids.length ? 'historyGone' : 'historyOnlyDeleted'));
    } catch (err) {
      toast(t('error', errorText(err, t)), { error: true });
    }
  }

  async function showDiff(entry) {
    try {
      const view = await commitView(entry.commit);
      close();
      await session.showCommit(view, { onRestore: () => confirmRestore(entry) });
    } catch (err) {
      toast(t('error', errorText(err, t)), { error: true });
    }
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
            if (button) button.disabled = true;
            session.revert(entry.commit).finally(refresh);
          },
        },
      ],
    });
  }

  async function refresh() {
    list.replaceChildren(h('li', { class: 'ld-ed-muted' }, t('loading')));
    try {
      const entries = await api.get(historyPath);
      if (!entries.length) {
        list.replaceChildren(h('li', { class: 'ld-ed-muted' }, t('historyEmpty')));
        return;
      }
      list.replaceChildren(...entries.map((entry) => h('li', {},
        h('button', { type: 'button', class: 'ld-ed-history-entry', title: t('historyJump'), onclick: () => jump(entry) },
          h('span', {}, entry.summary),
          h('span', { class: 'ld-ed-muted' },
            h('code', {}, shortHash(entry.commit)), ' · ', new Date(entry.date).toLocaleString(t.lang))),
        entry.restorable === false && h('div', { class: 'ld-ed-muted' }, t('notRestorable')),
        h('div', { class: 'ld-ed-history-actions' },
          h('button', { type: 'button', class: 'ld-ed-btn', onclick: () => showDiff(entry) }, t('viewCommitDiff')),
          entry.restorable !== false && h('button', {
            type: 'button', class: 'ld-ed-btn',
            onclick: (e) => confirmRestore(entry, e.currentTarget),
          }, t('restoreBefore'))))));
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
