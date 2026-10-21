# Learndoc internal contracts

This file fixes the interfaces between modules so they can be built in parallel.
Design rationale lives in `../../learndoc-design.html` (Vietnamese; outside this repo). When this file and
the design disagree, this file wins for implementation details.

Runtime rule: **no `npm install` for users.** Runtime code imports only `node:` built-ins,
files inside this repo, and vendored libraries under `runtime/vendor/`. `devDependencies`
(ajv, katex, pdfjs-dist) are used only by `scripts/` to generate or vendor files that are
committed.

## 1. Layout

```
learndoc-skill/                 (symlinked to ~/.claude/skills/learndoc)
├── SKILL.md
├── LICENSE
├── package.json                devDependencies + generate/vendor/test scripts only
├── THIRD_PARTY_NOTICES.md
├── bin/learndoc.mjs            CLI: finalize, serve
├── lib/                        Node-only
│   ├── diagnostics.mjs         diagnostic + receipt helpers
│   ├── project.mjs             locate project root, load/parse json files, bootstrap .learndoc/ + git
│   ├── validate.mjs            schema + semantic validation
│   ├── generated-validators.mjs  (generated, committed)
│   ├── check.mjs               katex parse, html whitelist, links/anchors, course consistency
│   ├── page.mjs                full HTML page shells (lesson page, course index page)
│   ├── chrome.mjs              findChrome + PipeCdp + browser-check (ported from archify, MIT)
│   ├── static-server.mjs       tiny static handler shared by browser-check and the edit server
│   ├── refs.mjs                reference chunking (markdown by heading, pdf by page)
│   ├── git.mjs                 git helpers (init-if-needed, commit paths, log, revert)
│   └── finalize.mjs            gate pipeline + receipt
├── server/                     edit server (Node-only)
│   ├── cli.mjs                 `serve`: preflight (Node, claude), reuse/spawn, open browser
│   ├── server.mjs              http server, auth, routes
│   ├── store.mjs               changeset lifecycle, preview lessons, accept/cancel, history
│   ├── context.mjs             builds the prompt (context pack)
│   ├── edit-validation.mjs     changeset validation, insert-id pinning, group namespacing
│   └── spawner.mjs             runs `claude -p`, parses result
├── delta/
│   ├── changeset.mjs           apply changeset to a lesson copy (isomorphic-safe, no node: imports)
│   └── selection.mjs           resolve selection payload to source offsets (isomorphic-safe)
├── shared/                     isomorphic ES modules (browser + Node), no node: imports
│   ├── html.mjs                minimal HTML tokenizer + entity decode + escape helpers
│   ├── render.mjs              lesson/block → HTML string
│   ├── textview.mjs            flat text view of a field (from source string or from DOM)
│   ├── diff.mjs                sentence-level text diff for preview
│   └── mini-schema.mjs         tiny JSON-schema subset validator (widget props)
├── runtime/                    browser-only
│   ├── lesson.js               boot: theme, KaTeX render, widget mount, TOC
│   ├── editor.js               editor boot (only on editable pages)
│   ├── editor/                 api, body, dom, history, i18n, notes, preview, selection, session, ui modules
│   ├── style.css
│   ├── widgets/                built-in widgets: vector-plane.js, distribution-bars.js, function-plot.js
│   └── vendor/katex/           katex.min.js, katex.min.css, fonts/, katex.mjs (Node check)
│       vendor/pdfjs/           pdf.mjs + pdf.worker.mjs (legacy build, Node text extraction)
├── schemas/                    config, course, lesson, changeset, answer (*.schema.json), html-whitelist.json
├── references/                 authoring-contract.md, course-planning.md, edit-contract.md,
│                               widget-catalog.md, delivery-contract.md
├── examples/                   fixture projects (sample-derived + non-math)
├── scripts/                    generate-validators.mjs, vendor-katex.mjs, vendor-pdfjs.mjs
└── test/                       unit/ (node:test), fixtures/, fake-claude/ (LEARNDOC_CLAUDE_BIN stub),
                                e2e/ (CDP-driven UI journey)
```

