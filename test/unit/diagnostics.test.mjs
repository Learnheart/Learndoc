import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnostic, hasErrors, selectDiagnostics } from '../../lib/diagnostics.mjs';

test('diagnostic normalizes defaults and drops empty evidence', () => {
  assert.deepEqual(diagnostic({ code: 'a/b', message: 'm', evidence: {} }), { code: 'a/b', severity: 'error', message: 'm', subject: {}, supportedFixes: [] });
  assert.equal(hasErrors([diagnostic({ code: 'a/b', message: 'm', severity: 'warning' })]), false);
});

test('selectDiagnostics: ≤ 8, one per code first, errors before warnings, omitted counts', () => {
  const all = [
    diagnostic({ code: 'w/x', severity: 'warning', message: 'w' }),
    ...Array.from({ length: 9 }, (_, i) => diagnostic({ code: 'e/a', message: `a${i}`, subject: { id: i < 2 ? 'same' : `id${i}` } })),
    diagnostic({ code: 'e/b', message: 'b' }),
  ];
  const { diagnostics, diagnosticSummary } = selectDiagnostics(all);
  assert.deepEqual(diagnostics.map((d) => d.message), ['a0', 'b', 'w', 'a2', 'a3', 'a4', 'a5', 'a6']);
  assert.deepEqual(diagnosticSummary, { total: 11, shown: 8, truncated: true, omittedByCode: { 'e/a': 3 } });
  assert.deepEqual(selectDiagnostics([]).diagnosticSummary, { total: 0, shown: 0, truncated: false });
});
