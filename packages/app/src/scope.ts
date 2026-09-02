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
 * Lifetime rank: longer-lived scopes have a lower rank. A provider may only
 * depend on providers of the same or a longer-lived (lower rank) scope.
 */
export const SCOPE_LIFETIME_RANK: Record<Scope, number> = {
  application: 0,
  request: 1,
  job: 1,
};

export function isScopeViolation(from: Scope, to: Scope): boolean {
  return SCOPE_LIFETIME_RANK[to] > SCOPE_LIFETIME_RANK[from];
}
