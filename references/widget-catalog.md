# Widget catalog

Built-in interactive widgets. A `widget` block names one of them and gives its `props`:

```json
{ "id": "b-cosdemo", "type": "widget", "widget": "vector-plane", "props": { … } }
```

Widget blocks have no `sources` and no caption. Put a prose block right before the widget, with `sources`, saying what to try and what to notice. `finalize` validates `props` against the widget's `propsSchema` (unknown props are rejected) and the browser check mounts it, which also checks the cross-field limits below.

Defaults are shown as `name=value`; `?` marks an optional prop.

## When to use a widget, when a figure

- **Widget**: the learner learns by changing something and watching a quantity respond, such as dragging a vector and reading the cosine, moving a slider through a parameter, or editing a distribution and watching its entropy.
- **Figure** (inline SVG, see the [authoring contract](authoring-contract.md#figures)): the picture is fixed, such as a diagram, a tree, a labelled plot or a commit graph.
- Project-specific widgets are not available in this version (custom widgets come later). If no widget below fits, use a figure. Never put script in content.

## `vector-plane`

Draggable 2-D vectors on a grid, with optional geometric relations and live readouts.

```
{ xmin=-5, xmax=5, ymin=-4, ymax=4, grid=1,
  vectors: [{ id, x, y, label?, color? (1..6), draggable? (default true) }] (1..6),
  show?: { angle?, projection?, sum? }          // relations between vectors[0] and vectors[1]
  readout?: subset of ["coords","norm","dot","cos","angle","projection"] }
```

Use for norms, dot products, cosine similarity, projections and vector addition.

Limits: `vectors` is required; `xmin < xmax`, `ymin < ymax`; `grid` ≥ 0; vector `id` and `label` are 1–24 characters; `color` is an integer 1–6.

```json
{ "xmin": -5, "xmax": 5, "ymin": -3.6, "ymax": 3.6, "grid": 1,
  "vectors": [ { "id": "x", "x": 3, "y": 1, "label": "x", "color": 1 },
               { "id": "y", "x": 1.5, "y": 2.5, "label": "y", "color": 2 } ],
  "show": { "angle": true, "projection": true },
  "readout": ["coords", "norm", "dot", "cos", "angle", "projection"] }
```

## `distribution-bars`

A bar chart of a discrete distribution, optionally editable, with information-theory statistics.

```
{ labels: [string] (2..12), values: [number],
  mode: "weights"|"logits" (default weights; weights normalized),
  editable?: bool,
  temperature?: { min, max, step, value } (logits only),
  presets?: { [name]: [number] },
  compare?: { label, values },
  stats?: subset of ["entropy","cross_entropy","kl"] (last two need compare),
  base?: 2|"e" }
```

`values`, every preset and `compare.values` have one number per label. Use `weights` for probabilities or counts, and `logits` (softmax, with an optional temperature slider) for model outputs.

Limits: `labels` and `values` are required; labels are 1–24 characters; in `weights` mode all numbers are ≥ 0; `temperature` needs `min < max` and `min ≤ value ≤ max` (each ≥ 0.01); `compare.label` is 1–40 characters. Defaults: `editable` false, `stats` `["entropy"]`.

```json
{ "labels": ["A", "B", "C", "D"], "values": [80, 40, 20, 20], "mode": "weights", "editable": true,
  "presets": { "Uniform": [1, 1, 1, 1], "Confident": [97, 1, 1, 1] }, "stats": ["entropy"], "base": 2 }
```

## `function-plot`

Plot of 1–4 curves `y = f(x)` with optional parameter sliders, a point that slides along a curve, and readouts.

```
{ xmin, xmax, ymin, ymax,
  curves: [{ expr, label?, color?, dash? }] (1..4),
  params?: [{ name, min, max, step, value, label? }],
  point?: { curve, x, draggable? },
  readout?: [{ label, expr }] }
```

- `expr` grammar: numbers, `x`, param names, `+ - * / ^`, unary minus, parentheses, functions `sin cos tan exp log ln log2 sqrt abs min max pow`, constants `pi e`. `log` and `ln` are both the natural logarithm; use `log2` for bits. `-x^2` means `-(x^2)`.
- `point.curve` is the index of a curve in `curves` (0-based). Readout expressions are evaluated at the point's `x`; without a `point` they may use only param names, not `x`.
- Limits: `xmin < xmax`, `ymin < ymax`; `expr` is at most 200 characters; curve and readout `label`s are 1–40 characters; `color` is an integer 1–6; at most 6 `params` and 6 `readout` entries; a param `name` is 1–16 characters, a valid identifier other than `x`, a function or a constant, with `min < max` and `min ≤ value ≤ max`. `point.draggable` defaults to true.
- Keep `[xmin, xmax]` inside the domain of every curve, for example `0.001..0.999` for functions that use `log2(x)` and `log2(1-x)`.

```json
{ "xmin": 0.001, "xmax": 0.999, "ymin": 0, "ymax": 3.4,
  "curves": [ { "expr": "-(x*log2(x)+(1-x)*log2(1-x))", "label": "H₂(p)", "color": 1 },
              { "expr": "log2(1/x)", "label": "log₂(1/p)", "color": 2, "dash": true } ],
  "point": { "curve": 0, "x": 0.1, "draggable": true },
  "readout": [ { "label": "H₂(p) (bit)", "expr": "-(x*log2(x)+(1-x)*log2(1-x))" } ] }
```
