type ProjectApiDescriptor = {
  api?: { url?: unknown } | null;
  endpoint?: unknown;
};

function normalizeHttpUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return "";
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return "";
    if (parsed.username || parsed.password) return "";
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function getProjectApiUrl(project: ProjectApiDescriptor | null | undefined): string {
  if (!project) return "";
  return normalizeHttpUrl(project.api?.url) || normalizeHttpUrl(project.endpoint);
}
