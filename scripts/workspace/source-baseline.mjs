/** A reviewed debt budget, not permission to skip scans or hide existing findings. */
const fingerprint = /^[a-f0-9]{64}$/;
export function findingKey(finding) {
  if (!finding || typeof finding.code !== 'string' || typeof finding.file !== 'string' || !fingerprint.test(finding.fingerprint ?? '')) {
    throw new Error('Source finding has no stable identity. Run the current source scanner.');
  }
  return JSON.stringify([finding.code, finding.file, finding.specifier ?? null, finding.fingerprint]);
}

export function evaluateSourceBaseline(report, baseline) {
  if (report?.schemaVersion !== 1 || !Number.isInteger(report.filesScanned) || report.filesScanned < 1 ||
      !Array.isArray(report.diagnostics) || !Array.isArray(report.notes)) throw new Error('Missing or empty source inventory.');
  if (baseline?.schemaVersion !== 1 || !Array.isArray(baseline.entries)) throw new Error('Invalid source baseline schema.');
  const budgets = new Map();
  for (const entry of baseline.entries) {
    const key = findingKey(entry);
    if (budgets.has(key) || !Number.isInteger(entry.count) || entry.count < 1 || typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error(`Invalid, duplicated, or undocumented source budget: ${entry.file}`);
    }
    budgets.set(key, { ...entry, seen: 0 });
  }
  const existing = [];
  const introduced = [];
  for (const finding of [...report.diagnostics, ...report.notes]) {
    const budget = budgets.get(findingKey(finding));
    if (budget && ++budget.seen <= budget.count) existing.push({ ...finding, reason: budget.reason });
    else introduced.push(finding);
  }
  return {
    schemaVersion: 1, policy: 'no-new-source-findings', clean: report.diagnostics.length === 0 && report.notes.length === 0,
    passed: introduced.length === 0, filesScanned: report.filesScanned, existing, introduced,
    // Missing generated configs can legitimately disappear after a framework sync.
    retired: [...budgets.values()].filter((entry) => entry.seen < entry.count)
      .map(({ seen, ...entry }) => ({ ...entry, remainingCount: Math.max(0, seen) })),
  };
}
