// vector-plane: draggable 2-D vectors on a grid, with optional angle, projection
// and sum constructions between vectors[0] and vectors[1].

import {
  svgEl, frame, color, clamp, fmt, fmtTick, niceStep, ticks, makeScale, pathData, dragOn, arrowKeys, fail, defineWidget,
} from './_svg.js';

const NAME = 'vector-plane';

const READOUTS = ['coords', 'norm', 'dot', 'cos', 'angle', 'projection'];
const WIDTH = 480;
const PAD = 24;
const KEY_STEP = 0.1;

const propsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['vectors'],
  properties: {
    xmin: { type: 'number' },
    xmax: { type: 'number' },
    ymin: { type: 'number' },
    ymax: { type: 'number' },
    grid: { type: 'number', minimum: 0 },
    vectors: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'x', 'y'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 24 },
          x: { type: 'number' },
          y: { type: 'number' },
          label: { type: 'string', minLength: 1, maxLength: 24 },
          color: { type: 'integer', minimum: 1, maximum: 6 },
          draggable: { type: 'boolean' },
        },
      },
    },
    show: {
      type: 'object',
      additionalProperties: false,
      properties: {
        angle: { type: 'boolean' },
        projection: { type: 'boolean' },
        sum: { type: 'boolean' },
      },
    },
    readout: { type: 'array', maxItems: READOUTS.length, items: { type: 'string', enum: READOUTS } },
  },
};

function normalize(props) {
  const cfg = {
    xmin: props.xmin ?? -5,
    xmax: props.xmax ?? 5,
    ymin: props.ymin ?? -4,
    ymax: props.ymax ?? 4,
    grid: props.grid ?? 1,
    show: props.show ?? {},
  };
  if (!(cfg.xmin < cfg.xmax && cfg.ymin < cfg.ymax)) {
    fail(NAME, 'need xmin < xmax and ymin < ymax');
  }
  const vectors = (props.vectors ?? []).map((v, i) => ({
    name: v.label ?? v.id,
    x: v.x,
    y: v.y,
    color: v.color ?? (i % 6) + 1,
    draggable: v.draggable ?? true,
  }));
  if (vectors.length === 0) fail(NAME, 'at least one vector is required');
  const pairDefaults = vectors.length > 1 ? ['dot', 'cos', 'angle'] : [];
  cfg.readout = new Set(props.readout ?? ['coords', 'norm', ...pairDefaults]);
  return { cfg, vectors };
}

const dot = (a, b) => a.x * b.x + a.y * b.y;
const norm = (a) => Math.hypot(a.x, a.y);
// Two decimals keeps the readout arithmetic consistent with the displayed coordinates.
const round2 = (v) => Math.round(v * 100) / 100;

