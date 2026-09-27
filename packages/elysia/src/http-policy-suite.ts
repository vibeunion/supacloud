import {
  ApplicationError, createSupaCloudRequestContext, type SupaCloudRequestContext,
} from "./index";
import { createSupAuthRequestContext, type SupAuthContextOptions, type SupAuthRequestContext } from "./identity";
import type { HttpPolicy, HttpPolicyRegistry } from "./http-policy";
import { HttpPolicyConfigurationError } from "./http-policy";
import type { HttpCacheStore, HttpRateLimitStore } from "./http-policy-stores";
import { createCachePolicy } from "./http-response-cache";

export type BuiltinHttpPolicyDeclaration =
  | { name: "authenticated"; options?: never }
  | { name: "tenant"; options: { param: string } }
  | { name: "permission"; options: { allOf: readonly string[] } }
  | { name: "rateLimit"; options: { limit: number; windowMs: number } }
  | { name: "cache"; options: { ttlMs: number; maxBodyBytes?: number } };

export interface HttpPolicySuiteOptions {
  auth: SupAuthContextOptions;
  rateLimitStore?: HttpRateLimitStore;
  cacheStore?: HttpCacheStore;
  /** Required for cache policies. Change for each representation/deployment version. */
  cacheNamespace?: string;
  /** Sanitized operational notification; no exception, key, user or payload. */
  onCacheWriteError?: () => void;
}

export function policyOptions(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new HttpPolicyConfigurationError("Invalid built-in HTTP policy options");
  }
  return value as Record<string, unknown>;
}

export function positiveInteger(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new HttpPolicyConfigurationError("HTTP policy numeric option is out of range");
  }
  return value;
}

export async function policyKey(parts: unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function principalKey(context: SupAuthRequestContext): unknown[] {
  return [context.identity.issuer, context.identity.clientId, context.identity.subject,
    context.access.projectId, context.access.tenantId];
}

/** Pair the returned factory and registry; only this verifier can populate policy identity. */
export function createHttpPolicySuite(options: HttpPolicySuiteOptions) {
  const verify = createSupAuthRequestContext(options.auth);
  const verified = new WeakMap<Request, SupAuthRequestContext>();
  const requestContext = async (request: Request): Promise<SupaCloudRequestContext | SupAuthRequestContext> => {
    verified.delete(request);
    if (!request.headers.has("authorization")) {
      const base = createSupaCloudRequestContext(request);
      return { ...base, identity: Object.freeze({ authenticated: false }) };
    }
    const context = await verify(request);
    verified.set(request, context);
    return context;
  };
  const requireAccess = (request: Request) => {
    const context = verified.get(request);
    if (!context) throw new ApplicationError("Authentication required", {
      status: 401, code: "AUTHENTICATION_REQUIRED",
    });
    return context;
  };
  const registry: HttpPolicyRegistry = {
    authenticated: (value) => {
      if (value !== undefined) throw new HttpPolicyConfigurationError("authenticated does not accept options");
      return ({ http }) => { requireAccess(http.request); };
    },
    tenant: (value) => {
      const { param } = policyOptions(value, ["param"]);
      if (typeof param !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(param)) {
        throw new HttpPolicyConfigurationError("tenant requires a route parameter name");
      }
      return ({ http }) => {
        const context = requireAccess(http.request);
        if (http.params[param] !== context.access.tenantId) {
          throw new ApplicationError("Tenant access denied", { status: 403, code: "TENANT_ACCESS_DENIED" });
        }
      };
    },
    permission: (value) => {
      const { allOf } = policyOptions(value, ["allOf"]);
      if (!Array.isArray(allOf) || !allOf.length
        || Array.from(allOf).some((permission) => typeof permission !== "string" || !permission.trim())) {
        throw new HttpPolicyConfigurationError("permission requires non-empty allOf permissions");
      }
      const required = [...new Set<string>(allOf)];
      return ({ http }) => {
        const access = requireAccess(http.request).access;
        if (!required.every((permission) => access.permissions.includes(permission))) {
          throw new ApplicationError("Permission denied", { status: 403, code: "PERMISSION_DENIED" });
        }
      };
    },
    rateLimit: (value, route) => {
      const config = policyOptions(value, ["limit", "windowMs"]);
      const limit = positiveInteger(config.limit, 1_000_000_000);
      const windowMs = positiveInteger(config.windowMs, 86_400_000);
      const store = options.rateLimitStore;
      if (!store) throw new HttpPolicyConfigurationError("rateLimit requires an explicit store");
      return async ({ http }) => {
        const context = requireAccess(http.request);
        const key = await policyKey(["rate", route.method, route.path, ...principalKey(context), limit, windowMs]);
        let result;
        try { result = await store.consume(key, limit, windowMs); }
        catch { throw new ApplicationError("Rate limit service unavailable", { status: 503, code: "RATE_LIMIT_UNAVAILABLE" }); }
        if (typeof result?.allowed !== "boolean" || !Number.isSafeInteger(result.remaining)
          || result.remaining < 0 || result.remaining > limit || !Number.isFinite(result.resetAt)) {
          throw new ApplicationError("Rate limit service unavailable", { status: 503, code: "RATE_LIMIT_UNAVAILABLE" });
        }
        http.set.headers["ratelimit-limit"] = String(limit);
        http.set.headers["ratelimit-remaining"] = String(result.remaining);
        if (!result.allowed) {
          const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
          return new Response("Too Many Requests", { status: 429, headers: { "retry-after": String(retryAfter) } });
        }
      };
    },
    cache: (value, route): HttpPolicy => {
      if (route.method !== "GET" || route.command) {
        throw new HttpPolicyConfigurationError("cache is restricted to GET queries, never commands");
      }
      const config = policyOptions(value, ["ttlMs", "maxBodyBytes"]);
      const ttlMs = positiveInteger(config.ttlMs, 86_400_000);
      const maxBodyBytes = positiveInteger(config.maxBodyBytes ?? 262_144, 16_777_216);
      if (!options.cacheStore) throw new HttpPolicyConfigurationError("cache requires an explicit store");
      if (typeof options.cacheNamespace !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(options.cacheNamespace)) {
        throw new HttpPolicyConfigurationError("cache requires an explicit deployment cacheNamespace");
      }
      return createCachePolicy({
        store: options.cacheStore, requireAccess, ttlMs, maxBodyBytes,
        route: `${route.method} ${route.path}`, namespace: options.cacheNamespace,
        onWriteError: options.onCacheWriteError ?? (() => console.warn("supacloud: HTTP cache write failed")),
      });
    },
  };
  return { requestContext, httpPolicies: registry };
}
