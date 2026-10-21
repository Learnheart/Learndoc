// Private helpers shared by the built-in widgets. No DOM access at import time:
// Node imports widget modules only to read their propsSchema.

const SVG_NS = 'http://www.w3.org/2000/svg';

// fill/stroke go through inline style: presentation attributes do not reliably accept var().
export function svgEl(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === 'fill' || key === 'stroke') node.style.setProperty(key, value);
    else node.setAttribute(key, value);
  }
  if (parent) parent.append(node);
  return node;
}

export function htmlEl(tag, attrs = {}, parent) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  if (parent) parent.append(node);
  return node;
}

export const color = (n) => `var(--c${n})`;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Fixed decimals with a real minus sign and no "-0.00".
export function fmt(x, digits = 2) {
  if (Number.isNaN(x)) return '—';
  if (!Number.isFinite(x)) return x > 0 ? '∞' : '−∞';
  const s = x.toFixed(digits);
  return Number(s) === 0 ? (0).toFixed(digits) : s.replace('-', '−');
}

// Compact tick label: up to 3 decimals, trailing zeros dropped.
export function fmtTick(x) {
  return fmt(Number(x.toFixed(3)), 3).replace(/\.?0+$/, '');
}

// A "nice" tick step (1, 2 or 5 × 10^k) giving roughly `target` ticks over `span`.
export function niceStep(span, target = 6) {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const factor = [[1.5, 1], [3.5, 2], [7.5, 5]].find(([limit]) => norm < limit)?.[1] ?? 10;
  return factor * mag;
}

// Decimals needed to show values on a grid of `step` (0.1 → 1, 0.25 → 2), at most 4.
export const decimalsFor = (step) => (step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step))));

export function ticks(min, max, step) {
  const out = [];
  for (let i = Math.ceil(min / step - 1e-9); i * step <= max + 1e-9; i++) out.push(i * step);
  return out;
}

// Linear map between world coordinates and SVG user units for a plot area.
export function makeScale({ xmin, xmax, ymin, ymax }, { left, top, width, height }) {
  const kx = width / (xmax - xmin);
  const ky = height / (ymax - ymin);
  return {
    sx: (x) => left + (x - xmin) * kx,
    sy: (y) => top + (ymax - y) * ky,
    ix: (px) => xmin + (px - left) / kx,
    iy: (py) => ymax - (py - top) / ky,
  };
}

function clientToSvg(svg, event) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

// Pointer dragging (mouse, pen, touch) on `target`, reported in SVG user units.
// Listeners live on `target` and die with it; pointer capture keeps the drag going
// when the pointer leaves the element.
export function dragOn(target, svg, onMove) {
  let active = null;
  target.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    active = e.pointerId;
    target.setPointerCapture(e.pointerId);
    e.preventDefault();
    onMove(clientToSvg(svg, e));
  });
  target.addEventListener('pointermove', (e) => {
    if (e.pointerId === active) onMove(clientToSvg(svg, e));
  });
  const end = (e) => {
    if (e.pointerId === active) active = null;
  };
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
}

// Arrow keys → onStep(dx, dy) in units of `step`; Shift multiplies by 10.
export function arrowKeys(target, step, onStep) {
  target.addEventListener('keydown', (e) => {
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!dir) return;
    e.preventDefault();
    const k = e.shiftKey ? step * 10 : step;
    onStep(dir[0] * k, dir[1] * k);
  });
}

// Polyline path data; non-finite points start a new subpath.
export function pathData(points) {
  let d = '';
  let pen = false;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
    pen = true;
  }
  return d;
}

// Labeled range input: <label><span>name</span><input><output></label>.
export function slider(parent, { label, min, max, step, value, format = (v) => fmt(v, 2), onInput }) {
  const wrap = htmlEl('label', { class: 'ld-w-slider' }, parent);
  htmlEl('span', { class: 'ld-w-slider-name', text: label }, wrap);
  const input = htmlEl('input', { type: 'range', min, max, step, value }, wrap);
  const out = htmlEl('output', { text: format(value) }, wrap);
  input.addEventListener('input', () => {
    out.textContent = format(+input.value);
    onInput(+input.value);
  });
  return {
    set(v) {
      input.value = v;
      out.textContent = format(+input.value);
    },
  };
}

// Standard widget content in `el`: SVG, then an optional controls row, then a readout block.
export function frame(el, { viewBox, label, controls = false }) {
  const svg = svgEl('svg', { viewBox, class: 'ld-w-svg', role: 'img', 'aria-label': label }, el);
  const controlsEl = controls ? htmlEl('div', { class: 'ld-w-controls' }, el) : null;
  const readout = htmlEl('pre', { class: 'ld-w-readout' }, el);
  return { svg, controls: controlsEl, readout };
}

// Legend row; `items` = [{ label, color, shape: 'line' | 'bar' | 'outline', dash? }].
export function legend(parent, items) {
  const row = htmlEl('div', { class: 'ld-w-legend' }, parent);
  for (const item of items) {
    const entry = htmlEl('span', { class: 'ld-w-legend-item' }, row);
    const swatch = htmlEl('span', { class: `ld-w-swatch is-${item.shape ?? 'line'}` }, entry);
    swatch.style.setProperty('--sw', item.color);
    if (item.dash) swatch.classList.add('is-dashed');
    entry.append(item.label);
  }
  return row;
}

export function fail(widgetName, message) {
  throw new Error(`${widgetName}: ${message}`);
}

// Built-in widget module: build(el, props) renders into el; update re-renders from scratch.
export function defineWidget(name, propsSchema, build) {
  return {
    name,
    propsSchema,
    mount(el, props) {
      build(el, props);
      return {
        update(next) {
          el.replaceChildren();
          build(el, next);
        },
        destroy() {
          el.replaceChildren();
        },
      };
    },
  };
}
