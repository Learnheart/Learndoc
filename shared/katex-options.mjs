// KaTeX options shared by the check gate (Node) and the lesson page (browser), so both accept the same LaTeX.
// Isomorphic: no node: imports.

// Commands KaTeX lacks, mapped to their closest supported form.
export const KATEX_MACROS = { '\\textsc': '\\text{#1}' };

// strict 'ignore': non-Latin text inside \text{} (e.g. Vietnamese) is valid content, not a warning.
// The macros are copied per call because KaTeX stores \gdef definitions in the object it is given.
export function katexOptions(display, throwOnError) {
  return { displayMode: display, throwOnError, strict: 'ignore', macros: { ...KATEX_MACROS } };
}
