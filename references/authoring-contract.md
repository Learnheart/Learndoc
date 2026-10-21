# Authoring contract

How to write `lessons/<id>.json`. The schemas in `~/.claude/skills/learndoc/schemas/` are binding; this file explains how to use them well. `finalize` rejects anything that breaks a rule marked **must**.

## learndoc.json

Full schema: `~/.claude/skills/learndoc/schemas/config.schema.json`; examples: `~/.claude/skills/learndoc/examples/*/learndoc.json`.

```json
{ "schemaVersion": 1, "language": "vi", "audience": "Learners studying model diffing",
  "references": {
    "mml":   { "type": "pdf", "file": "references/mathematics-for-ml.pdf", "title": "Mathematics for Machine Learning" },
    "notes": { "type": "markdown", "file": "references/notes.md" },
    "kl":    { "type": "web", "file": "references/web/kl-divergence.md", "url": "https://example.org/kl", "fetchedAt": "2026-10-21" } },
  "features": { "math": true },
  "boxTypes": { "ai": { "label": "Góc nhìn AI", "color": "c3" } } }
```

- `language`: a language code such as `vi`, `en`, `pt-BR` (pattern `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`). It follows the user's prompt unless they ask otherwise.
- `references`: one short slug alias per source. Each entry has `type` (`pdf`, `markdown` or `web`), `file` (a path in the project), optional `title`, and for `web` a required `url` (`http(s)://`) plus `fetchedAt` (`YYYY-MM-DD`).
- `features.math`: `true` only when the topic needs formulas; when it is false, pages do not load KaTeX, so write no `$…$` (it would show as raw LaTeX) and write a literal dollar as `\$`.
- `boxTypes`: only extra variants the default six do not cover; `label` is required, and `color` is one of `c1`…`c6`.
- Leave out `editModel` and `edit.maxRelated` unless the user asks; the defaults are `sonnet` and 8.

## Lesson file

```json
{ "schemaVersion": 1, "id": "03-inner-product-cosine", "title": "Norm, Inner Product & Cosine Similarity",
  "lede": "One or two sentences: what the learner will be able to do and why it matters.",
  "meta": { "duration": "~45 min", "level": "Intermediate" },
  "notation": { "\\boldsymbol{\\delta}": "activation difference h_ft − h_base" },
  "blocks": [ ... ] }
```

- `id` **must** equal the file name without `.json` and the id in `course.json`.
- `title`, `lede`, `meta.*` are plain text (no tags).
- `notation`: every symbol the lesson defines and reuses, as LaTeX key → short plain meaning. The edit server uses it to keep symbols consistent when the user edits, so list each one the lesson relies on.
- Write in `learndoc.json` `language`. Keep established technical terms in the form the references use (for example, English terms inside a Vietnamese lesson).

## Blocks

Every block has `id`, `type`, and exactly the fields of its type (no extra fields).

| type | fields | use for |
|---|---|---|
| `heading` | `level` 2 or 3, `anchor`, `text` (plain) | Section titles. `h2` starts a section shown in the table of contents; `h3` is a subsection. |
| `prose` | `html`, `sources` | One paragraph, one list or one table. A paragraph may carry the display formula that directly follows it. |
| `box` | `variant`, `title` (plain), `html`, `sources` | The main teaching unit: definitions, examples, formulas, intuitions, pitfalls, notes. |
| `math` | `latex` (no delimiters), `sources` | A standalone display formula that deserves its own block. |
| `code` | `language`, `code`, `caption?` (plain) | Code or terminal listings. Not executed. Use `text` for non-code listings. |
| `figure` | `svg` or `src` (one of them), `alt`, `caption` (plain) | Static diagrams and plots. `src` is a path under `assets/`. |
| `widget` | `widget`, `props` | Interactive demos, only from the [widget catalog](widget-catalog.md). No `sources`. |
| `quiz` | `question` (plain), `answer` (html), `sources` | Self-check question with a hidden answer. |