Node ≥ 22 is required at runtime. A **project** is any directory containing `learndoc.json`. All project paths are
relative to the project root. Generated/state files go to `<project>/.learndoc/`.

## 2. Data formats (JSON Schema 2020-12, `schemas/`)

Common patterns:
- `slug`: `^[a-z0-9][a-z0-9-]{0,63}$`
- `blockId`: `^b-[a-z0-9]{4,12}$`
- `sourceRef`: `^[a-z0-9][a-z0-9-]*#(p[0-9]+(-[0-9]+)?|[a-z0-9][a-z0-9-]*)(\|.{1,80})?$`
  (`mml#p71`, `mml#p71-73|§3.1`, `notes#what-is-an-agent`)

### learndoc.json (`config.schema.json`)
```json
{ "schemaVersion": 1, "language": "vi", "audience": "string?",
  "references": { "<alias slug>": { "type": "pdf|markdown|web", "file": "relative path",
                                     "title": "string?", "url": "string (required for web)",
                                     "fetchedAt": "YYYY-MM-DD? (web)" } },
  "features": { "math": true },
  "boxTypes": { "<name slug>": { "label": "string", "color": "c1..c6" } },
  "editModel": "string? (default 'sonnet')",
  "edit": { "maxRelated": "int 1..30, default 8" } }
```
Default box types (built into skill, overridable label only):
`def` Definition, `example` Example, `formula` Formula, `intuition` Intuition, `warn` Pitfall, `note` Note.
Labels are localized by `language` (`vi`, `en`; fallback `en`).

### course.json (`course.schema.json`)
```json
{ "schemaVersion": 1, "title": "string", "description": "string?",
  "modules": [ { "id": "slug", "title": "string",
                 "lessons": [ { "id": "slug", "title": "string", "summary": "string?",
                                "prereq": ["slug"], "sources": ["sourceRef"],
                                "status": "planned|done" } ] } ] }
```

### lessons/<id>.json (`lesson.schema.json`)
```json
{ "schemaVersion": 1, "id": "slug (== file name)", "title": "string", "lede": "string?",
  "meta": { "duration": "string?", "level": "string?" },
  "notation": { "<latex>": "meaning" },
  "blocks": [ Block ] }
```
Blocks (all have `id`, `type`; `additionalProperties: false`):
| type | fields | text fields (selectable) |
|---|---|---|
| heading | `level` 2\|3, `anchor` slug, `text` | `text` (plain text + inline math) |
| prose | `html`, `sources` (minItems 1) | `html` |
| box | `variant` slug, `title`, `html`, `sources` (minItems 1) | `title` (plain + math), `html` |
| math | `latex`, `sources` (minItems 1) | `latex` (whole formula only) |
| code | `language`, `code`, `caption?` | `code`, `caption` |
| figure | `svg?` xor `src?` (assets/ path), `alt`, `caption` | `caption` (plain + math) |
| widget | `widget` slug, `props` object | none (whole block only) |
| quiz | `question` (plain + math), `answer` html, `sources` (minItems 1) | `question`, `answer` |

Field kinds:
- **html** fields: whitelisted HTML (see `html-whitelist.json`) + inline math `$…$` and display math `$$…$$`.
  Literal `<` inside math must be `\lt` or `&lt;`. `\$` is a literal dollar. `\[ \]`, `\( \)` are rejected.
- **plain** fields (`text`, `title`, `question`, `caption`, `alt`): no tags; may contain `$…$` math.
  Rendered with HTML escaping; math wrapped like html fields.
- `latex`, `code`: raw strings.

Cross-lesson links inside html: `<a href="lesson:<id>">` or `<a href="lesson:<id>#<anchor>">`.
In-lesson: `<a href="#<anchor>">`. External: `https://…` only.

