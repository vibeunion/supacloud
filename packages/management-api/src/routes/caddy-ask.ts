import { Elysia, t } from "elysia";
import {
  caddyDomainAllowlistService,
  type CaddyDomainAuthorization,
} from "../services/caddy-domain-allowlist.service";
import { logAuditEvent } from "../services/audit.service";
import { resolveRequestPeerAddress } from "../utils/client-ip";

type CaddyAllowlist = {
  authorize(domain: string): Promise<CaddyDomainAuthorization>;
};

type CaddyAskRoutesOptions = {
  allowlist?: CaddyAllowlist;
  audit?: (input: Parameters<typeof logAuditEvent>[0]) => Promise<void>;
  resolvePeerAddress?: (request: Request) => string;
  maxRequestsPerWindow?: number;
  requestWindowMs?: number;
  now?: () => number;
};

type RequestBucket = {
  count: number;
  resetAt: number;
};

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hasForwardedClientAddress(request: Request): boolean {
  return [
    "forwarded",
    "x-forwarded-for",
    "x-real-ip",
    "cf-connecting-ip",
    "true-client-ip",
  ].some((header) => Boolean(request.headers.get(header)?.trim()));
}

function isLoopbackPeer(peerAddress: string): boolean {
  return peerAddress === "127.0.0.1" || peerAddress === "::1";
}

function responseText(result: CaddyDomainAuthorization): string {
  if (result.allowed) return "ok";
  if (result.reason === "invalid") return "invalid domain";
  if (result.reason === "blocked") return "domain blocked for auto TLS";
  if (result.reason === "quota_exceeded") return "domain authorization quota exceeded";
  return "domain not allowed";
}

export function createCaddyAskRoutes(options: CaddyAskRoutesOptions = {}) {
  const allowlist = options.allowlist ?? caddyDomainAllowlistService;
  const audit = options.audit ?? logAuditEvent;
  const resolvePeerAddress = options.resolvePeerAddress ?? resolveRequestPeerAddress;
  const maxRequestsPerWindow = positiveInteger(
    options.maxRequestsPerWindow ?? process.env.CADDY_ASK_MAX_REQUESTS_PER_MINUTE,
    600,
  );
  const requestWindowMs = positiveInteger(options.requestWindowMs, 60_000);
  const now = options.now ?? Date.now;
  let requestBucket: RequestBucket | null = null;

  function takeRequestQuota(): { limited: boolean; retryAfterSeconds?: number } {
    const timestamp = now();
    if (!requestBucket || requestBucket.resetAt <= timestamp) {
      requestBucket = { count: 1, resetAt: timestamp + requestWindowMs };
      return { limited: false };
    }
    if (requestBucket.count >= maxRequestsPerWindow) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(1, Math.ceil((requestBucket.resetAt - timestamp) / 1000)),
      };
    }
    requestBucket.count += 1;
    return { limited: false };
  }

  return new Elysia({ name: "caddy-ask-routes" }).get(
    "/v1/gateway/caddy/ask",
    async ({ query, request }) => {
      const peerAddress = resolvePeerAddress(request);
      const forwardedClient = hasForwardedClientAddress(request);
      if (!isLoopbackPeer(peerAddress) || forwardedClient) {
        await audit({
          request,
          status: 403,
          action: "caddy_tls_ask_peer_denied",
          metadata: { peerAddress, forwardedClient },
        });
        return new Response("local Caddy requests only", { status: 403 });
      }

      const requestQuota = takeRequestQuota();
      if (requestQuota.limited) {
        await audit({
          request,
          status: 429,
          action: "caddy_tls_ask_rate_limited",
          metadata: { reason: "endpoint_quota" },
        });
        return new Response("domain authorization quota exceeded", {
          status: 429,
          headers: { "retry-after": String(requestQuota.retryAfterSeconds) },
        });
      }

      const rawDomain = query.domain || query.host || "";
      const result = await allowlist.authorize(rawDomain);
      const action = result.allowed
        ? "caddy_tls_ask_allowed"
        : result.reason === "quota_exceeded"
          ? "caddy_tls_ask_rate_limited"
          : "caddy_tls_ask_denied";
      await audit({
        request,
        status: result.status,
        action,
        metadata: { domain: result.domain, reason: result.reason },
      });
      const headers = result.allowed || !result.retryAfterSeconds
        ? undefined
        : { "retry-after": String(result.retryAfterSeconds) };
      return new Response(responseText(result), { status: result.status, headers });
    },
    {
      query: t.Object({
        domain: t.Optional(t.String({ maxLength: 512 })),
        host: t.Optional(t.String({ maxLength: 512 })),
      }),
      detail: { tags: ["gateway"], summary: "Authorize Caddy On-Demand TLS domain" },
    },
  );
}

export const caddyAskRoutes = createCaddyAskRoutes();