### Box variants

Built in: `def` (Definition), `example` (Example), `formula` (Formula), `intuition` (Intuition), `warn` (Pitfall), `note` (Note). Labels are localized automatically. A project adds more only in `learndoc.json` `boxTypes`, for example `"ai": { "label": "Góc nhìn AI", "color": "c3" }`. Use only variants that exist.

Give every box a specific title that names its content, such as `Definition — Norm (MML Def. 3.1)`, `Worked example — a biased coin`, or `Pitfall 2 — Ignoring magnitude`. Never use a bare `Example` or `Note` when a more specific title fits.

## Field formats

**html fields** (`prose.html`, `box.html`, `quiz.answer`) **must** use only these tags and attributes:
`p[class], strong, em, b, i, code, sub, sup, br, span[class], a[href], ul[class], ol[class], li, table[class], thead, tbody, tr, th[colspan], td[colspan], pre, blockquote`.
Allowed classes: `term` (a key term on first use, on `span`), `muted` (secondary remark, on `span` or `p`), `takeaways` (summary list, `ol`), `refs` (reference list, `ul`), `symbols` (symbol table under a formula, `table`), `data` (data table, `table`).
No `style`, no `id`, no `on*`, no `script`, no other tags. Escape literal `<`, `>`, `&` in text as `&lt;`, `&gt;`, `&amp;`.

**plain fields** (`text`, `title`, `question`, `caption`, `alt`, `lede`): no tags and no entities (`&amp;` would show literally); write `&`, `<` as plain characters. They may contain inline math.

**Math** (only when `features.math` is true):
- Inline `$…$`, display `$$…$$`. Nothing else: `\(…\)` and `\[…\]` are rejected.
- Inside math in an html field, write less-than as `\lt` (or `&lt;`) and greater-than as `\gt`; a raw `<` breaks the HTML.
- `\$` is a literal dollar sign anywhere outside math.
- Every formula **must** parse with KaTeX. Prefer standard commands (`\mathbf`, `\boldsymbol`, `\text`, `\tfrac`, `\langle … \rangle`, `\|x\|`). Non-Latin words inside `\text{}` render with a fallback font; keep them short.
- `math.latex` holds only the formula, without `$$`.

**Links** in html fields: `<a href="#anchor">` (anchor in this lesson), `<a href="lesson:<id>">` or `<a href="lesson:<id>#anchor">` (another lesson of this course), `<a href="https://…">` (external). A link to a lesson that is not in `course.json` **must** be plain text instead.

## Sources and grounding

`sources` is required on `prose`, `box`, `math` and `quiz`, with at least one entry:

- PDF: `alias#p71` or `alias#p71-73`, optionally with a display label after `|`: `mml#p77|§3.1`, `mml#p82-83|§3.4, eq. 3.25`. Page numbers are the **PDF page index** (1-based, as a PDF viewer counts them and as the chunk files `references/chunks/<alias>/p0077.txt` are named), not the number printed on the page.
- Markdown or web snapshot: `alias#heading-anchor`, naming a heading of that file: `notes#what-is-a-commit`. The exact anchors are listed in `references/chunks/<alias>/index.json` after the first `finalize`; cite only those. The same file gives a PDF's page count (plus `pagesWithoutText`).
- The alias **must** exist in `learndoc.json` `references`.

Rules:
1. Every content block cites the exact page range or section it is grounded on. Cite narrowly (the pages you actually used), not the whole chapter.
2. Never invent content the references do not support: definitions, numbers, examples, history, claims. Worked numeric examples you compute yourself are fine when they apply a cited definition; check the arithmetic.
3. If the references lack something the user asked for, leave it out and say so in your reply instead of filling the gap from memory.
4. `heading`, `code`, `figure` and `widget` blocks have no `sources`; the prose or box next to them carries the citation.