### html-whitelist.json
Tags → allowed attributes. v1 set (from the sample):
`p[class], strong, em, b, i, code, sub, sup, br, span[class], a[href], ul[class], ol[class], li,
table[class], thead, tbody, tr, th[colspan], td[colspan], pre, blockquote`.
Classes: `term, muted, takeaways, refs, symbols, data`. No `style`, no `on*`, no `id`, no `script`.

Figure `svg` field has its own whitelist: tags `svg[viewBox,width,height,role,aria-label]`, `g, defs, marker[id,viewBox,refX,refY,markerWidth,markerHeight,orient]`, `line, rect, circle, ellipse, path, polygon, polyline, text, tspan, title, clipPath[id]` with geometry/presentation attributes (`x y x1 y1 x2 y2 cx cy r rx ry width height d points transform fill stroke stroke-width stroke-dasharray opacity text-anchor dominant-baseline font-size font-weight marker-start marker-end clip-path class`), `id` only on `marker`/`clipPath`, `url(#id)` references only to ids in the same svg. SVG classes: `c1..c6, fill-soft, stroke-only, axis, grid, muted`. No `style`, `on*`, `href`, `foreignObject`, `image`, `script`.

PDF page numbers in `sourceRef` are 1-based indexes into the PDF file (what the chunker and Claude's Read tool use), not printed page numbers.

### Changeset (Claude output, `changeset.schema.json`; single object, fields optional, validated locally)
```json
{ "summary": "string",
  "changes": [ { "op": "replace|insert|delete|move", "blockId": "string?", "after": "blockId|null?",
                 "role": "primary|related", "group": "string?", "block": { "type": "...", ... }?,
                 "reason": "string" } ],
  "notation": { "set": { "<latex>": "meaning" }, "remove": ["<latex>"] },
  "needsConfirmation": { "scope": ["blockId"], "reason": "string" } }
```
Rules: exactly one of `changes` / `needsConfirmation`. `replace` needs blockId+block; `insert` needs
`after` (null = at start) + block (no id; server assigns); `delete` needs blockId; `move` needs blockId+after.
`block` never carries `id` (server keeps/assigns). `related` changes need non-empty `reason`.
Several `insert`s with the same `after` are placed in the order they are listed.

### Ask answer (`answer.schema.json`)
`{ "answer": "html string", "sources": ["sourceRef"] }`

## 3. Rendering (`shared/render.mjs`)

```js
export const DEFAULT_BOX_TYPES            // {name: {label: {vi,en}, color}}
export function resolveBoxTypes(config)   // merged {name: {label, color}} for config.language
export function wrapMath(text, kind)      // kind 'html' | 'plain' -> HTML string; plain is escaped first
export function renderBlock(block, ctx)   // -> '<section ...>...</section>'
export function renderLessonBody(lesson, ctx) // -> blocks HTML (no page chrome)
// ctx = { boxTypes, lessonId, linkBase: '/lessons/' }
```
DOM conventions (editor + textview depend on these exactly):
- Block: `<section class="ld-block ld-<type>" data-block-id="<id>" data-type="<type>">`.
- Each selectable field container carries `data-field="<field>"` and contains ONLY that field's
  rendered content. Renderer-added text (box variant label, numbering, widget controls, quiz "Answer"
  label, copy buttons) is inside an element with `data-chrome` (or outside any `data-field`).
- Math: every `$…$` / `$$…$$` in a field becomes
  `<span class="math" data-math="<n>" data-display="0|1" data-latex="<attr-escaped latex>"><escaped latex></span>`,
  `n` counting from 0 per field in order of appearance. `lesson.js` renders KaTeX into the span.
- Widget: `<div class="ld-widget" data-widget="<name>" data-props="<attr-escaped json>"></div>` inside the section.
- Heading: `<h2|h3 id="<anchor>" data-field="text">`.
- Links `lesson:<id>#a` → `<linkBase><id>#a`.

## 4. Text view (`shared/textview.mjs`)

```js
export const OBJ = '￼'
export function textViewFromSource(str, kind)  // kind 'html'|'plain'|'raw' -> { text, map }
// map: Int32Array(text.length + 1); map[i] = offset in str where text char i starts; map[text.length] = str.length
export function textViewFromDom(fieldEl)       // browser: -> { text, points } ; points[i] = {node, offset}
export function domPointToIndex(fieldEl, node, offset) // browser: index into textViewFromDom(fieldEl).text
```
Normalization (identical on both sides):
1. Each math span / `$…$` / `$$…$$` → one `OBJ` char (DOM: skip span children).
2. Elements with `data-chrome` contribute nothing.
3. Block-level boundaries (`p, li, ul, ol, table, tr, td, th, pre, blockquote, br, div`) contribute one space.
4. Entities decoded; ` ` treated as whitespace.
5. Runs of whitespace collapse to one space; leading/trailing whitespace trimmed.

## 4b. Diff (`shared/diff.mjs`)

```js
export function diffField(oldSrc, newSrc, kind) // kind 'html'|'plain'|'raw' -> rendered HTML string
```
Splits both sources into sentence units (split after `.`, `!`, `?`, `:` followed by space, never inside a
tag or a `$…$`/`$$…$$`; units also split at tag boundaries so wrapping never breaks nesting), diffs unit
arrays with LCS, and returns HTML where removed units are wrapped in `<del class="ld-del">` and added units
in `<ins class="ld-ins">`. Math inside units is emitted through `wrapMath`, so KaTeX still renders.

## 5. Selection (`delta/selection.mjs`)

Payload from editor:
```json
{ "focusBlockIds": ["b-..."],
  "ranges": [ { "blockId": "b-...", "field": "html",
                "quote": { "exact": "...", "prefix": "<=32 chars", "suffix": "<=32 chars" },
                "mathIdx": [0] },
              { "blockId": "b-...", "whole": true } ] }
```
```js
export function resolveSelection(lesson, selection)
// -> { focusBlockIds, ranges: [{ blockId, field, start, end, exact, math: [latex...] } | { blockId, whole: true }],
//      warnings: [{ code: 'selection_unresolved', blockId, field }] }
export function markFocus(fieldSource, start, end) // -> string with ⟦focus⟧…⟦/focus⟧ inserted
```
Resolution: build textViewFromSource; find all occurrences of `exact`; pick best by prefix/suffix match
length; fallback: whitespace/punctuation-normalized match; map to source offsets via `map`; widen to
avoid cutting inside a tag or a `$…$`. Unresolved → `{whole:true}` + warning.

## 6. Changeset apply (`delta/changeset.mjs`)

```js
export function applyChangeset(lesson, changeset, { newId }) // -> { lesson, applied: [...], errors: [...] }
export function summarizeChanges(baseLesson, applied)        // counts {replace, insert, delete, move}
export function excludeGroups(changeset, groupIds)           // -> changeset without those groups
```
`applied[i] = { index, op, blockId (final), role, group, reason, before: Block|null, after: Block|null, position }`.

## 7. Edit server (`server/`)

Start: `node bin/learndoc.mjs serve [--lesson <id>] [--no-open] [--foreground] [--port N]`.
Preflight: Node ≥ 22 and `claude --version` (login is not checked). Every serve failure prints
`{ "ok": false, "error": { "code", "message", "fix" } }` and exits 1; codes: `env/node`, `env/claude`, `project/missing`
(no `learndoc.json` at or above cwd), `server/start` (not healthy within the start timeout). Chrome is not needed
to serve. The browser is opened with the OS default handler (`open` / `xdg-open` / `start`) unless `--no-open`.
Non-foreground: if `.learndoc/server.json` points to a live, healthy server for this project → reuse;
else spawn detached `serve --foreground` (log `.learndoc/server.log`), wait for health. Prints one JSON line:
`{ "ok": true, "url": "http://127.0.0.1:<port>/?t=<token>", "lessonUrl"?: "...", "pid", "port", "reused" }`;
`lessonUrl` is present only with `--lesson` (reopening without a lesson replies with `url`).
`server.json`: `{ pid, port, token, startedAt, projectRoot }` (mode 0600).

Auth: bind `127.0.0.1`. Random 32-byte hex token per start. First page load with `?t=<token>` sets cookie
`ld_t` (HttpOnly, SameSite=Strict, Path=/). Every request except `/api/health` and `/static/*` needs a valid
cookie. Every `/api/*` non-GET request additionally needs header `X-Learndoc-Token: <token>` and an `Origin`
equal to `http://127.0.0.1:<port>`. `Host` must be `127.0.0.1:<port>` or `localhost:<port>`. Failures → 403.

Routes:
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/` | – | course index page |
| GET | `/lessons/:id` | – | lesson page (editor enabled) |
| GET | `/static/{runtime,shared,delta}/*` | – | skill files |
| GET | `/project/{widgets,assets}/*` | – | project files (no `..`, realpath inside project) |
| GET | `/api/health` | – | `{ ok, pid, projectRoot }` |
| GET | `/api/lessons/:id` | – | `{ lesson, rev, config: {boxTypes, language, features, editModel}, openChangeset? }` |
| POST | `/api/edit` | `{ lessonId, mode: 'replace'\|'insert'\|'ask', instruction, selection, model? }` | `{ changesetId }` (202) |
| GET | `/api/changesets/:id` | – | Changeset view (below) |
| POST | `/api/changesets/:id/confirm` | – | `{ changesetId }` (re-runs with maxRelated raised to scope size) |
| POST | `/api/changesets/:id/refine` | `{ instruction, selection? }` | `{ changesetId }` (same id, new round) |
| POST | `/api/changesets/:id/accept` | `{ excludeGroups?: [] }` | `{ lesson, rev, commit }` |
| DELETE | `/api/changesets/:id` | – | `{ ok }` (kills running claude) |
| GET | `/api/lessons/:id/history` | – | `[{ commit, date, summary, restorable }]` (`restorable` is false for the commit that added the lesson file) |
| POST | `/api/lessons/:id/revert` | `{ commit }` | `{ lesson, rev, commit }` (restore to before `<commit>`; the commit that added the lesson file → 409 `history/no-parent`) |
| GET | `/api/lessons/:id/notes` | – | `[{ id, blockId, question, answer, sources, createdAt }]` |

Changeset view:
```json
{ "id", "lessonId", "mode", "status": "running|ready|needs_confirmation|failed|accepted|cancelled|answered",
  "round": 1, "summary", "counts": {...}, "changes": [applied...], "warnings": [{ code, blockId?, message }] (exactly these fields),
  "focus": resolvedSelection, "preview": Lesson, "needsConfirmation": {...}?, "answer": {...}? (ask),
  "error": "string?", "diagnostics": [Diagnostic]? (failed validation), "usage": { "costUsd", "durationMs" } }
```
Terminal statuses: `accepted`, `cancelled`, `answered` (Ask mode, once the note is stored). DELETE on a
terminal changeset returns `{ ok: true }` and never deletes notes. `openChangeset` in GET `/api/lessons/:id`
is `null` or `{ id, mode, status }`; its `config` is `{ boxTypes (raw), language, features, editModel }`.
Refine body may carry `model`; unknown extra fields are ignored. Ask `answer.sources` are validated like block sources (known alias, cited page/anchor exists). Ask `answer.answer` goes through the html
whitelist check. One open (non-terminal) changeset per lesson → 409 with `error.code = 'changeset_open'`. `baseRev` = git blob/commit of lesson file at start;
accept refuses if lesson changed (409). Accept writes `lessons/<id>.json` and commits only that file with message `learndoc: <summary>`. Ask mode stores note in
`.learndoc/notes/<lessonId>.json`, never touches the lesson.

Validation before a changeset becomes `ready` (same functions as finalize): schema per block, html whitelist,
KaTeX parse, ids, anchors unchanged for replaced headings, `anchor/referenced` (no deleted or re-anchored heading that
another lesson links to), widget props vs propsSchema, related needs reason,
related count ≤ maxRelated, `outside_focus` warning. On failure: one automatic retry with errors appended to
the prompt; second failure → status `failed` with diagnostics.

## 8. Spawner (`server/spawner.mjs`)

Args: `-p --model <m> --output-format json --json-schema <text> --tools "" --strict-mcp-config
--append-system-prompt-file <skill>/references/edit-contract.md --no-session-persistence`; prompt via stdin
(`end()`); cwd = project root; timeout 150 s (SIGTERM, then SIGKILL after 3 s).
Outcome: exit≠0 and stdout not JSON → `cli_error` (stderr); `is_error` → `api_error`; missing/non-object
`structured_output` → `no_structured_output` (include `result` prose); else ok. Do not trust `subtype`.
Return `{ ok, value, costUsd, durationMs, error?, raw? }`. Binary overridable by env `LEARNDOC_CLAUDE_BIN`
(tests use a fake).

## 9. Browser runtime

Page HTML (from `lib/page.mjs`) loads, in order: `/static/runtime/vendor/katex/katex.min.css`,
`/static/runtime/style.css`, classic `/static/runtime/vendor/katex/katex.min.js` (both KaTeX assets omitted when
`features.math` is false), module
`/static/runtime/lesson.js`, module `/static/runtime/editor.js` (only when `editable`). Metas:
`learndoc-lesson` (id), `learndoc-token` (token), JSON script `#ld-widgets` = `{name: url}` for every built-in widget
plus every project widget the lesson uses. Body: `<main class="ld-lesson" data-lesson-id>` with header (title, lede, meta) + `renderLessonBody`.

Page chrome markup (generated by `lib/page.mjs`, styled by `runtime/style.css`):
```html
<html lang="<language>" data-theme?>
<body class="ld-page ld-page-lesson|ld-page-index">
  <header class="ld-topbar"><a class="ld-home" href="/">Course title</a>
    <span class="ld-crumb">Module · Lesson</span><button class="ld-theme-toggle" type="button"></button></header>
  <div class="ld-layout">
    <nav class="ld-toc"><a href="#<anchor>">…</a>…</nav>          <!-- h2 headings only -->
    <main class="ld-lesson" data-lesson-id="<id>">
      <header class="ld-lesson-header"><div class="ld-kicker">Module</div><h1>Title</h1>
        <p class="ld-lede">…</p><div class="ld-meta"><span class="ld-chip">…</span></div></header>
      …renderLessonBody…
      <nav class="ld-lesson-nav"><a class="ld-prev" href>…</a><a class="ld-next" href>…</a></nav>
    </main>
  </div>
</body>
```
Index page: same topbar; `<main class="ld-index">` with `<h1>`, description, then per module
`<section class="ld-module"><h2>` + `<a class="ld-card" href="/lessons/<id>">` (title, summary, status badge
`.ld-badge.planned|done`). Planned lessons are not links. Box markup:
`<section class="ld-block ld-box ld-box-<variant>" style="--box-c: var(--c<n>)">` containing
`<div class="ld-box-head"><span class="ld-box-label" data-chrome>Label</span><span class="ld-box-title" data-field="title">…</span></div>`
`<div class="ld-box-body" data-field="html">…</div>`. Quiz: `<details class="ld-quiz"><summary data-field="question">`
`<div class="ld-quiz-answer"><span class="ld-answer-label" data-chrome>…</span><div data-field="answer">…</div></div></details>`.
Colors `c1..c6` are CSS tokens `--c1..--c6` (+ `--c<n>-soft`) defined for light and dark.

`lesson.js` exports and also sets `window.learndoc`:
```js
ready                     // Promise: resolves once the initial mountWidgets(document) settles
renderMath(root)          // KaTeX into span.math within root (throwOnError false in browser)
mountWidgets(root)        // async; dynamic import(url); widget.mount(el, props, ctx); el.dataset.mounted='1'
destroyWidgets(root)
replaceBlock(sectionEl, block, ctx)  // destroy, swap HTML from renderBlock, renderMath, mountWidgets
selfTest()                // async -> { widgets: [{name, mount, update, destroy, error?}] }  (browser-check)
```
Widget module contract:
```js
export default { name, propsSchema, mount(el, props, ctx) { return { update(props), destroy() } } }
// ctx = { theme: 'light'|'dark', katex, onThemeChange(fn) }
```

## 10. finalize (`bin/learndoc.mjs finalize <file> [--json]`)

Target kinds by path: `learndoc.json` → config; `course.json` → config+course; `lessons/<id>.json` → all.
First run in a project: create `.learndoc/` (+ `.gitignore` with `server.json`, `server.log`, `build/`,
`changesets/`), `git init` if not inside a work tree, chunk references into `references/chunks/<alias>/`.
Gates: `validate → render → check → browser-check` (lesson only for render/browser-check).
Gate status values: `pass | fail | skipped | not-run`.
Receipt (stdout, one JSON line): `{ schemaVersion:1, ok, command:'finalize', status: pass|fail|skipped,
target:{kind,path,sha256}, gates:{validate,render,check,'browser-check'}, failedStage?, diagnostics[≤8],
diagnosticSummary:{total,shown,truncated,omittedByCode?}, artifact?, commit? (lesson targets), nextAction?, durationMs }`.
`target.path` is absolute. `omittedByCode` (`{code: count}`) is present only when truncated. `nextAction` is present only
when `validate` or `check` failed: `{ action: 'edit-in-place', file: <absolute path>, constraint: string,
then: 'finalize-once' }`. Gate `not-run` = an earlier gate failed; `skipped` = not applicable to the target kind,
or Chrome missing. On `pass`/`skipped` a lesson file is rewritten as canonical 2-space JSON and
`learndoc.json`, `course.json` and the lesson are committed (`learndoc: finalize <id>`); lesson receipts carry `commit`
(hash, or `null` on failure / nothing to commit; a git failure is warning `project/commit-failed`, not a fail).
Diagnostic: `{ code: 'area/kind', severity, message, subject: object, evidence?: object, supportedFixes: [] }`
(e.g. `math/katex`, subject `{ file, id, field }`, evidence `{ latex }`).
Exit: 0 pass, 1 fail, 2 skipped (Chrome missing), 64 usage error (unknown command/option, not exactly one file,
unsupported target path, missing file).

## 11. Accepted deviations (implementation is authoritative)

Recorded after review; the sections above already reflect them.

- `diagnosticSummary.omittedByCode` added to receipts (only when truncated).
- KaTeX CSS/JS are omitted from pages when `features.math` is false.
- `#ld-widgets` lists all built-in widgets (not only those used) plus used project widgets.
- Changeset view: `changes` come from `diffLessons(base, preview, rounds)` (net change vs. the original lesson across
  refine rounds, each entry tagged with its `round`); insert ids are assigned by the server and pinned into the stored
  round so re-applying is deterministic; group ids are namespaced per round (`r2:g-notation`). Known limitation: a
  block touched by groups in several refine rounds is listed under the latest round's group only.
- History "undo" is "restore to before `<commit>`": the lesson file is set to its content before that commit and the
  result is committed as a new commit (history is never rewritten).
- `serve` runs a preflight (Node ≥ 22, `claude --version`; login not checked); all serve failures share
  `{ ok: false, error: { code, message, fix } }` (`env/node`, `env/claude`, `project/missing`, `server/start`). Chrome is
  only needed by finalize's browser-check.
- `finalize` rewrites a passing (or skipped) lesson file as canonical 2-space JSON and commits it with `learndoc.json`
  and `course.json`; the receipt carries `commit`.
- Node floor is 22.
