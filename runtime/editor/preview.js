// Changeset preview: body entries for the three view modes, and the summary bar.

import { diffField } from '/static/shared/diff.mjs';
import { FIELD_KINDS, mathSpan } from '/static/shared/render.mjs';
import { renderMath } from '../lesson.js';
import { h, ui } from './dom.js';
import { warningText } from './i18n.js';
import { plainSig } from './body.js';

const OPS = ['replace', 'insert', 'delete', 'move'];

const changeCounts = (view) => OPS.map((op) => [op, view.counts?.[op] ?? 0]).filter(([, n]) => n > 0);

function groupsOf(view) {
  const groups = new Map();
  for (const c of view.changes) if (c.group) groups.set(c.group, (groups.get(c.group) ?? 0) + 1);
  return groups;
}

// Group ids are round-scoped ("r2:g-notation"); show the bare name, adding the round only
// when two rounds use the same name. The full id is still what excludeGroups receives.
function groupLabels(view, t) {
  const ids = [...groupsOf(view).keys()];
  const bare = (id) => id.replace(/^r\d+:/, '');
  return new Map(ids.map((id) => {
    const name = bare(id);
    const shared = ids.filter((other) => bare(other) === name).length > 1;
    const round = id.match(/^r(\d+):/)?.[1];
    return [id, shared && round ? `${name} (${t('round', round)})` : name];
  }));
}

// Ordered list of { block, changes, deleted } for a view mode.
function sequence(base, view, mode) {
  const byId = new Map();
  const deleted = [];
  for (const c of view.changes) {
    if (c.op === 'delete') deleted.push(c);
    else byId.set(c.blockId, [...(byId.get(c.blockId) ?? []), c]);
  }
  const baseIndex = new Map(base.blocks.map((b, i) => [b.id, i]));
  if (mode === 'old') {
    const deletedIds = new Set(deleted.map((c) => c.blockId));
    return base.blocks.map((block) => ({
      block,
      changes: deletedIds.has(block.id) ? deleted.filter((c) => c.blockId === block.id) : (byId.get(block.id) ?? []),
      deleted: deletedIds.has(block.id),
    }));
  }
  const seq = view.preview.blocks.map((block) => ({ block, changes: byId.get(block.id) ?? [], deleted: false }));
  const live = new Set(seq.map((e) => e.block.id));
  // A deleted block is shown right after its nearest surviving predecessor from the original.
  deleted.sort((a, b) => (baseIndex.get(a.blockId) ?? 0) - (baseIndex.get(b.blockId) ?? 0));
  for (const c of deleted) {
    let pos = 0;
    for (let i = (baseIndex.get(c.blockId) ?? 0) - 1; i >= 0; i--) {
      const anchor = base.blocks[i].id;
      if (live.has(anchor)) {
        pos = seq.findIndex((e) => e.block.id === anchor) + 1;
        break;
      }
    }
    while (seq[pos]?.deleted) pos++;
    seq.splice(pos, 0, { block: c.before, changes: [c], deleted: true });
  }
  return seq;
}

function diffFields(section, before, after) {
  for (const [name, kind] of Object.entries(FIELD_KINDS[after.type] ?? {})) {
    const field = section.querySelector(`[data-field="${name}"]`);
    if (!field || (before[name] ?? '') === (after[name] ?? '')) continue;
    if (name === 'latex') {
      // A formula diff is the old and the new formula side by side, both rendered.
      field.innerHTML = `<del class="ld-del">${mathSpan(before.latex, true, 0)}</del><ins class="ld-ins">${mathSpan(after.latex, true, 1)}</ins>`;
    } else {
      field.innerHTML = diffField(before[name] ?? '', after[name] ?? '', kind);
    }
    renderMath(field);
  }
}

