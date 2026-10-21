// distribution-bars: a discrete distribution as bars, from weights (normalized) or
// logits (softmax with optional temperature), with sliders, presets, a comparison
// distribution and entropy / cross-entropy / KL readouts.

import { svgEl, htmlEl, frame, legend, slider, color, fmt, fmtTick, niceStep, ticks, decimalsFor, fail, defineWidget } from './_svg.js';

const NAME = 'distribution-bars';

const STATS = ['entropy', 'cross_entropy', 'kl'];
const WIDTH = 480;
const HEIGHT = 250;

const numberList = { type: 'array', minItems: 2, maxItems: 12, items: { type: 'number' } };

const propsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['labels', 'values'],
  properties: {
    labels: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 24 } },
    values: numberList,
    mode: { enum: ['weights', 'logits'] },
    editable: { type: 'boolean' },
    temperature: {
      type: 'object',
      additionalProperties: false,
      required: ['min', 'max', 'value'],
      properties: {
        min: { type: 'number', minimum: 0.01 },
        max: { type: 'number', minimum: 0.01 },
        step: { type: 'number', minimum: 0.001 },
        value: { type: 'number', minimum: 0.01 },
      },
    },
    presets: { type: 'object', additionalProperties: numberList },
    compare: {
      type: 'object',
      additionalProperties: false,
      required: ['values'],
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 40 },
        values: numberList,
      },
    },
    stats: { type: 'array', maxItems: STATS.length, items: { type: 'string', enum: STATS } },
    base: { enum: [2, 'e'] },
  },
};

function normalize(props) {
  const n = props.labels.length;
  const mode = props.mode ?? 'weights';
  const checkList = (list, what) => {
    if (list.length !== n) fail(NAME, `${what} must have ${n} numbers (one per label)`);
    if (mode === 'weights' && list.some((v) => v < 0)) fail(NAME, `${what} must be non-negative weights`);
  };
  checkList(props.values, 'values');
  for (const [name, list] of Object.entries(props.presets ?? {})) checkList(list, `preset "${name}"`);
  if (props.compare) {
    if (props.compare.values.length !== n) fail(NAME, `compare.values must have ${n} numbers`);
    if (props.compare.values.some((v) => v < 0)) fail(NAME, 'compare.values must be non-negative weights');
  }
  const t = props.temperature;
  if (t) {
    if (mode !== 'logits') fail(NAME, 'temperature applies only to mode "logits"');
    if (!(t.min < t.max && t.value >= t.min && t.value <= t.max)) fail(NAME, 'temperature needs min < max and min ≤ value ≤ max');
  }
  const stats = props.stats ?? ['entropy'];
  if (!props.compare && stats.some((s) => s !== 'entropy')) fail(NAME, 'cross_entropy and kl need "compare"');
  return {
    labels: props.labels,
    values: [...props.values],
    mode,
    editable: props.editable ?? false,
    temperature: t ? { step: (t.max - t.min) / 100, ...t } : null,
    presets: props.presets ?? {},
    compare: props.compare ? { label: props.compare.label ?? 'q', q: toWeights(props.compare.values) } : null,
    stats,
    base: props.base ?? 2,
  };
}

function toWeights(values) {
  const sum = values.reduce((a, b) => a + b, 0);
  return sum > 0 ? values.map((v) => v / sum) : null;
}

function softmax(z, T) {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp((v - m) / T));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

// Sum of p·log(1/q) over the support of p; Infinity when q misses part of that support.
function crossEntropy(p, q, log) {
  let h = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === 0) continue;
    if (q[i] === 0) return Infinity;
    h -= p[i] * log(q[i]);
  }
  return h;
}

function sliderRange(cfg) {
  const all = [cfg.values, ...Object.values(cfg.presets)].flat();
  if (cfg.mode === 'logits') {
    const hi = Math.max(5, Math.ceil(Math.max(...all.map(Math.abs))));
    return { min: -hi, max: hi, step: 0.1 };
  }
  const hi = 10 ** Math.ceil(Math.log10(Math.max(1, ...all)));
  return { min: 0, max: hi, step: hi / 100 };
}