function build(el, props) {
  const { cfg, vectors } = normalize(props);
  const unit = (WIDTH - 2 * PAD) / (cfg.xmax - cfg.xmin);
  const height = Math.round(unit * (cfg.ymax - cfg.ymin) + 2 * PAD);
  const view = frame(el, { viewBox: `0 0 ${WIDTH} ${height}`, label: 'Vector plane' });
  const { svg, readout } = view;
  const { sx, sy, ix, iy } = makeScale(cfg, {
    left: PAD,
    top: PAD,
    width: WIDTH - 2 * PAD,
    height: height - 2 * PAD,
  });
  const P = (x, y) => [sx(x), sy(y)];

  drawGrid(svg, cfg, sx, sy);
  const dynamic = svgEl('g', {}, svg);
  const handles = svgEl('g', {}, svg);

  function arrow(parent, from, to, c, { dash, width = 2.5 } = {}) {
    const [x0, y0] = P(from.x, from.y);
    const [x1, y1] = P(to.x, to.y);
    const len = Math.hypot(x1 - x0, y1 - y0);
    const stroke = color(c);
    if (len < 1) {
      svgEl('circle', { cx: x1, cy: y1, r: 3, fill: stroke }, parent);
      return;
    }
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    const head = Math.min(11, len);
    const bx = x1 - ux * head;
    const by = y1 - uy * head;
    svgEl('line', {
      x1: x0, y1: y0, x2: bx, y2: by, stroke, 'stroke-width': width,
      'stroke-dasharray': dash ? '5 4' : null, 'stroke-linecap': 'round',
    }, parent);
    const w = head * 0.45;
    svgEl('polygon', {
      points: `${x1},${y1} ${bx - uy * w},${by + ux * w} ${bx + uy * w},${by - ux * w}`,
      fill: stroke,
    }, parent);
  }

  // Centered label at SVG coordinates (x, y).
  function textAt(parent, x, y, text, c) {
    svgEl('text', {
      x, y, fill: color(c), class: 'ld-w-label', 'text-anchor': 'middle', 'dominant-baseline': 'middle',
    }, parent).textContent = text;
  }

  // Label at world point `at`, shifted by `offset` pixels.
  function label(parent, at, text, c, offset = { x: 0, y: 0 }) {
    const [x, y] = P(at.x, at.y);
    textAt(parent, x + offset.x, y + offset.y, text, c);
  }

  // Offset (in px) along direction v, e.g. to push a tip label past the arrowhead.
  const tipOffset = (v, dist = 14) => {
    const n = norm(v) || 1;
    return { x: (v.x / n) * dist, y: (-v.y / n) * dist };
  };

  function drawConstructions(a, b) {
    const { show } = cfg;
    const O = { x: 0, y: 0 };
    const neutral = 'var(--muted)';
    if (show.projection && norm(b) > 1e-9) {
      const u = { x: b.x / norm(b), y: b.y / norm(b) };
      const s = dot(a, u);
      const proj = { x: u.x * s, y: u.y * s };
      const far = (cfg.xmax - cfg.xmin) + (cfg.ymax - cfg.ymin);
      const [lx0, ly0] = P(-u.x * far, -u.y * far);
      const [lx1, ly1] = P(u.x * far, u.y * far);
      // Nested <svg> clips the infinite line to the grid area.
      const pw = WIDTH - 2 * PAD;
      const ph = height - 2 * PAD;
      const clip = svgEl('svg', { x: PAD, y: PAD, width: pw, height: ph, viewBox: `${PAD} ${PAD} ${pw} ${ph}` }, dynamic);
      svgEl('line', { x1: lx0, y1: ly0, x2: lx1, y2: ly1, stroke: color(3), 'stroke-width': 1, 'stroke-dasharray': '4 4', opacity: 0.6 }, clip);
      const [px, py] = P(proj.x, proj.y);
      const [ox, oy] = P(0, 0);
      svgEl('line', { x1: ox, y1: oy, x2: px, y2: py, stroke: color(3), 'stroke-width': 6, opacity: 0.45, 'stroke-linecap': 'round' }, dynamic);
      const [ax, ay] = P(a.x, a.y);
      svgEl('line', { x1: ax, y1: ay, x2: px, y2: py, stroke: color(3), 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }, dynamic);
      // Label on the far side of the foot of the perpendicular, away from both vectors.
      const away = { x: proj.x - a.x, y: proj.y - a.y };
      label(dynamic, proj, 'proj', 3, tipOffset(norm(away) > 1e-6 ? away : { x: -u.y, y: u.x }, 26));
    }
    if (show.sum) {
      const s = { x: a.x + b.x, y: a.y + b.y };
      for (const [from, to] of [[a, s], [b, s]]) {
        const [x0, y0] = P(from.x, from.y);
        const [x1, y1] = P(to.x, to.y);
        svgEl('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: neutral, 'stroke-width': 1.2, 'stroke-dasharray': '5 4' }, dynamic);
      }
      arrow(dynamic, O, s, 5, { dash: true, width: 2 });
      label(dynamic, s, `${a.name}+${b.name}`, 5, tipOffset(s));
    }
    if (show.angle && norm(a) > 1e-9 && norm(b) > 1e-9) {
      const t0 = Math.atan2(a.y, a.x);
      let dt = Math.atan2(b.y, b.x) - t0;
      if (dt > Math.PI) dt -= 2 * Math.PI;
      if (dt < -Math.PI) dt += 2 * Math.PI;
      const rPx = clamp(0.35 * Math.min(norm(a), norm(b)) * unit, 16, 40);
      const [ox, oy] = P(0, 0);
      const polar = (r, t) => [ox + r * Math.cos(t), oy - r * Math.sin(t)];
      const arc = Array.from({ length: 33 }, (_, i) => polar(rPx, t0 + (dt * i) / 32));
      svgEl('path', { d: pathData(arc), fill: 'none', stroke: color(4), 'stroke-width': 2 }, dynamic);
      textAt(dynamic, ...polar(rPx + 11, t0 + dt / 2), 'θ', 4);
    }
  }

  function readoutText() {
    const r = cfg.readout;
    const lines = [];
    for (const v of vectors) {
      const parts = [];
      if (r.has('coords')) parts.push(`${v.name} = (${fmt(v.x)}, ${fmt(v.y)})`);
      if (r.has('norm')) parts.push(`‖${v.name}‖ = ${fmt(norm(v))}`);
      if (parts.length) lines.push(parts.join('   '));
    }
    if (vectors.length > 1) {
      const [a, b] = vectors;
      const cos = dot(a, b) / (norm(a) * norm(b));
      if (r.has('dot')) lines.push(`${a.name}·${b.name} = ${fmt(dot(a, b))}`);
      if (r.has('cos')) lines.push(`cos θ = ${fmt(cos, 3)}`);
      if (r.has('angle')) lines.push(`θ = ${fmt((Math.acos(clamp(cos, -1, 1)) * 180) / Math.PI, 1)}°`);
      if (r.has('projection')) {
        const s = dot(a, b) / norm(b);
        const k = dot(a, b) / dot(b, b);
        lines.push(`proj of ${a.name} on ${b.name}: ${a.name}·${b.name}/‖${b.name}‖ = ${fmt(s)},  vector (${fmt(k * b.x)}, ${fmt(k * b.y)})`);
      }
    }
    return lines.join('\n');
  }

  function draw() {
    dynamic.replaceChildren();
    if (vectors.length > 1) drawConstructions(vectors[0], vectors[1]);
    for (const v of vectors) {
      arrow(dynamic, { x: 0, y: 0 }, v, v.color);
      label(dynamic, v, v.name, v.color, tipOffset(v));
    }
    for (const h of handleEls) h.place();
    readout.textContent = readoutText();
  }

  function setVector(v, x, y) {
    v.x = round2(clamp(x, cfg.xmin, cfg.xmax));
    v.y = round2(clamp(y, cfg.ymin, cfg.ymax));
    draw();
  }

  const handleEls = vectors.filter((v) => v.draggable).map((v) => {
    const g = svgEl('g', {
      class: 'ld-w-handle', tabindex: 0, role: 'slider',
      'aria-label': `Vector ${v.name}: drag, or use arrow keys (Shift for larger steps)`,
    }, handles);
    const hit = svgEl('circle', { r: 18, fill: 'transparent' }, g);
    const dotEl = svgEl('circle', { r: 7, fill: color(v.color), 'fill-opacity': 0.25, stroke: color(v.color), 'stroke-width': 2 }, g);
    dragOn(g, svg, (p) => setVector(v, ix(p.x), iy(p.y)));
    arrowKeys(g, KEY_STEP, (dx, dy) => setVector(v, v.x + dx, v.y + dy));
    return {
      place() {
        const [x, y] = P(v.x, v.y);
        for (const c of [hit, dotEl]) {
          c.setAttribute('cx', x);
          c.setAttribute('cy', y);
        }
        g.setAttribute('aria-valuetext', `${v.name} = (${fmt(v.x)}, ${fmt(v.y)})`);
      },
    };
  });

  draw();
}

function drawGrid(svg, cfg, sx, sy) {
  const g = svgEl('g', { class: 'ld-w-grid' }, svg);
  if (cfg.grid > 0) {
    for (const x of ticks(cfg.xmin, cfg.xmax, cfg.grid)) svgEl('line', { x1: sx(x), y1: sy(cfg.ymin), x2: sx(x), y2: sy(cfg.ymax) }, g);
    for (const y of ticks(cfg.ymin, cfg.ymax, cfg.grid)) svgEl('line', { x1: sx(cfg.xmin), y1: sy(y), x2: sx(cfg.xmax), y2: sy(y) }, g);
  }
  const axes = svgEl('g', { class: 'ld-w-axis' }, svg);
  const y0 = clamp(0, cfg.ymin, cfg.ymax);
  const x0 = clamp(0, cfg.xmin, cfg.xmax);
  svgEl('line', { x1: sx(cfg.xmin), y1: sy(y0), x2: sx(cfg.xmax), y2: sy(y0) }, axes);
  svgEl('line', { x1: sx(x0), y1: sy(cfg.ymin), x2: sx(x0), y2: sy(cfg.ymax) }, axes);
  const labels = svgEl('g', { class: 'ld-w-tick' }, svg);
  for (const x of ticks(cfg.xmin, cfg.xmax, niceStep(cfg.xmax - cfg.xmin, 8))) {
    if (x === 0) continue;
    svgEl('text', { x: sx(x), y: sy(y0) + 14, 'text-anchor': 'middle' }, labels).textContent = fmtTick(x);
  }
  for (const y of ticks(cfg.ymin, cfg.ymax, niceStep(cfg.ymax - cfg.ymin, 6))) {
    if (y === 0) continue;
    svgEl('text', { x: sx(x0) - 5, y: sy(y) + 4, 'text-anchor': 'end' }, labels).textContent = fmtTick(y);
  }
}

export default defineWidget(NAME, propsSchema, build);
