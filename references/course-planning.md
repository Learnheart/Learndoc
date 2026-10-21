# Course planning

How to turn a prompt and references into `course.json`, and how to extend an existing course.

## Format

```json
{ "schemaVersion": 1, "title": "Rust Ownership", "description": "One sentence: who it is for and what it covers.",
  "modules": [
    { "id": "basics", "title": "Ownership basics",
      "lessons": [
        { "id": "01-ownership", "title": "Ownership and moves", "summary": "One line the index page shows.",
          "prereq": [], "sources": ["book#p87-95|§4.1"], "status": "planned" },
        { "id": "02-borrowing", "title": "References and borrowing", "summary": "…",
          "prereq": ["01-ownership"], "sources": ["book#p96-104|§4.2", "rustdoc#references-and-borrowing"],
          "status": "planned" } ] } ] }
```

- Module and lesson `id`: slug (`[a-z0-9-]`). For lessons use `NN-short-topic` (two-digit order prefix plus 1–4 words), which is also the file name `lessons/<id>.json`. Ids are permanent once a lesson exists: links and history depend on them, so never rename one.
- `prereq`: only ids of lessons in this course that come earlier; no cycles. Leave it empty when nothing is required.
- `sources`: the page ranges and sections the lesson will draw on, in the same format as block sources (see [authoring contract](authoring-contract.md#sources-and-grounding)). This is your reading list when you write the lesson, so make it specific.
- `status`: `planned` until the lesson file is written, then `done`. Planned lessons appear on the index page but are not links.
- `title` and `summary` are in the `learndoc.json` language.

## Planning steps

1. **Survey, do not read everything.** Plan after `finalize learndoc.json --json` has chunked the references. `references/chunks/<alias>/index.json` lists every Markdown or web heading anchor and every PDF's page count; `sources` may cite only those anchors and pages. For a PDF, read the table of contents and chapter openings (`references/chunks/<alias>/p0005.txt` and so on); for Markdown or web references, read the anchor list. Note which parts cover what the user asked for.
2. **Scope to the request.** Cover what the user asked, in the order a learner needs it. Do not add topics the references do not cover; if the request needs material the references lack, note it in the outline you show the user.
3. **Size the lessons.** One lesson is about 30–60 minutes of reading: roughly 6–12 `h2` sections, grounded in about 5–15 PDF pages or 1–3 Markdown sections, introducing at most 2–3 major concepts. Split a lesson that would exceed this; merge two that are each too thin to fill one.
4. **Group into modules.** 2–8 lessons per module, by theme or stage. A short course can have a single module.
5. **Order and prerequisites.** Each lesson builds only on earlier ones; record real dependencies in `prereq`.
6. **Write `course.json`** with every lesson `planned`, then run `finalize course.json --json`.

## Confirm the outline

When the course has two or more lessons, show the outline before writing any lesson, compactly, in the user's language:

```
Module 1 — Ownership basics
  01 Ownership and moves — book §4.1 (pp. 87–95)
  02 References and borrowing — book §4.2, Rust docs "References and borrowing"
Not covered by the references: async lifetimes (no source given).
Write these lessons?
```

Stop and wait. Apply any change the user asks for to `course.json` (rerun `finalize course.json --json`), then write the lessons in order. With a single lesson, write a one-module, one-lesson `course.json` and continue without asking.

## Adding a lesson

1. Read `learndoc.json` and `course.json`. If the new lesson needs new references, add them to `references/` and `learndoc.json` first (web pages as Markdown snapshots, as in SKILL.md step 2), then run `finalize learndoc.json --json` so they are chunked and their `index.json` exists.
2. Choose its place: an existing module, or a new module when it does not fit any. Give it a new unique id; continue the numbering (`05-…` after `04-…`). Do not renumber or rename existing lessons.
3. Add the entry with `prereq`, `sources` (anchors and pages from the chunk indexes) and `status: "planned"`, and run `finalize course.json --json`. Then write the lesson, set it to `done`, and run `finalize` on the lesson file.
4. Do not edit existing lessons. The new lesson may link to them (`lesson:<id>#anchor`). If an existing lesson should mention the new one, tell the user they can add that in the UI.
5. Ask for confirmation only when the user requested several new lessons at once.