## Ids and anchors

- Block `id` **must** match `b-` followed by 4–12 characters `[a-z0-9]`, unique within the lesson, for example `b-norm01`, `b-7f3a2c`. Ids are permanent: never renumber or reuse them; repairs keep existing ids.
- Heading `anchor` **must** be a slug (`[a-z0-9-]`, starting with a letter or digit), unique within the lesson, short and stable: `big-picture`, `inner-product`, `pitfalls`. Other lessons link to anchors, so do not rename them after the lesson exists.

## Lesson skeleton

A good lesson (the sample lessons have about 11 `h2` sections, boxes as the main unit, and about 5 quizzes) follows this order:

1. **Big picture** (`h2`): why the topic matters, in two or three short paragraphs; optionally a box linking it to the learner's goal.
2. **Concepts** (one `h2` per concept): one or two framing paragraphs, then boxes: `def` for the precise statement, `formula` with a `symbols` table and a "how to read it" paragraph, `intuition`, `example` with real numbers. Add a figure or widget where seeing it beats reading it. Use `h3` for sub-steps.
3. **Applications** (optional `h2`): where the idea is used, grounded in the references.
4. **Pitfalls** (`h2`): `warn` boxes titled `Pitfall 1 — …`, `Pitfall 2 — …`.
5. **Summary** (`h2`): one prose block with `<ol class="takeaways">`, one item per key idea, each starting with the term in `<strong>`.
6. **Check yourself** (`h2`): 3–6 `quiz` blocks mixing computation and understanding; each answer explains why, not just the result.
7. **References** (`h2`): one prose block with `<ul class="refs">` naming each reference, the sections used and the file path.

Keep each block to one idea, so a reader can select it and ask for an edit. Prefer several short paragraphs over one long one.

## Figures

- Inline `svg` **must** be one static `<svg>` element with a `viewBox`, `role="img"`, and no `<script>`, `<foreignObject>`, `style` attributes, `on*` handlers or external `href` (fragment references such as `url(#arrow)` for markers are fine; keep such ids unique within the lesson).
- Allowed elements: `svg, g, defs, marker, line, rect, circle, ellipse, path, polygon, polyline, text, tspan, title, clipPath`. Allowed attributes: geometry (`x, y, x1, y1, x2, y2, cx, cy, r, rx, ry, width, height, d, points, transform`), `fill, stroke, stroke-width, stroke-dasharray, opacity, text-anchor, dominant-baseline, font-size, font-weight, marker-start, marker-end, clip-path, class`, plus `viewBox, role, aria-label` on `svg`, marker attributes on `marker`, and `id` on `marker` and `clipPath`. Use `opacity`, not `stroke-opacity` or `fill-opacity`.
- Color through these classes, which follow the page theme: `c1`…`c6` (stroke and fill in palette color), `fill-soft` (light fill), `stroke-only` (no fill), `axis`, `grid`, `muted` (secondary text). Avoid hard-coded colors so the figure works in dark mode.
- `alt` describes what the figure shows; `caption` explains what to notice and cites its basis in words (for example, "After MML Fig. 3.3").

## Widgets

Use a widget only when interacting teaches something a static figure cannot (dragging, sliders, live readouts), and only one listed in the [widget catalog](widget-catalog.md) with props valid for its schema. Put a short prose block right before it, with `sources`, saying what to try and what to notice. Project-specific widgets are not available in this version; if no built-in widget fits, draw a figure instead.

## Before finalize

- Every `prose`, `box`, `math`, `quiz` has `sources` with known aliases and real pages or headings.
- Ids and anchors are unique and well formed; `id` matches the file name.
- Only whitelisted tags and classes; no `\(`, `\[`; no raw `<` inside math in html fields.
- Box variants exist; widget names and props come from the catalog.
- Language matches `learndoc.json`; boxes have specific titles; the summary and quizzes match what the lesson actually says.
