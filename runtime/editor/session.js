// Changeset lifecycle: submit → poll → preview (accept / cancel / refine) |
// needs_confirmation | failed | answered (Ask note).

import { h, ui, toast, openDialog, shortHash } from './dom.js';
import { warningText, errorText } from './i18n.js';
import { sectionParts } from './selection.js';
import { runningStatus, appendParts } from './ui.js';
import { previewEntries, summaryBar, commitBar } from './preview.js';
import { startManualEdit } from './manual.js';

const POLL_MS = 700;
const MAX_POLL_FAILURES = 5;

const changesetPath = (id, action) => `/api/changesets/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;

// deps: { api, t, lessonId, lesson, main, body, bar, notes, selection, toolbar, prompt, openPrompt }
export function createSession(deps) {
  const { api, t, lessonId, main, body, bar, notes, selection, toolbar, prompt, openPrompt } = deps;
  const lessonPath = `/api/lessons/${encodeURIComponent(lessonId)}`;
  let lesson = deps.lesson;

  // active: the changeset round being worked on, null when idle.
  //   { id, mode, instruction, focus, phase: 'running'|'ready'|'confirm'|'failed', startedAt, failures, timer, retry }
  // preview: { view, mode: 'old'|'new'|'diff', excluded: Set<group>, position } while a changeset is shown.
  // saved: { view, mode, position, onRestore } while a history commit is shown (read-only).
  // manual: { block, editor, saving } while the user types into a block directly.
  let active = null;
  let preview = null;
  let saved = null;
  let manual = null;
  let running = null;

  // Listeners get { type: 'running'|'ready'|'confirm'|'failed'|'accepted'|'cancelled'|'history'|'manual'|'idle', mode, ... }.
  const listeners = new Set();
  const emit = (event) => listeners.forEach((fn) => fn(event));

  // ---------- submitting ----------

  function edit(mode, instruction, sel, model) {
    const request = { lessonId, mode, instruction, selection: sel.payload, model };
    start(() => api.post('/api/edit', request), { mode, instruction, focus: sel.payload });
  }

  function refine(instruction, sel, model) {
    const { id, mode, focus } = active;
    const request = { instruction, model, ...(sel && { selection: sel.payload }) };
    start(() => api.post(changesetPath(id, 'refine'), request), { id, mode, instruction, focus: sel?.payload ?? focus });
  }

  async function start(call, info) {
    const job = { ...info, phase: 'running', startedAt: Date.now(), failures: 0, retry: () => start(call, info) };
    active = job;
    showRunning();
    try {
      const { changesetId } = await call();
      if (active !== job) {
        // Cancelled while the request was in flight.
        api.del(changesetPath(changesetId)).catch(() => {});
        return;
      }
      job.id = changesetId;
      poll(job);
    } catch (err) {
      if (active !== job) return;
      if (err.code === 'changeset_open') {
        finish();
        toast(t('busy'), { error: true });
        api.get(lessonPath).then(resume, () => {});
        return;
      }
      fail(job, errorText(err, t));
    }
  }

  function showRunning() {
    running = runningStatus({ t, startedAt: active.startedAt, onCancel: cancel });
    bar.set(running.node);
    emit({ type: 'running', mode: active.mode });
  }

  // ---------- polling ----------

  const schedulePoll = (job) => {
    job.timer = setTimeout(() => poll(job), POLL_MS);
  };

  async function poll(job) {
    if (active !== job) return;
    let view;
    try {
      view = await api.get(changesetPath(job.id));
      job.failures = 0;
    } catch (err) {
      if (active !== job) return;
      if (++job.failures >= MAX_POLL_FAILURES) fail(job, errorText(err, t));
      else schedulePoll(job);
      return;
    }
    if (active !== job) return;
    job.mode = view.mode;
    switch (view.status) {
      case 'running':
        running?.update(view.progress);
        schedulePoll(job);
        break;
      case 'ready':
        showPreview(job, view);
        break;
      case 'answered':
        showAnswer(job, view);
        break;
      case 'needs_confirmation':
        askConfirmation(job, view);
        break;
      case 'failed':
        fail(job, view.errorCode && t.known(`err:${view.errorCode}`) ? t(`err:${view.errorCode}`) : view.error, view);
        break;
      default: // accepted or cancelled elsewhere
        finish();
        await showLesson();
    }
  }

  function finish(event = { type: 'idle' }) {
    const mode = active?.mode;
    clearTimeout(active?.timer);
    active = null;
    preview = null;
    running = null;
    bar.set(null);
    toolbar.hide();
    prompt.close();
    emit({ mode, ...event });
  }

  async function showLesson() {
    selection.clear();
    await body.showLesson(lesson);
    notes.place();
  }

  async function cancel() {
    const job = active;
    if (!job) return;
    finish({ type: 'cancelled' });
    const deleted = job.id ? api.del(changesetPath(job.id)).catch(() => {}) : null;
    await showLesson();
    toast(t('cancelled'));
    await deleted;
  }

  // Picks up the lesson's open changeset from a GET /api/lessons/:id response.
  function resume(state) {
    const open = state.openChangeset;
    if (!open || active) return;
    lesson = state.lesson;
    active = { id: open.id, mode: open.mode, focus: null, phase: 'running', startedAt: Date.now(), failures: 0, retry: null };
    showRunning();
    poll(active);
    toast(t('resumed'));
  }

  // ---------- preview ----------

  async function showPreview(job, view) {
    job.phase = 'ready';
    preview = { view, mode: preview?.mode ?? 'new', excluded: new Set(), position: 0 };
    await renderPreview();
    navigate(1);
    emit({ type: 'ready', mode: job.mode, summary: view.summary ?? '', counts: view.counts });
  }

  const changeTargets = () => [...main.querySelectorAll(':scope > section.is-change')];

  async function syncPreviewBody() {
    // A whole-lesson change has no selection, so its blocks carry no "in selection"/"related" tag.
    await body.sync(previewEntries(lesson, preview.view, preview.mode, preview.excluded, t, { showRole: preview.view.mode !== 'lesson' }));
    notes.place();
  }

  async function renderPreview() {
    selection.clear();
    await syncPreviewBody();
    preview.position = Math.min(preview.position, changeTargets().length);
    renderSummary();
  }

  function renderSummary() {
    bar.set(summaryBar(preview.view, { ...preview, total: changeTargets().length }, {
      onNav: navigate,
      async onMode(mode) {
        preview.mode = mode;
        await renderPreview();
        document.querySelector('.ld-ed-seg[aria-pressed="true"]')?.focus();
      },
      onGroup(group, included) {
        if (included) preview.excluded.delete(group);
        else preview.excluded.add(group);
        syncPreviewBody();
      },
      onWarning: (blockId) => body.section(blockId)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
      onRefine: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openPrompt('refine', { x: r.left + scrollX - 200, y: r.bottom + scrollY });
      },
      onCancel: cancel,
      onAccept: accept,
    }, t));
  }

  function flash(target) {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('is-flash');
    setTimeout(() => target.classList.remove('is-flash'), 1200);
  }

  function navigate(dir) {
    const state = preview ?? saved;
    const targets = changeTargets();
    if (!state || !targets.length) return;
    const n = targets.length;
    if (state.position === 0) state.position = dir > 0 ? 1 : n;
    else state.position = ((state.position - 1 + dir + n) % n) + 1;
    flash(targets[state.position - 1]);
    const counter = document.querySelector('.ld-ed-nav [aria-live]');
    if (counter) counter.textContent = `${state.position}/${n}`;
  }

  async function accept() {
    const job = active;
    const buttons = [...document.querySelectorAll('.ld-ed-summary button')];
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const res = await api.post(changesetPath(job.id, 'accept'), { excludeGroups: [...preview.excluded] });
      lesson = res.lesson;
      finish({ type: 'accepted', commit: res.commit });
      await showLesson();
      toast(t('accepted', shortHash(res.commit)));
    } catch (err) {
      buttons.forEach((b) => { b.disabled = false; });
      toast(t('error', errorText(err, t)), { error: true });
    }
  }

  // ---------- other outcomes ----------

  function askConfirmation(job, view) {
    job.phase = 'confirm';
    bar.set(null);
    emit({ type: 'confirm', mode: job.mode });
    const { scope = [], reason = '' } = view.needsConfirmation ?? {};
    const marked = scope.map((id) => body.section(id)).filter(Boolean);
    marked.forEach((s) => s.classList.add('is-related'));
    const unmark = () => marked.forEach((s) => s.classList.remove('is-related'));
    openDialog({
      title: t('confirmTitle'),
      body: h('div', {},
        h('p', {}, reason),
        h('p', {}, t('confirmScope', scope.length)),
        h('ul', { class: 'ld-ed-scope' }, scope.map((id) => {
          const item = h('li', {}, h('code', {}, id), ' ');
          const section = body.section(id);
          if (section) appendParts(item, sectionParts(section), 80);
          return item;
        }))),
      actions: [
        { label: t('cancel'), onClick: () => { unmark(); cancel(); } },
        { label: t('agree'), primary: true, onClick: () => { unmark(); confirm(job); } },
      ],
      onDismiss: () => { unmark(); cancel(); },
    });
  }

  async function confirm(job) {
    job.phase = 'running';
    showRunning();
    try {
      await api.post(changesetPath(job.id, 'confirm'));
      poll(job);
    } catch (err) {
      fail(job, errorText(err, t));
    }
  }

  // After a failed refine the changeset is usually still showable; if it moved on
  // (e.g. a retry is running), follow it by polling instead.
  async function backToPreview(job) {
    try {
      const view = await api.get(changesetPath(job.id));
      if (view.status === 'ready' || view.status === 'failed') {
        await showPreview(job, view);
      } else {
        job.phase = 'running';
        showRunning();
        poll(job);
      }
    } catch (err) {
      toast(t('error', errorText(err, t)), { error: true });
    }
  }

  function fail(job, message, view) {
    job.phase = 'failed';
    clearTimeout(job.timer);
    bar.set(null);
    emit({ type: 'failed', mode: job.mode, message: message || '' });
    // A failure in round > 1 is a failed refine; the earlier rounds stay open and usable.
    const keepsPreview = view ? view.round > 1 : preview !== null;
    const close = async () => {
      if (active !== job) return;
      finish();
      await showLesson();
    };
    const retry = job.retry && { label: t('retry'), primary: true, onClick: () => job.retry() };
    const details = [...(view?.warnings ?? []), ...(view?.diagnostics ?? [])];
    openDialog({
      title: t('failedTitle'),
      body: h('div', {},
        h('p', { class: 'ld-ed-error' }, message || ''),
        details.length > 0 && h('ul', { class: 'ld-ed-scope' },
          details.map((d) => h('li', {}, warningText(d, t))))),
      actions: keepsPreview
        ? [
          { label: t('discardChanges'), onClick: cancel },
          { label: t('backToPreview'), primary: !retry, onClick: () => backToPreview(job) },
          retry,
        ].filter(Boolean)
        : [{ label: t('close'), onClick: close }, retry].filter(Boolean),
      onDismiss: keepsPreview ? () => backToPreview(job) : close,
    });
  }

  async function showAnswer(job, view) {
    finish();
    const note = {
      blockId: job.focus?.focusBlockIds?.[0] ?? view.focus?.focusBlockIds?.[0],
      question: job.instruction ?? '',
      answer: view.answer?.answer ?? '',
      sources: view.answer?.sources ?? [],
      createdAt: new Date().toISOString(),
    };
    await notes.load().catch(() => {});
    notes.reveal(note);
  }

  // ---------- history ----------

  // Shows a saved commit's changes in the page, like a preview but read-only.
  async function showCommit(view, { onRestore }) {
    if (active || manual) {
      toast(t('busy'), { error: true });
      return;
    }
    saved = { view, mode: saved?.mode ?? 'diff', position: 0, onRestore };
    selection.clear();
    toolbar.hide();
    await renderCommit();
    navigate(1);
    emit({ type: 'history' });
  }

  async function renderCommit() {
    await body.sync(previewEntries(saved.view.before, saved.view, saved.mode, new Set(), t, { showRole: false }));
    notes.place();
    saved.position = Math.min(saved.position, changeTargets().length);
    bar.set(commitBar(saved.view, { ...saved, total: changeTargets().length }, {
      onNav: navigate,
      async onMode(mode) {
        saved.mode = mode;
        await renderCommit();
        document.querySelector('.ld-ed-seg[aria-pressed="true"]')?.focus();
      },
      onRestore: () => saved.onRestore(),
      onClose: closeCommit,
    }, t));
  }

  async function closeCommit() {
    if (!saved) return;
    saved = null;
    bar.set(null);
    await showLesson();
    emit({ type: 'idle' });
  }

  // Scrolls to the blocks a saved commit changed, as they are in the lesson now.
  // -> number of those blocks still in the lesson
  async function jumpTo(blockIds) {
    if (saved) await closeCommit();
    const sections = blockIds.map((id) => body.section(id)).filter(Boolean);
    if (sections[0]) flash(sections[0]);
    sections.slice(1).forEach((s) => {
      s.classList.add('is-flash');
      setTimeout(() => s.classList.remove('is-flash'), 1200);
    });
    return sections.length;
  }

  async function revert(commit) {
    if (active || manual) {
      toast(t('busy'), { error: true });
      return;
    }
    if (saved) await closeCommit();
    try {
      const res = await api.post(`${lessonPath}/revert`, { commit });
      if (res.commit === null) {
        toast(t('nothingToRestore'));
        return;
      }
      lesson = res.lesson;
      await showLesson();
      toast(t('reverted', shortHash(res.commit)));
    } catch (err) {
      toast(t('error', errorText(err, t)), { error: true });
    }
  }

  // ---------- manual edit ----------

  // Makes one block's text fields editable in place; saving writes and commits them directly.
  function startManual(blockId) {
    const block = lesson.blocks.find((b) => b.id === blockId);
    const section = body.section(blockId);
    if (active || saved || manual || !block || !section) {
      toast(t('busy'), { error: true });
      return;
    }
    // Keep the caret where the selection ended.
    const sel = getSelection();
    if (sel.rangeCount) sel.collapseToEnd();
    selection.clear();
    toolbar.hide();
    prompt.close();
    manual = { block, saving: false };
    manual.editor = startManualEdit(section, block, { onSave: saveManual, onCancel: cancelManual });
    bar.set(ui('div', { class: 'ld-ed-summary ld-ed-manual', role: 'region', 'aria-label': t('manual') },
      h('div', { class: 'ld-ed-summary-text' },
        h('strong', {}, t('manualEditing')),
        h('span', { class: 'ld-ed-muted' }, t('manualHint'))),
      h('div', { class: 'ld-ed-actions' },
        h('button', { type: 'button', class: 'ld-ed-btn', onclick: cancelManual }, t('cancel')),
        h('button', { type: 'button', class: 'ld-ed-btn is-primary', onclick: saveManual }, t('save')))));
    manual.editor.focus();
    emit({ type: 'manual' });
  }

  async function endManual() {
    manual.editor.stop();
    body.invalidate(manual.block.id);
    manual = null;
    bar.set(null);
    await showLesson();
    emit({ type: 'idle' });
  }

  async function saveManual() {
    if (!manual || manual.saving) return;
    const fields = manual.editor.fields();
    if (!Object.keys(fields).length) {
      await endManual();
      toast(t('nothingChanged'));
      return;
    }
    manual.saving = true;
    const buttons = [...document.querySelectorAll('.ld-ed-manual button')];
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const res = await api.post(`${lessonPath}/blocks/${encodeURIComponent(manual.block.id)}`, { before: manual.block, fields });
      lesson = res.lesson;
      await endManual();
      toast(res.commit ? t('accepted', shortHash(res.commit)) : t('nothingChanged'));
    } catch (err) {
      // The typed text stays on the page so it can be fixed, or dropped with Cancel.
      manual.saving = false;
      buttons.forEach((b) => { b.disabled = false; });
      toast(t('error', errorText(err, t)), { error: true });
    }
  }

  async function cancelManual() {
    if (!manual || manual.saving) return;
    await endManual();
  }

  return {
    // 'idle' | 'running' | 'ready' | 'confirm' | 'failed' | 'history' | 'manual'
    get phase() {
      return active?.phase ?? (manual ? 'manual' : saved ? 'history' : 'idle');
    },
    // The lesson as last saved (what the page shows outside a preview).
    get lesson() {
      return lesson;
    },
    get previewMode() {
      return preview?.mode ?? null;
    },
    // Mode of the changeset being worked on ('replace', 'insert', 'ask', 'lesson'), null when idle.
    get mode() {
      return active?.mode ?? null;
    },
    subscribe(fn) {
      listeners.add(fn);
    },
    edit,
    refine,
    resume,
    revert,
    showCommit,
    closeCommit,
    startManual,
    jumpTo,
  };
}
