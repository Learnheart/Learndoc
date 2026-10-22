---
name: learndoc
description: "Use when the user wants to create, extend, reopen or edit interactive learning material (course, lesson, tutorial, study notes) built from a prompt and references (PDF, Markdown, web pages) on any topic. Produces typed lesson JSON with formulas, figures, interactive demos and quizzes, every block cited to the exact page or section of its source, and opens it in a local browser UI where the user edits by selecting text and prompting. Also use when the user asks to change an existing learndoc lesson ('sửa đoạn 2 của bài 03', 'viết lại phần định nghĩa', 'thêm ví dụ vào bài 2'): edits go through the browser UI. Also 'tạo bài học', 'tạo tài liệu học', 'tạo khoá học', 'soạn bài giảng từ PDF', 'thêm bài vào khoá học', 'mở lại bài học'. Not for slide decks or single static documents without editing."
license: MIT
metadata:
  version: "0.1.0"
---

# Learndoc

Turn a prompt plus references into a course of interactive lessons, validate them, and open them in a local editor UI.

The user works in two places only: this CLI (create a course or lesson, add a lesson, reopen the UI) and the browser UI (every edit, preview, accept/cancel, history). The user never types learndoc commands. You run two internal commands:

```bash
node <skill-dir>/bin/learndoc.mjs finalize <file> --json
node <skill-dir>/bin/learndoc.mjs serve [--lesson <id>]
```

`<skill-dir>` is the absolute path of this skill's base directory, shown when the skill loads ("Base directory for this skill"). The skill may be installed under any folder name, globally or inside a project's `.claude/skills/`, so never assume a fixed path. The skill's own files (the contracts linked below as `references/*.md`, and `schemas/`) live under `<skill-dir>`; project paths such as `references/<your-source>.md`, `references/chunks/` or `lessons/` are relative to the project root.

## Working folder

The project is the current working directory unless the user names another folder. One project is one course: `learndoc.json` (config), `course.json` (outline), `lessons/<id>.json` (one file per lesson), `references/` (sources), `assets/` (figure images). Run commands from the project root. `finalize` creates `.learndoc/`, initializes git when needed and chunks references; do not create these yourself. Write every JSON file directly with the Write tool. Never create helper scripts, and never write files outside the project.

## Router

| User intent | Do |
|---|---|
| Create a course, lesson, tutorial or study notes (no `learndoc.json` yet) | Fast path below. |
| Add a lesson to an existing course | [Course planning → Adding a lesson](references/course-planning.md#adding-a-lesson), then fast path steps 5–8 for the new lesson. |
| Reopen the UI ("mở lại bài học", `/learndoc` with no task) | Run `serve` and reply with its `url` (the course index), titled with the course title from `course.json`; when the user names a lesson, run `serve --lesson <id>` and reply with `lessonUrl`, titled with that lesson's title. |
| Change an existing lesson ("sửa đoạn 2 của bài 03") | Do not edit lesson JSON. Run `serve --lesson <id>` and tell the user to select the passage in the page and type the request there. The page opens at the lesson, not at the block. |
| A new course on another topic while `learndoc.json` exists | Ask whether to use a new folder; one project holds one course. |

## Fast path

1. **Prepare.** Read the [authoring contract](references/authoring-contract.md) and the [widget catalog](references/widget-catalog.md).
2. **Gather references.** Read the files the user names and keep them under `references/`; copy files from outside the project, never move them. For each URL, fetch the page, save a Markdown snapshot that keeps its headings to `references/web/<slug>.md`, and record `type: "web"`, `url` and `fetchedAt` (today). If the user gave no references, ask once; if they want you to find sources, snapshot reputable pages the same way. For a long PDF, read the table of contents first.
3. **Write `learndoc.json`** as described in the [authoring contract](references/authoring-contract.md#learndocjson), asking only when information is truly missing. Then run `finalize learndoc.json --json`: it chunks the references. Read `references/chunks/<alias>/index.json` for the exact heading anchors and page counts you may cite.
4. **Plan.** Read [course planning](references/course-planning.md). Write `course.json`, citing only anchors and pages from those indexes, and run `finalize course.json --json`. For two or more lessons, every lesson starts `planned`: show the outline and wait for confirmation before writing any lesson. For one lesson, continue without asking.
5. **Write each lesson.** Read only the pages or sections in its `sources`, write `lessons/<id>.json` and set its status to `done`. State nothing the references do not support; if they lack something the user asked for, leave it out and say so.
6. **Finalize** each lesson as soon as it is written: `finalize lessons/<id>.json --json`. Exit 0 passes. Exit 2 (browser check skipped, Chrome missing) is deliverable; tell the user and do not edit content for it. Any other exit: follow the [delivery contract](references/delivery-contract.md), including its repair limit.
7. **Serve** once every lesson passes: `serve --lesson <first new lesson id>`. It opens the default browser and prints one JSON line; use its `lessonUrl` (present only with `--lesson`). A running server is reused and picks up new lessons.
8. **Reply** per Output.

`references/edit-contract.md` is the edit server's system prompt; do not read it while generating.

## Setup

Nothing to install: no `npm install`, no API key. learndoc needs Node 22 or newer (both `finalize` and `serve`) and the `claude` CLI, which the UI uses for edits. `serve` checks Node and `claude --version` on start; it does not check login. If edits in the UI fail with an authentication error, the user runs `claude` once to log in. Every `serve` failure prints `{ "ok": false, "error": { "code", "message", "fix" } }` (codes such as `env/node`, `env/claude`, `project/missing`, `server/start`) and exits 1: relay the message and fix in one line. Chrome or Chromium is used only by `finalize`'s browser check; without it that gate is skipped.

## Output

The final reply is exactly one line in the user's language: a Markdown link to the URL from `serve`. The link text is the lesson title (with `--lesson`) or the course title from `course.json` (without it), never the folder name. Nothing else: no greeting, summary, hints, recap of commands, receipts or files, and no second sentence. The only addition allowed, on the same line after ` — `, is a few words when the browser check was skipped or the references did not cover something the user asked for.

Example: `Đã tạo [Commits and Branches](http://127.0.0.1:51234/lessons/01-commits-and-branches?t=…).`
