import type { SupAuthRequestContext } from "./identity";
import type { HttpPolicy, HttpPolicyResponseContext } from "./http-policy";
import type { HttpCacheStore } from "./http-policy-stores";
import { ApplicationError } from "./index";
import { policyKey, principalKey } from "./http-policy-suite";
import { mapResponse } from "elysia/adapter/web-standard/handler";

interface CachePolicyOptions {
  store: HttpCacheStore;
  requireAccess(request: Request): SupAuthRequestContext;
  ttlMs: number;
  maxBodyBytes: number;
  route: string;
  namespace: string;
  onWriteError(): void;
}

function mayStore({ http, response }: HttpPolicyResponseContext): boolean {
  if (response === null || typeof response !== "object" || response instanceof Response
    || (!Array.isArray(response) && Object.getPrototypeOf(response) !== Object.prototype)) return false;
  if (http.set.status !== undefined && http.set.status !== 200 && http.set.status !== "OK") return false;
  if (http.set.cookie && Object.keys(http.set.cookie).length) return false;
  const headers = new Headers(http.set.headers as HeadersInit);
  // Do not replay cookies, per-request headers, Vary, redirects or cache prohibitions.
  for (const name of headers.keys()) {
    if (!["content-type", "x-request-id", "ratelimit-limit", "ratelimit-remaining"].includes(name)) return false;
  }
  return !headers.has("content-type") || headers.get("content-type")!.split(";")[0]!.trim() === "application/json";
}

async function boundedBody(response: Response, maxBytes: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        return;
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export function createCachePolicy(options: CachePolicyOptions): HttpPolicy {
  const misses = new WeakMap<Request, { key: string; generation: string }>();
  const snapshots = new WeakMap<Request, { response: Response; body: Promise<string | undefined> }>();
  const policy: HttpPolicy = async ({ http }) => {
    const context = options.requireAccess(http.request);
    if (http.request.headers.has("range") || http.request.headers.has("if-none-match")
      || http.request.headers.has("if-modified-since")
      || /(?:no-cache|no-store|max-age\s*=\s*0)/i.test(http.request.headers.get("cache-control") ?? "")) return;
    const headers = [...http.request.headers].filter(([name]) => name !== "x-request-id").sort(([a], [b]) => a.localeCompare(b));
    const key = await policyKey(["cache", options.namespace, options.route, ...principalKey(context),
      [...context.access.permissions].sort(), http.request.url, headers]);
    let entry, generation: string;
    try {
      generation = await options.store.generation();
      if (typeof generation !== "string" || !generation.length || generation.length > 128) throw new Error("Invalid cache generation");
      entry = await options.store.get(key, generation);
    }
    catch { throw new ApplicationError("Cache service unavailable", { status: 503, code: "HTTP_CACHE_UNAVAILABLE" }); }
    if (entry && entry.expiresAt > Date.now()) {
      if (typeof entry.body !== "string" || entry.contentType !== "application/json"
        || new TextEncoder().encode(entry.body).byteLength > options.maxBodyBytes) {
        throw new ApplicationError("Cache service unavailable", { status: 503, code: "HTTP_CACHE_UNAVAILABLE" });
      }
      return new Response(entry.body, {
        headers: { "content-type": "application/json", "cache-control": "private, no-store" },
      });
    }
    misses.set(http.request, { key, generation });
  };
  policy.terminal = true;
  policy.mapResponse = async (context) => {
    if (!misses.has(context.http.request) || !mayStore(context)) return;
    const response = await mapResponse(context.response, context.http.set, context.http.request);
    const body = boundedBody(response.clone(), options.maxBodyBytes).catch(() => {
      try { options.onWriteError(); } catch {}
      return undefined;
    });
    snapshots.set(context.http.request, { response, body });
    return response;
  };
  policy.afterResponse = async (context) => {
    const miss = misses.get(context.http.request);
    const snapshot = snapshots.get(context.http.request);
    misses.delete(context.http.request);
    snapshots.delete(context.http.request);
    if (!miss || !snapshot || context.response !== snapshot.response || snapshot.response.status !== 200) return;
    const headers = snapshot.response.headers;
    if ([...headers.keys()].some((name) =>
      !["content-type", "x-request-id", "ratelimit-limit", "ratelimit-remaining"].includes(name))) return;
    try {
      const body = await snapshot.body;
      if (body === undefined) return;
      await options.store.set(miss.key, { body, contentType: "application/json", expiresAt: Date.now() + options.ttlMs }, miss.generation);
    } catch {
      // A cache write occurs after delivery; it cannot alter a completed business result.
      try { options.onWriteError(); } catch {}
    }
  };
  return policy;
}
