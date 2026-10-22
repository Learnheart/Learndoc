# Import contract

`import` converts an existing HTML course into a learndoc project, with no model calls during the conversion. Use it instead of rewriting the pages yourself.

## Import flow

1. **Target.** Import into a new empty folder. If the working directory is the source folder or inside it (refused as `import/target-is-source` or `import/target-inside-source`), create the empty sibling folder `<source-folder-name>-learndoc` next to the source, or ask the user if it already exists, and import there. The one-line reply may then end with that folder's path.
2. **Look.** Read the source's `index.html` (if any) and **one** lesson page with Read limit ~150 lines; read more only to locate a selector, preferably with one targeted grep whose output is small. Never print whole source pages (the small demo files in step 5 are the exception). A `README` in the source may also help. Do not read the skill's own code; widget props are in the [widget catalog](widget-catalog.md).
3. **Profile.** Write `import-profile.json` in the target folder only for what the defaults below miss; often none is needed.
4. **Run** `import <source-dir> --json` from the target folder.
   - Setup errors (`import/target-exists`, `import/target-is-source`, `import/target-inside-source`, `import/profile-invalid` (including invalid CSS selectors), `json/parse`, `schema/*`, `import/chrome-missing`, `import/no-pages`: no page matches `files`, or every page was skipped as redirected or empty) leave `report: null`; read the receipt's diagnostics and fix the profile or the folder.
   - When lessons fail their gates, import still writes and commits everything and exits 1. Read the lesson's diagnostics in `report.json`. If a problem comes from the profile (a wrong selector, lost content), fix the profile and import again into a new empty folder, or ask the user before removing anything. If it comes from the source content itself (for example, TeX that KaTeX cannot parse), stop and report the lesson and the rule; never edit the lesson.
5. **Demos.** Convert pending demos that have a fitting candidate (see Converting a pending demo).
6. **Remaining demos** stay as notes: do not ask the user. Run `serve` and reply in one line. After ` — `, add, in the user's language: the folder you created (if any); the number of demos kept as notes, when N > 0; and the number of pages skipped, when the receipt or report has `import/empty-page` or `import/redirected` warnings, with the reason. For example ` — ../khoa-hoc-learndoc, 41 demo giữ dạng ghi chú, 2 trang bị bỏ qua (dựng bằng JavaScript/chuyển hướng)`.

```bash
node <skill-dir>/bin/learndoc.mjs import <source-dir> [--profile <file>] --json
```

- Run it in the **target** folder, which becomes the project. That folder must not contain `learndoc.json`, `course.json` or `lessons/` (`import/target-exists`), and must not be the source folder or inside it (`import/target-is-source`, `import/target-inside-source`). Use a new empty folder.
- Chrome or Chromium is required (`import/chrome-missing` otherwise). All network access is blocked browser-wide (a dead proxy plus blocked `http(s)://` and `ws(s)://`). Pages are opened with scripts disabled, so local CSS applies but nothing runs or loads from the internet. Page scripts run only on the `course.globals` page, and there WebRTC (`RTCPeerConnection` and related APIs) and `navigator.mediaDevices` are unavailable. A page that redirects (meta refresh) is skipped with `import/redirected`; a page with no content when scripts are disabled (likely built by JavaScript) is skipped with `import/empty-page`. Both are warnings.
- The profile is `import-profile.json` in the target folder, or `--profile <file>`. Your profile, wherever it lives, is copied into the project as `import-profile.json` (same keys and values, formatted as 2-space JSON) and committed; `report.json` records its sha256 as `profileSha`. Without a profile, nothing is written, `profileSha` is null, and the generic defaults below apply. The resolved profile (defaults merged with yours, plus the detected `language`) is never written.

## What it writes

