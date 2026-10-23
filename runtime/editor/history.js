// History drawer: saved changesets (git commits). Clicking an entry scrolls to the blocks
// it changed; "View diff" shows the commit's changes in the page. Restoring to before a
// commit undoes that change and every later one (as a new commit), so it asks first.
// Entries can be deleted (ticked ones, or all): git history is rewritten and pruned, the lesson
// stays as it is; that cannot be undone, so it asks first too.

import { h, ui, shortHash, openDialog, toast } from './dom.js';
import { errorText } from './i18n.js';

// session: { revert(commit), showCommit(view, { onRestore }), closeCommit(), jumpTo(blockIds) }
export function createHistory({ api, lessonId, t, session }) {
  const historyPath = `/api/lessons/${encodeURIComponent(lessonId)}/history`;
  const views = new Map(); // commit -> Promise of its commit view (commits never change)
  const list = h('ol', { class: 'ld-ed-history' });
  const closeButton = h('button', { type: 'button', class: 'ld-ed-btn', onclick: () => close() }, t('close'));
  const ticked = new Set(); // commits ticked for deletion
  let deletable = [];
  const deleteSelected = h('button', { type: 'button', class: 'ld-ed-btn', disabled: true, onclick: () => confirmDelete(false) }, t('deleteSelected', 0));
  const deleteAll = h('button', { type: 'button', class: 'ld-ed-btn', disabled: true, onclick: () => confirmDelete(true) }, t('deleteAll'));
  const syncBulk = () => {
    deleteSelected.textContent = t('deleteSelected', ticked.size);
    deleteSelected.disabled = ticked.size === 0;
    deleteAll.disabled = deletable.length === 0;
  };
  const drawer = ui('aside', { class: 'ld-ed-drawer', role: 'dialog', 'aria-label': t('history'), hidden: true },
    h('div', { class: 'ld-ed-drawer-head' }, h('h2', {}, t('history')), closeButton),
    h('div', { class: 'ld-ed-history-bulk' }, deleteSelected, deleteAll),
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

  function confirmDelete(all) {
    const commits = all ? deletable : [...ticked];
    if (!commits.length) return;
    openDialog({
      title: all ? t('deleteAllTitle') : t('deleteHistoryTitle', commits.length),
      body: h('div', {}, h('p', {}, t(all ? 'deleteAllBody' : 'deleteHistoryBody'))),
      actions: [
        { label: t('cancel'), onClick: () => {} },
        { label: t('delete'), primary: true, onClick: () => remove(all ? { all: true } : { commits }) },
      ],
    });
  }

  async function remove(body) {
    deleteSelected.disabled = true;
    deleteAll.disabled = true;
    // Commit hashes change, so a saved commit shown in the page would be stale.
    await session.closeCommit();
    try {
      const res = await api.post(`${historyPath}/delete`, body);
      const notes = [res.retainedVersions > 0 && t('historyRetained', res.retainedVersions), res.cleanupError && t('historyNotFreed')];
      toast([t('historyDeleted', res.removed, formatBytes(res.freedBytes, t.lang)), ...notes.filter(Boolean)].join(' · '));
    } catch (err) {
      toast(t('error', errorText(err, t)), { error: true });
    }
    views.clear();
    await refresh();
  }

  async function refresh() {
    ticked.clear();
    deletable = [];
    syncBulk();
    list.replaceChildren(h('li', { class: 'ld-ed-muted' }, t('loading')));
    try {
      const entries = await api.get(historyPath);
      deletable = entries.filter((e) => e.deletable).map((e) => e.commit);
      syncBulk();
      if (!entries.length) {
        list.replaceChildren(h('li', { class: 'ld-ed-muted' }, t('historyEmpty')));
        return;
      }
      list.replaceChildren(...entries.map((entry) => h('li', {},
        h('div', { class: 'ld-ed-history-row' },
          entry.deletable && h('input', {
            type: 'checkbox', class: 'ld-ed-history-tick', title: t('historySelect'), 'aria-label': t('historySelect'),
            onchange: (e) => {
              if (e.currentTarget.checked) ticked.add(entry.commit);
              else ticked.delete(entry.commit);
              syncBulk();
            },
          }),
          h('button', { type: 'button', class: 'ld-ed-history-entry', title: t('historyJump'), onclick: () => jump(entry) },
            h('span', {}, entry.summary),
            h('span', { class: 'ld-ed-muted' },
              h('code', {}, shortHash(entry.commit)), ' · ', new Date(entry.date).toLocaleString(t.lang)))),
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

function formatBytes(bytes, lang) {
  const kb = bytes / 1024;
  const format = (n, unit) => `${n.toLocaleString(lang, { maximumFractionDigits: 1 })} ${unit}`;
  return kb >= 1024 ? format(kb / 1024, 'MB') : format(Math.max(kb, 0), 'KB');
}
