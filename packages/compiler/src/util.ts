/**
 * Token name -> key in services object.
 * CASE_REPOSITORY -> caseRepository, LOGGER -> logger (convert CONSTANT_CASE to camelCase),
 * CaseService -> caseService (lowercase first letter of PascalCase).
 */
export function camelName(token: string): string {
  const isConstantCase = token.includes("_") || !/[a-z]/.test(token);
  if (isConstantCase) {
    return token
      .toLowerCase()
      .split("_")
      .filter((part) => part.length > 0)
      .map((part, index) =>
        index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
      )
      .join("");
  }
  return token.charAt(0).toLowerCase() + token.slice(1);
}

/** Computes relative import path from fromDir to toFile (stripping extension, ensuring ./ or ../ prefix). */
export function relativeImportPath(fromDir: string, toFile: string): string {
  const fromParts = fromDir.split("/").filter(Boolean);
  const toParts = toFile.split("/").filter(Boolean);
  let common: number = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }
  const ups = fromParts.length - common;
  const downs = toParts.slice(common);
  const last = downs[downs.length - 1]?.replace(/\.(ts|tsx|js|mts|cts)$/, "") ?? "";
  const segments = [...Array<string>(ups).fill(".."), ...downs.slice(0, -1), last];
  const joined = segments.join("/");
  return joined.startsWith("..") ? joined : `./${joined}`;
}

/** String names of built-in context tokens (aligned with REQUEST_CONTEXT/JOB_CONTEXT in @supacloud/app). */
export const REQUEST_CONTEXT_TOKEN_NAME = "supacloud.request-context";
export const JOB_CONTEXT_TOKEN_NAME = "supacloud.job-context";

/** Determines whether token is built-in request context (variable name REQUEST_CONTEXT or matching token name). */
export function isRequestContextToken(
  token: string,
  tokenNames?: Record<string, string>,
): boolean {
  return token === "REQUEST_CONTEXT" || tokenNames?.[token] === REQUEST_CONTEXT_TOKEN_NAME;
}

/** Determines whether token is built-in job context. */
export function isJobContextToken(
  token: string,
  tokenNames?: Record<string, string>,
): boolean {
  return token === "JOB_CONTEXT" || tokenNames?.[token] === JOB_CONTEXT_TOKEN_NAME;
}

/** Normalizes and combines controller path and route path. */
export function joinRoutePaths(prefix: string, path: string): string {
  const joined = `${prefix}/${path}`.replace(/\/{2,}/g, "/");
  const normalized = joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
  return normalized;
}

/** Finds the closest match from a list of candidate strings (case/delimiter-insensitive). */
export function findClosestMatch(target: string, candidates: string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const targetNorm = norm(target);
  for (const c of candidates) {
    if (norm(c) === targetNorm) return c;
  }
  for (const c of candidates) {
    if (norm(c).includes(targetNorm) || targetNorm.includes(norm(c))) return c;
  }
  return candidates[0];
}