- `learndoc.json` with `features.math: true`, the `language` (from the profile, else the first lesson page's `<html lang>`, else `en`) and the profile's `boxes.boxTypes`, and no `references`: an imported page is the content itself, not a source, so nothing is copied into `references/`.
- `course.json`, with every lesson `done`, no `sources`, and `prereq` taken from chip rules.
- `lessons/<id>.json`. The id is the page path slugified (`03-inner-product-cosine.html` → `03-inner-product-cosine`), and block ids are `b-` plus 8 hex characters. Each lesson records its page in `origin`: `{ "file": <path relative to the project>, "sha256": <hash of the page as imported> }`. Its blocks have no `sources`; `sources` stays optional in a lesson with `origin`, and any it has must cite real references.
- `assets/` (only the local images that figures use, copied), `.learndoc/import/report.json`, and `.learndoc/import/demos/<lesson>--<demoId>.html` and `.js` for every demo.
- All finalize gates run for the config, the course and each lesson, without per-lesson commits. Then one commit of the config, course, lessons, copied assets and (when you gave one) your profile: `learndoc: import <N> lessons from <dir>`. It is made even when some lessons fail.

Generic rules: the title is the page's `h1` (else `<title>`). Headings become heading blocks (an anchor that would read as a page reference, such as `p1`, gets a `-section` suffix), and `p`, lists, tables and blockquotes become prose. Every `aside`, and every `div`/`section` with a box-like class, becomes a box, titled from a child whose class ends in `title`/`heading`/`header`, or a leading `h2`–`h6`. `details` becomes a quiz (the `summary` is the question), `pre` becomes a code block (language from a `language-*`/`lang-*` class), and `figure`, `svg` and `img` become figures. KaTeX output becomes `$…$`/`$$…$$` from its TeX annotation, and raw `\(…\)`/`\[…\]` become `$`/`$$`. Anything with form controls, a canvas or an empty (script-drawn) SVG is a **demo**: it becomes a `note` box with the demo's title and hint, listed in `pendingDemos`.

## Profile

Every key is optional. Objects merge with the defaults key by key; arrays and strings replace them, so repeat any default entries you want to keep (for example in `files.exclude` or `boxes.variants`). Regular expressions are JavaScript sources in JSON strings, so write `\\d` for `\d`. Schema: `<skill-dir>/schemas/import-profile.schema.json`.

| Key | Default | Set it when |
|---|---|---|
| `language` | the first lesson page's `<html lang>`, else `en` | The pages lack a correct `lang` attribute. Box labels and the edit UI follow it. |
| `files.include` / `files.exclude[]` | `\.html?$` / `["^index\\.html?$"]` | Some pages are not lessons (`404.html`, `search/`, `tags/`). Matched against the path relative to the source folder. |
| `course.title` | `{ "from": "index.html", "selector": "h1" }` | The index has no good `h1`; give a string or another `{from, selector}`. It falls back to the source folder name. |
| `course.order` | `index-links` | See Course order. |
| `course.globals` | `{ page: "index.html", lessonFields: { key: "id", file: "file", module: "module", title: "title" } }` | The index builds its lesson list in JavaScript: set `order: "globals"` and `expr`, an expression that evaluates (with scripts enabled) to an array of lesson records. |
| `course.modules[]` | none (one module titled like the course) | Lessons should be grouped: `{ id, title, match }`, where `match` is tested against the globals `module` field, else the page path. Unmatched lessons go to `Other`. |
| `lesson.root` | `main, article` (else `body`) | The content sits in another container, or the page has sidebars inside `main`. |
| `lesson.header`, `lede`, `kicker`, `chips` | `header`, `p`, `.kicker`, `.chip` | The page header uses other markup. The kicker is dropped; chips become a muted line unless a rule maps them. |
| `lesson.chipRules[]` | none | Chips carry data: `{ label, to: "meta.duration" }`, `{ label, to: "prereq", ref? }`, or `to: "prose"`. `label` is matched against the chip's bold label or text. For prereq, `ref` is applied to the whole chip text and every match counts. Its first group (else the whole match) names a lesson: a `course.globals` key, a lesson id, or a lesson's numeric id prefix (`03-…`), with numbers compared by value. After each match, a list continues through an optional `(…)` and `,` `;` `/` `&` `và` `and`. A number written `NN–MM` (`-`, `–` or `—`) is a range naming every lesson numbered within it. Without `ref`, every number in the chip counts, which can catch unrelated numbers ("Mục 10–12"). Prefer a keyword-anchored `ref` such as `Bài\\s*(\\d+)` or `Lesson\\s*(\\d+)`: it captures "Bài 04 (Projection), 05 (Eigen), 06" and stops there. Prereq chips also stay in the lesson as a muted line. |
| `lesson.headingLevels` | `h1`/`h2` → 2, `h3`–`h6` → 3 | The pages use `h3` as section titles, and so on. |
| `boxes.classPattern` | `^(box\|callout\|admonition\|note\|warning\|tip\|alert\|info)$` | Boxes use other class names. |
| `boxes.variants` | the six default variants | A class should map to a variant of the same name. To keep a custom class (`ai`), declare it in `boxTypes` **and** list it here. |
| `boxes.variantMap` | `warning`/`danger`/`caution`/`pitfall`/`important` → `warn`, `tip`/`hint` → `intuition`, `info` → `note`, `definition`/`theorem` → `def` | Other class names should map to a variant. A box with no known class becomes `note`. |
| `boxes.fallbackTitles` | the localized variant labels | Untitled boxes need a different title. |
| `boxes.boxTypes` | none | Extra variants: `{ "<name>": { "label", "color": "c1".."c6" } }`. They are copied into `learndoc.json`. |
| `demos.selector`, `title`, `hint`, `chrome` | `.demo`, `.demo-title`, `.hint`, `.controls, .readout` | Demos use other markup. `chrome` is excluded from the math count. |
| `demos.candidates[]` | none | Suggest a widget per demo: `{ widget, words?, js?, maxControls? }`. The first candidate whose conditions all hold wins: `words` is matched against the title and hint, `js` against the demo's script, and `maxControls` caps the number of inputs. |
| `quiz.selector`, `quiz.answer` | `details`, `.answer` | `details` is used for something else (collapsible notes), or answers sit in another wrapper. |
| `code.highlightClasses` | none | Syntax-highlight span classes that should be dropped silently (`k`, `n`, `s`…). |
| `code.defaultLanguage` | `text` | Code blocks carry no language class. |
| `svg.palette` | none | Inline SVGs color through CSS variables: `[["--plot-1", "c1"], ["--grid", "grid"]]` maps a variable's color to a figure class. |
| `svg.surfaceVars` | none | Background-colored fills (`--bg`) that should be dropped rather than kept. |

A generic MkDocs-style site (`article.md-content__inner`, admonitions, collapsible `details` notes, Pygments code):

```json
{ "schemaVersion": 1, "language": "en",
  "files": { "exclude": ["^index\\.html$", "^404\\.html$", "^(search|tags)/"] },
  "lesson": { "root": "article.md-content__inner" },
  "quiz": { "selector": "details.quiz" },
  "code": { "highlightClasses": ["k", "n", "o", "p", "s", "s1", "s2", "c1", "nf", "nb", "mi"], "defaultLanguage": "python" } }
```

A course with custom box classes, chips and a demo candidate:

```json
{ "schemaVersion": 1, "language": "vi",
  "boxes": { "boxTypes": { "ai": { "label": "Góc nhìn AI", "color": "c3" } },
             "variants": ["def", "example", "formula", "intuition", "warn", "note", "ai"] },
  "lesson": { "chipRules": [ { "label": "Thời lượng", "to": "meta.duration" },
                             { "label": "Cần biết trước", "to": "prereq", "ref": "Bài\\s*(\\d+)" } ] },
  "demos": { "candidates": [ { "widget": "vector-plane", "words": "vector", "js": "draggable" } ] } }
```

## Course order

`course.order` picks the first usable source, falling back `globals` → `index-links` → `filename` (warning `import/order-fallback`):

- `globals`: records from `course.globals.expr` on `course.globals.page`; `lessonFields` names the record keys for id, file, module and title.
- `index-links`: pages in the order `index.html` links to them.
- `filename`: natural filename order.

Pages that match `files` but are not listed by the chosen order follow in filename order. Links:
- `https://` links are kept.
- A link to another imported page becomes `lesson:<id>`, with `#anchor` when the anchor names a heading there. An unknown anchor is dropped (the link is kept) and counted as `anchor-dropped`.
- An in-page `#anchor` naming a heading is kept.
- Everything else is unwrapped to plain text and counted in `linksUnwrapped`: `http://` links, other schemes, files outside the source, pages that are not lessons, and same-page links without a known anchor.

## Receipt and report

stdout is one JSON line:

```json
{ "schemaVersion": 1, "ok": true, "command": "import", "status": "pass",
  "lessons": { "total": 18, "pass": 18, "fail": 0 },
  "pendingDemos": { "total": 47, "withCandidate": 13 },
  "report": "/abs/target/.learndoc/import/report.json", "commit": "5f5a4fae…",
  "diagnostics": [], "diagnosticSummary": { "total": 0, "shown": 0, "truncated": false }, "durationMs": 23394 }
```

Exit 0 means pass: every lesson, the config and the course passed. Exit 1 means fail: a setup error with `report: null` (`import/target-exists`, `import/target-is-source`, `import/target-inside-source`, `import/profile-invalid` (also for invalid CSS selectors), `json/parse` or `schema/*` in the profile, `import/chrome-missing`, `import/no-pages`: no page matches `files`, or every page was skipped as redirected or empty), or failing gates, whose error diagnostics are included; in that case the project is still written and committed. Exit 64 is a usage error (no source folder, unknown option, `--profile` without a file or with a missing one). Warnings (`import/page-load`, `import/redirected`, `import/empty-page`, `import/asset-*`, `import/order-fallback`, `import/commit-failed`) do not fail the run; skipped pages are not lessons.

`report.json` holds:
- `schemaVersion`, `source`, `order` (the one actually used), `profileSha`, `generatedAt`, `commit`;
- `totals` (lessons, pass, fail, block counts, `math` `{source, output}`, `svg` `{source, output, inDemos}`, demos, `demosWithCandidate`, assets);
- `project` (config and course status);
- `lessons[]`: `id`, `file`, `blocks`, `math` `{source, output}`, `svg` `{source, output, inDemos}`, `demos`, `dropped` and `approx` counts by kind, `linksUnwrapped`, `status`, `gates`, `diagnostics`;
- `pendingDemos[]`: `lesson`, `blockId` (the note box), `demoId`, `title`, `hintText`, `htmlFile`, `jsFile` (null if no script was found), `controls`, `svgs`, `canvases`, `candidate` (`{ widget, reason }` or null), `status` (`pending`; it reflects import time only, since the report is not updated when you later convert a demo).

`svg.source` counts the page's SVGs outside demos (demo SVGs are in `inDemos`). When `math.output` is below `math.source`, or `svg.output` is below `svg.source`, content was lost: fix the profile (usually `lesson.root` or a selector) and import again into a new folder.

## Converting a pending demo

For each demo with a `candidate`:

1. Read **both** demo files, `htmlFile` and `jsFile`, **whole** before deciding. They are small, so this is the exception to "never print whole source pages". Read the widget's entry in the [widget catalog](widget-catalog.md) for its props, and never read the skill's own widget code. The candidate is only a hint from the profile's patterns.
   - List every control, preset and readout the demo has, and everything its hint and the surrounding text mention (for example, both distributions editable, or both KL directions).
   - Convert only if the widget covers all of it, with values taken verbatim from the source: initial vectors, ranges, labels, presets. Otherwise keep the note.
   - Never invent presets, labels or values, and never relabel what a preset acts on.
2. Add the widget block with **one Edit** of `lessons/<lesson>.json`, right after the note box whose `"id"` is `blockId`. Lesson files are canonical 2-space JSON, so match the end of that block exactly. Never Write a whole imported lesson.

   ```json
   { "id": "b-<4-12 new [a-z0-9]>", "type": "widget", "widget": "vector-plane", "props": { … } }
   ```

   Widget blocks have no `sources`, and `props` must match the widget's `propsSchema`. Keep the note box: it holds the original title and hint.
3. Run `finalize lessons/<lesson>.json --json` after each converted lesson; it commits the lesson on pass. Repair per the [delivery contract](delivery-contract.md#repair). If it still fails after the repair limit, remove the widget block the remaining diagnostic names and leave the note.

This is the only allowed edit of imported lesson JSON. Demos without a candidate, or that no widget reproduces, stay as notes.

## Known limits

- Pages that build their content with JavaScript import partially, or are skipped as `import/empty-page`, since scripts are off. Only `course.globals` runs scripts, and only to read the lesson list.
- Math must be KaTeX output with TeX annotations, or raw TeX in `\(…\)`, `\[…\]`, `$…$` or `$$…$$`. MathJax-rendered output without its source is lost.
- iframes, video, audio, `object`, `embed`, forms, remote or `data:` images, and SVGs inside running text are dropped or lifted out; see the `dropped` (`tag:iframe` and so on) and `approx` counts.
- `\textsc{…}` renders as plain text (no small caps).
- `http://` links, links leaving the source folder and links to non-lesson pages become plain text.
- Imported blocks cite nothing; `origin` says where they came from. If the user adds the course's own sources (PDFs, sites) to `references/`, new and edited blocks may cite them. Re-grounding existing blocks is new authoring, only when the user asks.
