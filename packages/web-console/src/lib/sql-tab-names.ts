export type NamedSqlTab = {
  id: string;
  name: string;
};

function normalizedTabName(name: string): string {
  return name.trim().toLowerCase();
}

export function nextSqlTabName(tabs: NamedSqlTab[], untitledName: string): string {
  const names = new Set(tabs.map((tab) => normalizedTabName(tab.name)));

  // Start at one and fill the first unused suffix so restored tabs remain easy to distinguish.
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${untitledName} ${suffix}`;
    if (!names.has(normalizedTabName(candidate))) return candidate;
  }
}

export function isSqlTabNameAvailable(
  tabs: NamedSqlTab[],
  tabId: string,
  candidate: string,
): boolean {
  const normalizedCandidate = normalizedTabName(candidate);
  return !tabs.some(
    (tab) => tab.id !== tabId && normalizedTabName(tab.name) === normalizedCandidate,
  );
}
