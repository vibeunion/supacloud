import { isIP } from "node:net";

const requestPeerAddresses = new WeakMap<Request, string>();

function normalizedIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let candidate = value.trim().replace(/^"|"$/g, "").replace(/^\[|\]$/g, "");
  if (candidate.toLowerCase().startsWith("::ffff:") && isIP(candidate.slice(7)) === 4) {
    candidate = candidate.slice(7);
  }
  return isIP(candidate) ? candidate : null;
}

function trustedProxyAddresses(): Set<string> {
  const configured = process.env.SUPACLOUD_TRUSTED_PROXY_IPS ?? "127.0.0.1,::1";
  return new Set(
    configured.split(",")
      .map((value) => normalizedIp(value))
      .filter((value): value is string => Boolean(value)),
  );
}

export function recordRequestPeerAddress(
  request: Request,
  peerAddress: string | null | undefined,
): void {
  const normalized = normalizedIp(peerAddress);
  if (normalized) requestPeerAddresses.set(request, normalized);
}

/** Return only the socket peer reported by Bun, never a forwarded header. */
export function resolveRequestPeerAddress(request: Request): string {
  return requestPeerAddresses.get(request) ?? "unknown";
}

/**
 * Resolve the address appended by the local reverse proxy.
 *
 * Caddy appends the browser peer to the right side of X-Forwarded-For. Those
 * headers are considered only when Bun reports an explicitly trusted direct
 * proxy; direct clients are always keyed by their socket peer address.
 */
export function resolveProxyClientIp(
  request: Request,
  directPeerAddress?: string | null,
): string {
  const directPeer = normalizedIp(directPeerAddress)
    ?? requestPeerAddresses.get(request)
    ?? null;
  if (!directPeer) return "unknown";
  if (!trustedProxyAddresses().has(directPeer)) return directPeer;

  const forwarded = request.headers.get("x-forwarded-for")
    ?.split(",")
    .map((part) => normalizedIp(part))
    .filter((part): part is string => Boolean(part));
  return forwarded?.at(-1)
    || normalizedIp(request.headers.get("x-real-ip"))
    || directPeer;
}
