// function-plot: up to four curves y = f(x) with parameter sliders, an optional
// point that slides along one curve, and readouts of expressions in x and params.

import {
  svgEl, frame, legend, slider, color, clamp, fmt, fmtTick, niceStep, ticks, makeScale, pathData, dragOn, arrowKeys,
  decimalsFor, fail, defineWidget,
} from './_svg.js';
import { compile, NAME_RE, RESERVED_NAMES } from './_expr.js';

const NAME = 'function-plot';
const WIDTH = 480;
const HEIGHT = 300;
const PLOT = { left: 40, top: 12, width: WIDTH - 40 - 12, height: HEIGHT - 12 - 30 };
const SAMPLES = 480;

const expr = { type: 'string', minLength: 1, maxLength: 200 };

const propsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['xmin', 'xmax', 'ymin', 'ymax', 'curves'],
  properties: {
    xmin: { type: 'number' },
    xmax: { type: 'number' },
    ymin: { type: 'number' },
    ymax: { type: 'number' },
    curves: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['expr'],
        properties: {
          expr,
          label: { type: 'string', minLength: 1, maxLength: 40 },
          color: { type: 'integer', minimum: 1, maximum: 6 },
          dash: { type: 'boolean' },
        },
      },
    },
    params: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'min', 'max', 'value'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 16 },
          min: { type: 'number' },
          max: { type: 'number' },
          step: { type: 'number', minimum: 0 },
          value: { type: 'number' },
          label: { type: 'string', minLength: 1, maxLength: 40 },
        },
      },
    },
    point: {
      type: 'object',
      additionalProperties: false,
      required: ['curve', 'x'],
      properties: {
        curve: { type: 'integer', minimum: 0, maximum: 3 },
        x: { type: 'number' },
        draggable: { type: 'boolean' },
      },
    },
    readout: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'expr'],
        properties: { label: { type: 'string', minLength: 1, maxLength: 40 }, expr },
      },
    },
  },
};

function normalize(props) {
  const { xmin, xmax, ymin, ymax } = props;
  if (!(xmin < xmax && ymin < ymax)) fail(NAME, 'need xmin < xmax and ymin < ymax');
  const params = (props.params ?? []).map((p) => {
    if (!NAME_RE.test(p.name) || p.name === 'x' || RESERVED_NAMES.has(p.name)) fail(NAME, `invalid parameter name "${p.name}"`);
    if (!(p.min < p.max && p.value >= p.min && p.value <= p.max)) fail(NAME, `parameter "${p.name}" needs min < max and min ≤ value ≤ max`);
    return { ...p, step: p.step || (p.max - p.min) / 100 };
  });
  const paramNames = params.map((p) => p.name);
  const curves = props.curves.map((c, i) => ({
    f: compile(c.expr, ['x', ...paramNames]),
    label: c.label,
    color: c.color ?? (i % 6) + 1,
    dash: c.dash ?? false,
  }));
  const point = props.point ? { ...props.point, draggable: props.point.draggable ?? true } : null;
  if (point && point.curve >= curves.length) fail(NAME, `point.curve ${point.curve} does not exist`);
  const readout = (props.readout ?? []).map((r) => ({
    label: r.label,
    f: compile(r.expr, point ? ['x', ...paramNames] : paramNames),
  }));
  return { xmin, xmax, ymin, ymax, params, curves, point, readout };
}