// Inline chrome above a block: tags, related-change reasons and server warnings.
function changeBox(tags, reasons, warnings, t) {
  return h('div', { class: 'ld-ed-change', 'data-chrome': true },
    tags.length > 0 && h('div', { class: 'ld-ed-tags' }, tags),
    reasons.map((r) => h('div', { class: 'ld-ed-reason' }, r)),
    warnings.map((w) => h('div', { class: 'ld-ed-warning', role: 'note' }, `⚠ ${warningText(w, t)}`)));
}

function decorator(item, mode, excluded, warnings, labels, t, showRole) {
  const { changes, deleted } = item;
  const role = changes.some((c) => c.role === 'primary') ? 'primary' : 'related';
  const ops = new Set(changes.map((c) => c.op));
  const groups = [...new Set(changes.map((c) => c.group).filter(Boolean))];
  const reasons = role === 'related' ? [...new Set(changes.map((c) => c.reason).filter(Boolean))] : [];
  const replaced = changes.find((c) => c.op === 'replace');
  const typeChanged = replaced && replaced.before && replaced.before.type !== replaced.after?.type;
  const isExcluded = groups.some((g) => excluded.has(g));

  return (section) => {
    section.classList.add(role === 'primary' ? 'is-primary' : 'is-related', 'is-change');
    if (deleted) section.classList.add('is-deleted');
    if (ops.has('insert') && mode !== 'old') section.classList.add('is-inserted');
    if (isExcluded) section.classList.add('is-excluded');
    if (mode === 'diff' && replaced?.before && !typeChanged) diffFields(section, replaced.before, item.block);
    const tags = [
      showRole && h('span', { class: `ld-ed-tag is-${role}` }, t(role === 'primary' ? 'rolePrimary' : 'roleRelated')),
      [...ops].map((op) => h('span', { class: 'ld-ed-tag' }, t(`op_${op}`))),
      groups.map((g) => h('span', { class: 'ld-ed-tag' }, t('group', labels.get(g) ?? g))),
      typeChanged && h('span', { class: 'ld-ed-tag' }, t('typeChanged')),
      replaced && item.block.type === 'widget' && !typeChanged && h('span', { class: 'ld-ed-tag' }, t('widgetChanged')),
    ];
    section.prepend(changeBox(tags, reasons, warnings, t));
  };
}

// Body entries for body.sync(). mode: 'old' | 'new' | 'diff'.
// Warnings that name a block (outside_focus, selection_unresolved…) are marked on that block too.
// showRole: false for a saved commit, whose changes carry no selection/related role.
export function previewEntries(base, view, mode, excluded, t, { showRole = true } = {}) {
  const labels = groupLabels(view, t);
  const warningsByBlock = Map.groupBy((view.warnings ?? []).filter((w) => w.blockId), (w) => w.blockId);
  return sequence(base, view, mode).map((item) => {
    const warnings = warningsByBlock.get(item.block.id) ?? [];
    if (!item.changes.length && !warnings.length) return { block: item.block, sig: plainSig(item.block) };
    const groupsExcluded = item.changes.map((c) => c.group).filter((g) => g && excluded.has(g));
    return {
      block: item.block,
      sig: JSON.stringify([mode, view.round, item.deleted, groupsExcluded, item.block, item.changes, warnings]),
      decorate: item.changes.length
        ? decorator(item, mode, excluded, warnings, labels, t, showRole)
        : (section) => section.prepend(changeBox([], [], warnings, t)),
    };
  });
}

const countsText = (view, t) => changeCounts(view).map(([op, n]) => t(`count_${op}`, n)).join(' · ');

