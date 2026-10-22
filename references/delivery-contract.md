# Delivery contract

How `finalize` checks your files, how to read its receipt, how to repair a failure, and when to serve.

## Finalize

```bash
node <skill-dir>/bin/learndoc.mjs finalize <file> --json
```

learndoc needs Node 22 or newer. Run it from the project root on each file you write, in this order: `learndoc.json` first (this chunks the references; read `references/chunks/<alias>/index.json` for citable anchors and pages before planning), then `course.json`, then each `lessons/<id>.json` as soon as it is written. The target kind follows from the path: `learndoc.json` checks the config; `course.json` checks config and course; `lessons/<id>.json` checks everything.

Gates run in order and stop at the first that does not pass:

| Gate | Checks |
|---|---|
| `validate` | Schema of every file; unique ids; every source alias exists in `learndoc.json`; widget names exist; math uses only `$` and `$$`. |
| `render` | The lesson renders to HTML with the shared renderer (lessons only). |
| `check` | KaTeX parses every formula; tags and classes are in the whitelist; anchors, in-lesson and cross-lesson links and `prereq` resolve; `course.json` matches the files in `lessons/`. |
| `browser-check` | Headless Chrome opens the page: no console errors, and every widget mounts, updates and unmounts cleanly (lessons only). |

The first run in a project also creates `.learndoc/`, runs `git init` when needed, and chunks references into `references/chunks/<alias>/`.

## Receipt

stdout is one JSON line. A real failing receipt (one `}` removed from a formula in a lesson; warnings trimmed):

```json
{ "schemaVersion": 1, "ok": false, "command": "finalize", "status": "fail",
  "target": { "kind": "lesson", "path": "/home/me/course/lessons/03-inner-product-cosine.json", "sha256": "8dba90f5…" },
  "gates": { "validate": "pass", "render": "pass", "check": "fail", "browser-check": "not-run" },
  "failedStage": "check",
  "diagnostics": [
    { "code": "math/katex", "severity": "error",
      "message": "lessons/03-inner-product-cosine.json: block b-81f5e0 html: KaTeX cannot parse \"…\": KaTeX parse error: Unexpected end of input in a macro argument, expected '}' …",
      "subject": { "file": "lessons/03-inner-product-cosine.json", "id": "b-81f5e0", "field": "html" },
      "evidence": { "latex": "\\cos\\omega = … = \\frac{3}{\\sqrt{10} \\approx 0.949 …" },
      "supportedFixes": ["fix the LaTeX so KaTeX can parse it", "write a literal < inside math as \\lt or &lt;"] },
    { "code": "refs/missing-file", "severity": "warning", "message": "reference \"mml\" points to references/mathematics-for-ml.pdf, which does not exist; …",
      "subject": { "reference": "mml", "file": "references/mathematics-for-ml.pdf" }, "supportedFixes": ["…"] } ],
  "diagnosticSummary": { "total": 6, "shown": 6, "truncated": false },
  "artifact": { "path": "/home/me/course/.learndoc/build/03-inner-product-cosine.html", "sha256": "b5857eaa…" },
  "commit": null,
  "nextAction": { "action": "edit-in-place", "file": "/home/me/course/lessons/03-inner-product-cosine.json",
    "constraint": "Apply each diagnostic's supportedFixes (or the fix its message names) to the existing file; keep block ids and unaffected content unchanged; do not rewrite the whole file.",
    "then": "finalize-once" },
  "durationMs": 72 }
```

- `target.path` is absolute. `subject` and `evidence` are objects (`subject` usually has `file`, `id`, `field`).
- `nextAction` appears only when `validate` or `check` failed: edit that file in place, then run `finalize` once.
- Gate values: `pass`, `fail`; `not-run` when an earlier gate failed; `skipped` when the gate does not apply to the target (`render` and `browser-check` for `learndoc.json` and `course.json`) or Chrome/Chromium is missing.
- Warnings do not fail the run. `refs/missing-file` and `refs/unverified` mean a reference file is missing, so its sources could not be checked; tell the user if they named that reference.
- At most 8 diagnostics are shown. When `diagnosticSummary.truncated` is true, `diagnosticSummary.omittedByCode` counts the hidden ones per code; fix the shown ones and rerun.
- On `pass` or `skipped`, `finalize` rewrites a lesson file as canonical 2-space JSON and commits `learndoc.json`, `course.json` and that lesson (message `learndoc: finalize <id>`). Lesson receipts carry `commit`: the new hash, or `null` when the run failed or nothing changed. If committing fails (for example, git has no user name), the run still passes, with warning `project/commit-failed`. Reread the file before editing it again.

| Exit | `status` | Meaning |
|---|---|---|
| 0 | `pass` | All gates passed. |
| 1 | `fail` | A gate failed. Repair. |
| 2 | `skipped` | Content gates passed; `browser-check` could not run because Chrome/Chromium is missing. |
| 64 | – | Usage error: unknown command or option, more than one file, a file that is not `learndoc.json`, `course.json` or `lessons/<id>.json`, or a file that does not exist. Fix the command, not the content. |

## Repair

A non-zero exit other than 2 is never success.

1. Edit the existing file in place, at the block and field named by `subject`. Keep block ids, anchors, sources and the meaning of the content. Do not regenerate the lesson from scratch.
2. Apply a listed `supportedFixes` entry when one fits. Fix schema errors before anything else.
3. Rerun the same `finalize` command.
4. Track each issue by `code` + `subject`. Compare the new receipt by those keys, not by error count; a newly exposed issue starts its own count.
5. An issue that survives two focused repairs: read the rule in the [authoring contract](authoring-contract.md) or [widget catalog](widget-catalog.md) for that field, then make one evidence-based retry. If it still fails, stop and report the concrete gap to the user (which block, which rule) instead of looping.
6. Never fix a failure by deleting sources or content the user asked for, or by weakening a citation. If a block cannot be grounded, remove the claim and say so in your reply.

`browser-check` failures name the widget or console error. Check the widget props against the catalog first; content alone rarely causes a console error.

## Chrome missing

`status: "skipped"` (exit 2) means the lesson is valid but was not checked in a browser. Deliver it, tell the user in one line that the browser check was skipped because Chrome/Chromium was not found, and do not edit content because of it. A browser-check that ran and failed is a failure (exit 1), never "skipped".

## Serve

When every lesson you wrote passes (or is skipped for Chrome only), run once:

```bash
node <skill-dir>/bin/learndoc.mjs serve --lesson <id>
```

It first checks the environment: Node 22 or newer, and `claude --version` (login is not checked; if UI edits fail with an authentication error, the user runs `claude` once to log in). Every failure prints `{ "ok": false, "error": { "code": "…", "message": "…", "fix": "…" } }` and exits 1, with codes such as `env/node`, `env/claude`, `project/missing` (no `learndoc.json` here or above) and `server/start` (the server did not come up; see its log). Relay the message and fix in one line. The lessons stay saved, and the user can ask to reopen them later. Chrome is not needed to serve.

Otherwise it reuses a live server for this project or starts one in the background, opens the OS default browser, and prints one JSON line: `{ "ok": true, "url": "http://127.0.0.1:<port>/?t=<token>", "lessonUrl": "…", "pid", "port", "reused" }`. `lessonUrl` is present only when you passed `--lesson`; otherwise reply with `url` (the course index). The link carries the access token; give it exactly as printed.
