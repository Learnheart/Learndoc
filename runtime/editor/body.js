// Keeps the lesson body (the block <section>s of main.ld-lesson) in sync with a list
// of entries, re-rendering only sections whose content or decoration changed.
//
// entry = { block, sig, decorate?(section) }
//   sig       identifies what the section should look like; equal sig → reuse the node
//   decorate  adds preview classes / chrome after rendering

import { replaceBlock, destroyWidgets } from '../lesson.js';
import { h } from './dom.js';

export const plainSig = (block) => `plain|${JSON.stringify(block)}`;

export const findSection = (main, id) => main.querySelector(`:scope > section[data-block-id="${CSS.escape(id ?? '')}"]`);

export function createBody({ main, ctx, lesson, t }) {
  const sigs = new WeakMap();
  const sections = () => [...main.querySelectorAll(':scope > section.ld-block[data-block-id]')];

  function addHandle(section) {
    if (section.querySelector(':scope > .ld-handle')) return;
    section.prepend(h('button', {
      type: 'button', class: 'ld-handle', 'data-chrome': true,
      'aria-label': t('selectBlock'), title: t('selectBlock'),
    }));
  }

  // The server-rendered DOM matches the lesson the page was loaded with.
  const initial = new Map(lesson.blocks.map((b) => [b.id, b]));
  for (const section of sections()) {
    const block = initial.get(section.dataset.blockId);
    if (block) sigs.set(section, plainSig(block));
    addHandle(section);
  }

  async function sync(entries) {
    const existing = new Map(sections().map((s) => [s.dataset.blockId, s]));
    const pending = [];
    let prev = main.querySelector(':scope > .ld-lesson-header');
    for (const entry of entries) {
      let el = existing.get(entry.block.id);
      existing.delete(entry.block.id);
      if (!el || sigs.get(el) !== entry.sig) {
        const target = el ?? document.createElement('section');
        pending.push({ target, entry });
        el = target;
      }
      if (prev) prev.after(el);
      else main.prepend(el);
      prev = el;
    }
    for (const leftover of existing.values()) {
      destroyWidgets(leftover);
      leftover.remove();
    }
    await Promise.all(pending.map(async ({ target, entry }) => {
      const section = await replaceBlock(target, entry.block, ctx);
      entry.decorate?.(section);
      addHandle(section);
      sigs.set(section, entry.sig);
    }));
  }

  return {
    sync,
    showLesson: (next) => sync(next.blocks.map((block) => ({ block, sig: plainSig(block) }))),
    section: (id) => findSection(main, id),
  };
}
