// Small DOM helpers shared by the editor modules.

// h('button', { class: 'x', onclick: fn, 'aria-label': '…' }, child, …)
// Children may be nodes, strings, arrays, or null/false (skipped).
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

// Editor-owned elements carry data-ld-ui so selection gestures ignore them.
export const ui = (tag, props, ...children) => h(tag, { 'data-ld-ui': true, ...props }, ...children);

export const isUi = (node) => !!(node instanceof Element ? node : node?.parentElement)?.closest('[data-ld-ui]');

let toastTimer = null;
export function toast(message, { error = false } = {}) {
  let el = document.querySelector('.ld-ed-toast');
  if (!el) {
    el = ui('div', { class: 'ld-ed-toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle('is-error', error);
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), error ? 7000 : 4000);
}

// Modal <dialog>. actions: [{ label, primary?, onClick }]; any action closes it first.
export function openDialog({ title, body, actions, onDismiss }) {
  const dialog = ui('dialog', { class: 'ld-ed-dialog', 'aria-label': title });
  let settled = false;
  const close = () => {
    settled = true;
    dialog.close();
    dialog.remove();
  };
  dialog.append(
    h('h2', { class: 'ld-ed-dialog-title' }, title),
    body,
    h('div', { class: 'ld-ed-dialog-actions' },
      actions.map((a) => h('button', {
        type: 'button',
        class: a.primary ? 'ld-ed-btn is-primary' : 'ld-ed-btn',
        onclick: () => { close(); a.onClick(); },
      }, a.label))),
  );
  // Esc closes the dialog natively; treat it like the dismissing action.
  dialog.addEventListener('close', () => {
    if (!settled) {
      dialog.remove();
      onDismiss?.();
    }
  });
  document.body.append(dialog);
  dialog.showModal();
}

export const shortHash = (commit) => String(commit ?? '').slice(0, 7);
