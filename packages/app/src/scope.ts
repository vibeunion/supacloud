/**
 * Provider lifetime scopes.
 *
 * `application` providers live for the whole function instance and must never
 * depend on shorter-lived `request` / `job` providers. `request` providers are
 * created per HTTP request, `job` providers per background task execution.
 */
export const SCOPES = ["application", "request", "job"] as const;

export type Scope = (typeof SCOPES)[number];

export const DEFAULT_SCOPE: Scope = "application";

/**
 * Relative lifetime for diagnostics. Request and job have equal duration rank
 * but are sibling scopes; use isScopeViolation to check dependency compatibility.
 */
export const SCOPE_LIFETIME_RANK: Record<Scope, number> = {
  application: 0,
  request: 1,
  job: 1,
};

export function isScopeViolation(from: Scope, to: Scope): boolean {
  return to !== "application" && from !== to;
}
