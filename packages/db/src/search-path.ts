/** SECURITY DEFINER functions must use an explicit, non-dynamic search path. */
export function isSafeDefinerSearchPath(config: unknown): boolean {
  const searchPaths = Array.isArray(config)
    ? config.filter((item): item is string => typeof item === "string" && item.startsWith("search_path="))
    : [];
  if (searchPaths.length !== 1) return false;
  const searchPath = searchPaths[0]!.slice("search_path=".length).trim();
  const searchSchemas = searchPath.split(",").map((item) => item.trim().replace(/^"|"$/g, ""));
  return searchSchemas.length > 0 && searchSchemas.every((item) => {
    const normalized = item.toLowerCase();
    return normalized !== "" && normalized !== "pg_temp" && normalized !== "$user";
  });
}
