// Diagnostic and receipt helpers shared by finalize and the edit server.

const DIAGNOSTIC_LIMIT = 8;

// -> { code: 'area/kind', severity, message, subject, evidence?, supportedFixes: [] }
export function diagnostic({ code, severity = 'error', message, subject = {}, evidence, supportedFixes = [] }) {
  return {
    code,
    severity,
    message,
    subject,
    ...(evidence && Object.keys(evidence).length ? { evidence } : {}),
    supportedFixes,
  };
}

export const hasErrors = (diagnostics) => diagnostics.some((entry) => entry.severity === 'error');

function subjectKey(subject) {
  return subject && Object.keys(subject).length ? JSON.stringify(subject) : null;
}

// Picks at most `limit` diagnostics, in pick order: one per code, then one per subject, then the rest;
// errors before warnings within each pass.
// -> { diagnostics, diagnosticSummary: { total, shown, truncated, omittedByCode? } }
export function selectDiagnostics(all, limit = DIAGNOSTIC_LIMIT) {
  const ordered = [
    ...all.filter((entry) => entry.severity === 'error'),
    ...all.filter((entry) => entry.severity !== 'error'),
  ];
  const chosen = new Set();
  // Adds entries whose key (when not null) no chosen entry has yet.
  const pickDistinct = (keyOf) => {
    const seen = new Set([...chosen].map(keyOf));
    for (const entry of ordered) {
      if (chosen.size >= limit) return;
      const key = keyOf(entry);
      if (chosen.has(entry) || key === null || seen.has(key)) continue;
      seen.add(key);
      chosen.add(entry);
    }
  };
  pickDistinct((entry) => entry.code);
  pickDistinct((entry) => subjectKey(entry.subject));
  for (const entry of ordered) {
    if (chosen.size >= limit) break;
    chosen.add(entry);
  }
  const diagnostics = [...chosen];
  const truncated = all.length > diagnostics.length;
  const summary = { total: all.length, shown: diagnostics.length, truncated };
  if (truncated) {
    const omitted = {};
    for (const entry of ordered) {
      if (!chosen.has(entry)) omitted[entry.code] = (omitted[entry.code] || 0) + 1;
    }
    summary.omittedByCode = omitted;
  }
  return { diagnostics, diagnosticSummary: summary };
}
