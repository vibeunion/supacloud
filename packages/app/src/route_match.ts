/**
 * Result of matching a URL against a route pattern.
 * Modeled after Angular Router's UrlMatcher / UrlSegment matching.
 */
export interface RouteMatchResult {
  matched: boolean;
  params: Record<string, string>;
  remainingUrl?: string;
}

/**
 * Matches a URL against a parameterized route pattern (e.g. `/users/:id/edit`).
 * Supports Angular-style `pathMatch: "full" | "prefix"`.
 */
export function matchRoute(
  pattern: string,
  url: string,
  strategy: "full" | "prefix" = "full",
): RouteMatchResult {
  const patternSegments = pattern.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const cleanUrl = url.split("?")[0].replace(/^\/+|\/+$/g, "");
  const urlSegments = cleanUrl.split("/").filter(Boolean);

  if (strategy === "full" && patternSegments.length !== urlSegments.length) {
    return { matched: false, params: {} };
  }
  if (strategy === "prefix" && urlSegments.length < patternSegments.length) {
    return { matched: false, params: {} };
  }

  const params: Record<string, string> = {};

  for (let i = 0; i < patternSegments.length; i += 1) {
    const p = patternSegments[i];
    const u = urlSegments[i];
    if (p.startsWith(":")) {
      const paramName = p.slice(1);
      params[paramName] = decodeURIComponent(u);
    } else if (p !== u) {
      return { matched: false, params: {} };
    }
  }

  const remainingSegments = urlSegments.slice(patternSegments.length);
  const remainingUrl = remainingSegments.length > 0 ? `/${remainingSegments.join("/")}` : undefined;

  return {
    matched: true,
    params,
    remainingUrl,
  };
}