// "← Previous 1/3 Next →" and the Before/After/Diff switch shared by both bars.
function viewControls(state, handlers, t) {
  const modeButton = (mode, label) => h('button', {
    type: 'button', class: 'ld-ed-seg', 'aria-pressed': String(state.mode === mode), onclick: () => handlers.onMode(mode),
  }, label);
  return [
    h('div', { class: 'ld-ed-nav' },
      h('button', { type: 'button', class: 'ld-ed-btn', onclick: () => handlers.onNav(-1), disabled: !state.total }, `← ${t('prev')}`),
      h('span', { class: 'ld-ed-muted', 'aria-live': 'polite' }, `${state.position}/${state.total}`),
      h('button', { type: 'button', class: 'ld-ed-btn', onclick: () => handlers.onNav(1), disabled: !state.total }, `${t('next')} →`)),
    h('div', { class: 'ld-ed-segs', role: 'group', 'aria-label': t('viewModes') },
      modeButton('old', t('viewOld')), modeButton('new', t('viewNew')), modeButton('diff', t('viewDiff'))),
  ];
}

// Summary bar for a ready changeset. state = { mode, excluded, position, total }.
export function summaryBar(view, state, handlers, t) {
  const counts = countsText(view, t);
  const usage = view.usage
    ? [view.usage.costUsd != null && `$${Number(view.usage.costUsd).toFixed(3)}`,
      view.usage.durationMs != null && t('seconds', Math.round(view.usage.durationMs / 1000))].filter(Boolean).join(' · ')
    : '';
  const groups = [...groupsOf(view)];
  const labels = groupLabels(view, t);
  const warnings = view.warnings ?? [];

  return ui('div', { class: 'ld-ed-summary', role: 'region', 'aria-label': t('previewTitle') },
    h('div', { class: 'ld-ed-summary-text' },
      h('strong', {}, view.summary ?? ''),
      h('span', { class: 'ld-ed-muted' }, [counts, view.round > 1 && t('round', view.round), usage].filter(Boolean).join(' · '))),
    h('div', { class: 'ld-ed-summary-controls' },
      viewControls(state, handlers, t),
      groups.length > 0 && h('fieldset', { class: 'ld-ed-groups' },
        h('legend', {}, t('groups')),
        groups.map(([group, n]) => h('label', {},
          h('input', {
            type: 'checkbox', checked: !state.excluded.has(group),
            onchange: (e) => handlers.onGroup(group, e.target.checked),
          }),
          ` ${labels.get(group)} (${n})`))),
      warnings.length > 0 && h('details', { class: 'ld-ed-warnings' },
        h('summary', {}, `⚠ ${t('warnings', warnings.length)}`),
        h('ul', {}, warnings.map((w) => h('li', {},
          warningText(w, t), ' ',
          w.blockId && h('button', { type: 'button', class: 'ld-ed-link', onclick: () => handlers.onWarning(w.blockId) }, t('show')))))),
      h('div', { class: 'ld-ed-actions' },
        h('button', { type: 'button', class: 'ld-ed-btn', onclick: handlers.onRefine }, t('refine')),
        h('button', { type: 'button', class: 'ld-ed-btn', onclick: handlers.onCancel }, t('cancel')),
        h('button', { type: 'button', class: 'ld-ed-btn is-primary', onclick: handlers.onAccept }, t('accept')))));
}

// Bar for a saved change (history commit) shown in the page. state = { mode, position, total }.
export function commitBar(view, state, handlers, t) {
  const meta = [`commit ${view.commit.slice(0, 7)}`, new Date(view.date).toLocaleString(t.lang), countsText(view, t)];
  return ui('div', { class: 'ld-ed-summary', role: 'region', 'aria-label': t('commitTitle') },
    h('div', { class: 'ld-ed-summary-text' },
      h('strong', {}, `${t('commitTitle')}: ${view.summary.replace(/^learndoc:\s*/, '')}`),
      h('span', { class: 'ld-ed-muted' }, meta.filter(Boolean).join(' · '))),
    h('div', { class: 'ld-ed-summary-controls' },
      viewControls(state, handlers, t),
      h('div', { class: 'ld-ed-actions' },
        view.restorable && h('button', { type: 'button', class: 'ld-ed-btn', onclick: handlers.onRestore }, t('restoreBefore')),
        h('button', { type: 'button', class: 'ld-ed-btn is-primary', onclick: handlers.onClose }, t('closeDiff')))));
}
