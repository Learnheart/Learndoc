import assert from 'node:assert/strict';
import test from 'node:test';
import katex from '../../runtime/vendor/katex/katex.mjs';
import { KATEX_MACROS, katexOptions } from '../../shared/katex-options.mjs';

test('katexOptions: display, throwOnError, strict ignore and a fresh copy of the macros', () => {
  const options = katexOptions(true, false);
  assert.deepEqual(options, { displayMode: true, throwOnError: false, strict: 'ignore', macros: KATEX_MACROS });
  assert.notEqual(options.macros, KATEX_MACROS);
  assert.notEqual(katexOptions(false, true).macros, options.macros);
});

test('\\textsc renders through the macro, and \\gdef in one call does not leak into the next', () => {
  assert.match(katex.renderToString('\\textsc{Adam}', katexOptions(false, true)), /Adam/);
  katex.renderToString('\\gdef\\foo{x}\\foo', katexOptions(false, true));
  assert.throws(() => katex.renderToString('\\foo', katexOptions(false, true)), /Undefined control sequence/);
  assert.deepEqual(KATEX_MACROS, { '\\textsc': '\\text{#1}' });
});
