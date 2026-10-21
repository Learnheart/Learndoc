# Third-party notices

The learndoc MIT license (see `LICENSE`) covers learndoc's own code and content. The components
below keep their own licenses. Their license files must stay next to the vendored copies.

## KaTeX 0.16.47

- Use: math rendering in the browser runtime and formula parsing in `finalize`.
- Location: `runtime/vendor/katex/` (vendored from katex 0.16.47; keep its `LICENSE` file there).
- License: MIT. Copyright (c) 2013-2020 Khan Academy and other contributors.
- Source: https://github.com/KaTeX/KaTeX

## pdf.js (pdfjs-dist 6.1.200)

- Use: text extraction from PDF references in Node (`lib/refs.mjs`).
- Location: `runtime/vendor/pdfjs/` (legacy build of pdfjs-dist 6.1.200; keep its `LICENSE` file there).
- License: Apache License 2.0. Copyright Mozilla Foundation and pdf.js contributors.
- Source: https://github.com/mozilla/pdf.js

## Archify (portions)

- Use: the Chrome discovery and DevTools pipe (CDP) helper in `lib/chrome.mjs` is ported from
  Archify, and the approach of generating committed schema validators (`scripts/generate-validators.mjs`)
  follows Archify's.
- License: MIT. Copyright (c) 2026 tt-a1i (Archify); Copyright (c) 2025 Cocoon AI.
- Source: https://github.com/tt-a1i/archify

Archify's MIT license text:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
