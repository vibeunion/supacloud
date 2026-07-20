export const SUPAOAUTH_DELEGATION_HEADERS = [
  "x-supaoauth-actor-id",
  "x-supaoauth-actor-type",
  "x-supaoauth-actor-timestamp",
  "x-supaoauth-body-sha256",
  "x-supaoauth-actor-nonce",
  "x-supaoauth-actor-signature",
] as const;

export function hasSupaOAuthDelegationHeaders(request: Request): boolean {
  return SUPAOAUTH_DELEGATION_HEADERS.some((header) => request.headers.has(header));
}