function build(el, props) {
  const cfg = normalize(props);
  const n = cfg.labels.length;
  const logits = cfg.mode === 'logits';
  const log = cfg.base === 2 ? Math.log2 : Math.log;
  const unit = cfg.base === 2 ? 'bits' : 'nats';
  let T = cfg.temperature?.value ?? 1;

  const hasControls = cfg.editable || cfg.temperature || Object.keys(cfg.presets).length > 0;
  const view = frame(el, { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, label: 'Probability distribution', controls: hasControls });
  if (cfg.compare) {
    el.prepend(legend(null, [
      { label: 'p', color: color(1), shape: 'bar' },
      { label: cfg.compare.label, color: color(2), shape: 'outline', dash: true },
    ]));
  }

  const plot = { left: 40, right: WIDTH - 8, top: 22, bottom: HEIGHT - (logits ? 42 : 24) };
  const slotW = (plot.right - plot.left) / n;
  const grid = svgEl('g', {}, view.svg);
  const bars = svgEl('g', {}, view.svg);

  const distribution = () => (logits ? softmax(cfg.values, T) : toWeights(cfg.values));

  function drawAxes(ymax) {
    grid.replaceChildren();
    const lines = svgEl('g', { class: 'ld-w-grid' }, grid);
    const labels = svgEl('g', { class: 'ld-w-tick' }, grid);
    const sy = (v) => plot.bottom - (v / ymax) * (plot.bottom - plot.top);
    for (const t of ticks(0, ymax, niceStep(ymax, 4))) {
      svgEl('line', { x1: plot.left, y1: sy(t), x2: plot.right, y2: sy(t) }, lines);
      svgEl('text', { x: plot.left - 6, y: sy(t) + 4, 'text-anchor': 'end' }, labels).textContent = fmtTick(t);
    }
    svgEl('line', { x1: plot.left, y1: plot.bottom, x2: plot.right, y2: plot.bottom }, svgEl('g', { class: 'ld-w-axis' }, grid));
    return sy;
  }

  function draw() {
    const p = distribution();
    const q = cfg.compare?.q;
    const peak = Math.max(...(p ?? [0]), ...(q ?? [0]));
    const ymax = [0.25, 0.5, 1].find((v) => peak * 1.08 <= v) ?? 1;
    const sy = drawAxes(ymax);
    bars.replaceChildren();
    const logitRow = logits ? svgEl('g', { class: 'ld-w-tick' }, bars) : null;
    cfg.labels.forEach((name, i) => {
      const cx = plot.left + slotW * (i + 0.5);
      const w = Math.min(48, slotW * 0.62);
      if (p) {
        svgEl('rect', {
          x: cx - w / 2, y: sy(p[i]), width: w, height: plot.bottom - sy(p[i]),
          fill: color(1), 'fill-opacity': 0.72, rx: 2,
        }, bars);
        svgEl('text', { x: cx, y: sy(p[i]) - 6, 'text-anchor': 'middle', class: 'ld-w-value' }, bars).textContent =
          p[i] >= 0.0005 || p[i] === 0 ? fmt(p[i], 3) : '<0.001';
      }
      if (q) {
        const qw = w + 8;
        svgEl('rect', {
          x: cx - qw / 2, y: sy(q[i]), width: qw, height: plot.bottom - sy(q[i]),
          fill: 'none', stroke: color(2), 'stroke-width': 1.8, 'stroke-dasharray': '5 3',
        }, bars);
      }
      svgEl('text', { x: cx, y: plot.bottom + 17, 'text-anchor': 'middle', class: 'ld-w-label' }, bars).textContent = name;
      if (logits) {
        svgEl('text', { x: cx, y: plot.bottom + 35, 'text-anchor': 'middle' }, logitRow).textContent =
          `z=${fmt(cfg.values[i], 1)}`;
      }
    });
    view.readout.textContent = readoutText(p, q);
  }

  function readoutText(p, q) {
    if (!p) return 'All weights are zero; raise at least one.';
    const lines = [];
    if (logits) lines.push(`p = softmax(z / T)   T = ${fmt(T, 2)}`);
    for (const stat of cfg.stats) {
      if (stat === 'entropy') lines.push(`H(p) = ${fmt(crossEntropy(p, p, log), 3)} ${unit}`);
      if (stat === 'cross_entropy') lines.push(`H(p, ${cfg.compare.label}) = ${q ? fmt(crossEntropy(p, q, log), 3) : '—'} ${unit}`);
      if (stat === 'kl') {
        const kl = q ? crossEntropy(p, q, log) - crossEntropy(p, p, log) : NaN;
        lines.push(`KL(p ‖ ${cfg.compare.label}) = ${fmt(kl, 3)} ${unit}`);
      }
    }
    return lines.join('\n');
  }

  if (hasControls) {
    const range = sliderRange(cfg);
    const valueSliders = [];
    const presetNames = Object.keys(cfg.presets);
    if (presetNames.length) {
      const row = htmlEl('div', { class: 'ld-w-buttons' }, view.controls);
      for (const name of presetNames) {
        htmlEl('button', { type: 'button', text: name }, row).addEventListener('click', () => {
          cfg.values = [...cfg.presets[name]];
          valueSliders.forEach((s, i) => s.set(cfg.values[i]));
          draw();
        });
      }
    }
    if (cfg.temperature) {
      const t = cfg.temperature;
      slider(view.controls, {
        label: 'T', min: t.min, max: t.max, step: t.step, value: T,
        onInput: (v) => { T = v; draw(); },
      });
    }
    if (cfg.editable) {
      const wrap = htmlEl('div', { class: 'ld-w-sliders' }, view.controls);
      cfg.labels.forEach((name, i) => {
        valueSliders.push(slider(wrap, {
          label: logits ? `z ${name}` : name,
          ...range,
          value: cfg.values[i],
          format: (v) => fmt(v, decimalsFor(range.step)),
          onInput: (v) => { cfg.values[i] = v; draw(); },
        }));
      });
    }
  }

  draw();
}

export default defineWidget(NAME, propsSchema, build);