function build(el, props) {
  const cfg = normalize(props);
  const scope = Object.fromEntries(cfg.params.map((p) => [p.name, p.value]));
  const view = frame(el, { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, label: 'Function plot', controls: cfg.params.length > 0 });
  const labeled = cfg.curves.filter((c) => c.label);
  if (labeled.length) el.prepend(legend(null, labeled.map((c) => ({ label: c.label, color: color(c.color), dash: c.dash }))));

  const { svg } = view;
  // Nested <svg> clips curves to the plot area without needing a clipPath id.
  const area = { left: 0, top: 0, width: PLOT.width, height: PLOT.height };
  const { sx, sy, ix } = makeScale(cfg, area);
  drawFrame(svg, cfg);
  const inner = svgEl('svg', { x: PLOT.left, y: PLOT.top, width: PLOT.width, height: PLOT.height, overflow: 'hidden' }, svg);
  const curvesLayer = svgEl('g', {}, inner);
  const pointLayer = svgEl('g', {}, inner);

  const span = cfg.ymax - cfg.ymin;
  const lo = cfg.ymin - span;
  const hi = cfg.ymax + span;

  function curvePoints(f) {
    const pts = [];
    let prev = null;
    for (let k = 0; k <= SAMPLES; k++) {
      const x = cfg.xmin + ((cfg.xmax - cfg.xmin) * k) / SAMPLES;
      const y = f({ ...scope, x });
      if (!Number.isFinite(y)) {
        pts.push([NaN, NaN]);
        prev = null;
        continue;
      }
      // Jumping from far above to far below (or back) is an asymptote, not a steep line.
      if (prev !== null && ((prev > hi && y < lo) || (prev < lo && y > hi))) pts.push([NaN, NaN]);
      pts.push([sx(x), sy(clamp(y, lo, hi))]);
      prev = y;
    }
    return pts;
  }

  let marker = null;
  if (cfg.point) {
    const c = cfg.curves[cfg.point.curve];
    const g = svgEl('g', {}, pointLayer);
    const guides = svgEl('path', { fill: 'none', stroke: 'var(--muted)', 'stroke-width': 1, 'stroke-dasharray': '4 4' }, g);
    const handle = svgEl('g', cfg.point.draggable
      ? { class: 'ld-w-handle', tabindex: 0, role: 'slider', 'aria-label': 'Point on curve: drag, or use arrow keys (Shift for larger steps)' }
      : {}, g);
    const hit = svgEl('circle', { r: 18, fill: 'transparent' }, handle);
    const dot = svgEl('circle', { r: 6, fill: color(c.color), stroke: 'var(--surface)', 'stroke-width': 2 }, handle);
    const text = svgEl('text', { class: 'ld-w-value' }, g);
    marker = { c, guides, handle, hit, dot, text };
    if (cfg.point.draggable) {
      const moveTo = (x) => {
        cfg.point.x = clamp(x, cfg.xmin, cfg.xmax);
        drawPoint();
        drawReadout();
      };
      dragOn(handle, svg, (p) => moveTo(ix(p.x - PLOT.left)));
      arrowKeys(handle, (cfg.xmax - cfg.xmin) / 100, (dx) => moveTo(cfg.point.x + dx));
    }
  }

  function drawPoint() {
    if (!marker) return;
    const { x } = cfg.point;
    const y = marker.c.f({ ...scope, x });
    // Out-of-view values pin the handle to the plot edge so it stays reachable.
    const visible = Number.isFinite(y) && y >= cfg.ymin && y <= cfg.ymax;
    const px = sx(x);
    const py = sy(clamp(Number.isFinite(y) ? y : 0, cfg.ymin, cfg.ymax));
    const axisY = sy(clamp(0, cfg.ymin, cfg.ymax));
    const axisX = sx(clamp(0, cfg.xmin, cfg.xmax));
    marker.guides.setAttribute('d', visible ? `M${px},${axisY}V${py}H${axisX}` : '');
    for (const circle of [marker.hit, marker.dot]) {
      circle.setAttribute('cx', px);
      circle.setAttribute('cy', py);
    }
    const right = px < PLOT.width - 110;
    marker.text.setAttribute('x', px + (right ? 10 : -10));
    marker.text.setAttribute('y', py < 24 ? py + 20 : py - 10);
    marker.text.setAttribute('text-anchor', right ? 'start' : 'end');
    marker.text.textContent = `(${fmt(x)}, ${fmt(y)})`;
    marker.handle.setAttribute('aria-valuetext', `x = ${fmt(x)}, y = ${fmt(y)}`);
  }

  function drawReadout() {
    const lines = [];
    const at = cfg.point ? { ...scope, x: cfg.point.x } : scope;
    if (cfg.point) lines.push(`x = ${fmt(cfg.point.x, 3)}   ${marker.c.label ?? 'y'} = ${fmt(marker.c.f(at), 3)}`);
    for (const r of cfg.readout) lines.push(`${r.label} = ${fmt(r.f(at), 3)}`);
    view.readout.textContent = lines.join('\n');
  }

  function draw() {
    curvesLayer.replaceChildren();
    for (const c of cfg.curves) {
      svgEl('path', {
        d: pathData(curvePoints(c.f)), fill: 'none', stroke: color(c.color), 'stroke-width': 2.5,
        'stroke-dasharray': c.dash ? '7 5' : null, 'stroke-linejoin': 'round',
      }, curvesLayer);
    }
    drawPoint();
    drawReadout();
  }

  for (const p of cfg.params) {
    const digits = decimalsFor(p.step);
    slider(view.controls, {
      label: p.label ?? p.name, min: p.min, max: p.max, step: p.step, value: p.value,
      format: (v) => fmt(v, digits),
      onInput: (v) => { scope[p.name] = v; draw(); },
    });
  }

  draw();
}

function drawFrame(svg, cfg) {
  const { sx, sy } = makeScale(cfg, PLOT);
  const grid = svgEl('g', { class: 'ld-w-grid' }, svg);
  const labels = svgEl('g', { class: 'ld-w-tick' }, svg);
  const bottom = PLOT.top + PLOT.height;
  for (const x of ticks(cfg.xmin, cfg.xmax, niceStep(cfg.xmax - cfg.xmin, 6))) {
    svgEl('line', { x1: sx(x), y1: PLOT.top, x2: sx(x), y2: bottom }, grid);
    svgEl('text', { x: sx(x), y: bottom + 20, 'text-anchor': 'middle' }, labels).textContent = fmtTick(x);
  }
  for (const y of ticks(cfg.ymin, cfg.ymax, niceStep(cfg.ymax - cfg.ymin, 6))) {
    svgEl('line', { x1: PLOT.left, y1: sy(y), x2: PLOT.left + PLOT.width, y2: sy(y) }, grid);
    svgEl('text', { x: PLOT.left - 6, y: sy(y) + 4, 'text-anchor': 'end' }, labels).textContent = fmtTick(y);
  }
  svgEl('rect', { x: PLOT.left, y: PLOT.top, width: PLOT.width, height: PLOT.height, fill: 'none' }, grid);
  const axes = svgEl('g', { class: 'ld-w-axis' }, svg);
  if (cfg.ymin <= 0 && cfg.ymax >= 0) svgEl('line', { x1: PLOT.left, y1: sy(0), x2: PLOT.left + PLOT.width, y2: sy(0) }, axes);
  if (cfg.xmin <= 0 && cfg.xmax >= 0) svgEl('line', { x1: sx(0), y1: PLOT.top, x2: sx(0), y2: bottom }, axes);
}

export default defineWidget(NAME, propsSchema, build);
