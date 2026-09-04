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
  let common = 0;
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
