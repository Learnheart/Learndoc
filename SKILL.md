---
name: learndoc
description: "Use when the user wants to create, extend, reopen or edit interactive learning material (course, lesson, tutorial, study notes) built from a prompt and references (PDF, Markdown, web pages) on any topic. Produces typed lesson JSON with formulas, figures, interactive demos and quizzes, every content block cited to the exact page or section of its source, and opens it in a local browser UI where the user edits by selecting text and prompting. Also use when the user asks to change an existing learndoc lesson ('sửa đoạn 2 của bài 03', 'viết lại phần định nghĩa', 'thêm ví dụ vào bài 2'): edits go through the browser UI. Also 'tạo bài học', 'tạo tài liệu học', 'tạo khoá học', 'soạn bài giảng từ PDF', 'thêm bài vào khoá học', 'mở lại bài học'. Also use to convert existing material into learndoc: 'chuyển khoá học HTML sang learndoc', 'import tài liệu có sẵn', 'convert my existing HTML course/pages'. Not for slide decks or single static documents without editing."
license: MIT
metadata:
  version: "0.1.0"
---

# Learndoc

Turn a prompt plus references, or an existing HTML course, into interactive lessons, validate them, and open them in a local editor UI.

The user works only in this CLI (create, import or extend a course, reopen the UI) and the browser UI (edits, preview, accept/cancel, history), and never types learndoc commands. You run three internal commands:

```bash
node <skill-dir>/bin/learndoc.mjs finalize <file> --json
node <skill-dir>/bin/learndoc.mjs serve [--lesson <id>]
node <skill-dir>/bin/learndoc.mjs import <source-dir> --json
```

`<skill-dir>` is this skill's base directory, shown when the skill loads ("Base directory for this skill"); never assume a fixed path or folder name. The contracts (`references/*.md`) and `schemas/` live under it; project paths (`.learndoc/refs/`, `lessons/`) are relative to the project root.

## Working folder

The project is the current working directory unless the user names another folder. One project is one course: `learndoc.json` (config), `course.json` (outline), `lessons/<id>.json`, `references/` (sources), `assets/` (images). Run commands from the project root. `finalize` creates `.learndoc/`, initializes git and chunks references; do not create these yourself. Write new JSON files with the Write tool. Never create helper scripts, and never write files outside the project.

## Router

| User intent | Do |
|---|---|
| Create a course, lesson, tutorial or study notes (no `learndoc.json` yet) | Fast path. |
| Existing HTML pages or course to convert | Import flow. Never rewrite the content yourself. |
| Add a lesson to an existing course | [Course planning → Adding a lesson](references/course-planning.md#adding-a-lesson), then fast path steps 5–8. |
| Reopen the UI ("mở lại bài học", `/learndoc` with no task) | `serve` (or `serve --lesson <id>` when the user names a lesson), then reply per Output. |
| Change an existing lesson ("sửa đoạn 2 của bài 03") | Do not edit lesson JSON. Run `serve --lesson <id>` and tell the user to select the passage in the page and type the request there (for a typo or a word, **Edit directly** lets them type it themselves); the page opens at the lesson, not the block. |
| A new course on another topic while `learndoc.json` exists | Ask whether to use a new folder. |

## Fast path

1. **Prepare.** Read the [authoring contract](references/authoring-contract.md) and the [widget catalog](references/widget-catalog.md).
2. **Gather references.** Read the files the user names and keep them under `references/`; copy files from outside the project, never move them. For each URL, save a Markdown snapshot that keeps its headings to `references/web/<slug>.md`, with `type: "web"`, `url` and `fetchedAt` (today). If the user gave no references, ask once; if they want you to find sources, snapshot reputable pages the same way. For a long PDF, read the table of contents first.
3. **Write `learndoc.json`** ([format](references/authoring-contract.md#learndocjson)), asking only when information is truly missing. Run `finalize learndoc.json --json`, which indexes the references, then read `.learndoc/refs/<alias>.json` for the anchors and pages you may cite. Each Markdown anchor carries `lines: [from, to]` in the reference file itself: read just that range (Read with offset and limit) instead of the whole file. A PDF's text is in the index's `pagesFile`, page N on lines `pageLines[N-1]`.
4. **Plan.** Read [course planning](references/course-planning.md). Write `course.json`, citing only those anchors and pages, and run `finalize course.json --json`. With two or more lessons, all start `planned`: show the outline and wait for confirmation. With one lesson, continue.
5. **Write each lesson.** Read only the pages or sections in its `sources`, write `lessons/<id>.json` and set its status to `done`. State nothing the references do not support; if they lack something the user asked for, leave it out and say so.
6. **Finalize** each lesson right away: `finalize lessons/<id>.json --json`. Exit 0 passes; exit 2 (Chrome missing, browser check skipped) is deliverable, so do not edit content for it. Otherwise follow the [delivery contract](references/delivery-contract.md) and its repair limit.
7. **Serve** when all pass: `serve --lesson <first new lesson id>`. A running server is reused.
8. **Reply** per Output.

## Import flow

Follow the [import contract](references/import-contract.md#import-flow). In short:
1. Target an empty folder. If the working directory is the source folder or inside it, create the sibling `<source-folder-name>-learndoc` (ask if it exists). Read `index.html` and one lesson page (Read limit ~150 lines, or one small grep); never print whole source pages or read the skill's code.
2. Write `import-profile.json` only for what the defaults miss.
3. Run `import <source-dir> --json`. On failure fix the profile, never the lessons, or report when the source itself is at fault.
4. Demos with a candidate: read both demo files whole; convert with one Edit (the only allowed edit of imported lessons) only if the widget covers every control, preset and readout with values from the source, then `finalize` that lesson. Others stay notes; don't ask.
5. `serve`, then reply per Output.

`references/edit-contract.md` is the edit server's system prompt; do not read it while generating.

## Setup

Nothing to install: no `npm install`, no API key. learndoc needs Node 22+ and the `claude` CLI, which the UI uses for edits. `serve` checks both (`claude --version`, not login; on an authentication error in the UI, the user runs `claude` once). A `serve` failure prints `{ "ok": false, "error": { "code", "message", "fix" } }` and exits 1: relay message and fix in one line. Chrome or Chromium is required by `import` and by PDF export; without it, `finalize` skips its browser check.

Every finalize, accept and server start also writes self-contained read-only pages to `html/` and a launcher (`Mở khoá học.command`, or `Open course.command` for an English course) in the course folder. If the user asks how to open the course without Claude, point them to those two. Never mention them in the Output line. For PDF, point them to the **Export PDF** button in the page's top bar (one lesson; on the course page, every lesson zipped); it needs the server and Chrome.

## Output

The final reply is exactly one line in the user's language: a Markdown link to the `serve` URL (`lessonUrl` with `--lesson`, else `url`). The link text is that lesson's title or the course title from `course.json`, never the folder name. Nothing else: no greeting, summary, hints, recap or second sentence. The only addition, on the same line after ` — `, is a few words when the browser check was skipped, the references did not cover something the user asked for, or, after an import, the folder you created, demos kept as notes, and pages skipped (`import/empty-page`, `import/redirected`) when N > 0 (` — ../khoa-hoc-learndoc, 41 demo giữ dạng ghi chú, 2 trang bị bỏ qua (dựng bằng JavaScript/chuyển hướng)`).

Example: `Đã tạo [Commits and Branches](http://127.0.0.1:51234/lessons/01-commits-and-branches?t=…).`
