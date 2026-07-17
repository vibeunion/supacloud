export type SupaCloudOAuthFetchOptions = {
  /**
   * Public OAuth client identifier registered with SupAuth. Leave empty for a
   * standard single-project Supabase deployment; the transport then becomes a
   * transparent pass-through.
   */
  clientId?: string | null;
  /**
   * OAuth token endpoint. When omitted, `/auth/v1/oauth/token` is derived from
   * the Supabase Auth refresh URL origin.
   */
  tokenEndpoint?: string;
  /** Injectable transport for tests or runtimes with a custom fetch. */
  fetch?: typeof fetch;
};

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function isRefreshTokenRequest(url: URL, method: string): boolean {
  return method === "POST"
    && url.pathname.endsWith("/auth/v1/token")
    && url.searchParams.get("grant_type") === "refresh_token";
}

function parseRefreshBody(body: string, contentType: string): URLSearchParams | null {
  if (!body) return null;
  if (contentType.toLowerCase().includes("application/json") || body.trimStart().startsWith("{")) {
    let value: unknown;
    try { value = JSON.parse(body); } catch { return null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const refreshToken = typeof record.refresh_token === "string" ? record.refresh_token.trim() : "";
    if (!refreshToken) return null;
    const params = new URLSearchParams();
    for (const [key, item] of Object.entries(record)) {
      if (typeof item === "string") params.set(key, item);
    }
    return params;
  }
  const params = new URLSearchParams(body);
  return params.get("refresh_token")?.trim() ? params : null;
}

function replacementRequest(
  request: Request,
  tokenEndpoint: string,
  body: URLSearchParams,
): Request {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/x-www-form-urlencoded");
  headers.delete("content-length");
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  return new Request(tokenEndpoint, {
    method: "POST",
    headers,
    body,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  });
}

/**
 * Adapts Supabase Auth's built-in refresh request to SupAuth's OAuth token
 * contract while leaving every other supabase-js request untouched.
 *
 * Usage:
 * createClient(authUrl, anonKey, {
 *   global: { fetch: createSupaCloudOAuthFetch({ clientId }) },
 * });
 */
export function createSupaCloudOAuthFetch(
  options: SupaCloudOAuthFetchOptions = {},
): typeof fetch {
  const fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
  const clientId = options.clientId?.trim();
  if (!clientId) return fetchImpl;

  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!isRefreshTokenRequest(url, requestMethod(input, init))) {
      return fetchImpl(input, init);
    }

    const request = new Request(input, init);
    const body = parseRefreshBody(
      await request.clone().text(),
      request.headers.get("content-type") || "",
    );
    if (!body) return fetchImpl(input, init);

    body.set("grant_type", "refresh_token");
    if (!body.get("client_id")) body.set("client_id", clientId);
    const endpoint = options.tokenEndpoint?.trim()
      || new URL(
        url.pathname.replace(/\/auth\/v1\/token$/, "/auth/v1/oauth/token"),
        url.origin,
      ).toString();
    if (new URL(endpoint).origin !== url.origin) {
      throw new Error("SupaCloud OAuth tokenEndpoint must use the Supabase Auth origin");
    }
    return fetchImpl(replacementRequest(request, endpoint, body));
  };
}
