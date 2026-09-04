/**
 * Normalizes a URL path by stripping duplicate slashes and ensuring single leading slash.
 * Modeled directly after Angular's Location.normalize in @angular/common.
 */
export function normalizePath(path: string): string {
  if (!path) return "/";
  const clean = path.replace(/\/+/g, "/");
  return clean.startsWith("/") ? clean : `/${clean}`;
}

/**
 * Strips the trailing slash from a URL path, unless the path is root '/'.
 * Modeled directly after Angular's Location.stripTrailingSlash.
 */
export function stripTrailingSlash(path: string): string {
  if (!path || path === "/") return "/";
  return path.replace(/\/+$/, "");
}

/**
 * Joins two path parts with a single slash.
 * Modeled directly after Angular's Location.joinWithSlash.
 */
export function joinWithSlash(start: string, end: string): string {
  if (!start) return end.startsWith("/") ? end : `/${end}`;
  if (!end) return start;
  const s = stripTrailingSlash(start);
  const e = end.startsWith("/") ? end.slice(1) : end;
  return `${s}/${e}`;
}
