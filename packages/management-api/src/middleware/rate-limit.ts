type Bucket = {
  count: number;
  resetAt: number;
};

const WINDOW_MS = Number(process.env.MANAGEMENT_API_RATE_LIMIT_WINDOW_MS || 60_000);
const MAX_REQUESTS = Number(process.env.MANAGEMENT_API_RATE_LIMIT_MAX || 600);
const WRITE_MAX_REQUESTS = Number(process.env.MANAGEMENT_API_WRITE_RATE_LIMIT_MAX || 120);
const buckets = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, Math.max(WINDOW_MS, 10_000)).unref();

function clientIdentity(request: Request): string {
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) return `token:${auth.slice(7, 31)}`;
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${forwardedFor || request.headers.get("x-real-ip") || "unknown"}`;
}

function routeClass(url: URL, method: string): string {
  const scope = url.pathname.match(/^\/v1\/projects\/([^/]+)/)?.[1] || "global";
  const verb = method.toUpperCase();
  const kind = ["GET", "HEAD", "OPTIONS"].includes(verb) ? "read" : "write";
  return `${scope}:${kind}`;
}

export function checkRateLimit(request: Request): { allowed: true; headers: Record<string, string> } | { allowed: false; status: 429; body: Record<string, unknown>; headers: Record<string, string> } {
  if (process.env.MANAGEMENT_API_RATE_LIMIT_DISABLED === "true") {
    return { allowed: true, headers: {} };
  }

  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1")) {
    return { allowed: true, headers: {} };
  }

  const method = request.method.toUpperCase();
  const limit = ["GET", "HEAD", "OPTIONS"].includes(method) ? MAX_REQUESTS : WRITE_MAX_REQUESTS;
  const now = Date.now();
  const key = `${clientIdentity(request)}:${routeClass(url, method)}`;
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    const next: Bucket = { count: 1, resetAt: now + WINDOW_MS };
    buckets.set(key, next);
    return {
      allowed: true,
      headers: {
        "x-ratelimit-limit": String(limit),
        "x-ratelimit-remaining": String(Math.max(limit - 1, 0)),
        "x-ratelimit-reset": String(Math.ceil(next.resetAt / 1000)),
      },
    };
  }

  bucket.count += 1;
  const remaining = Math.max(limit - bucket.count, 0);
  const headers = {
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(Math.ceil(bucket.resetAt / 1000)),
  };

  if (bucket.count > limit) {
    return {
      allowed: false,
      status: 429,
      headers: {
        ...headers,
        "retry-after": String(Math.ceil((bucket.resetAt - now) / 1000)),
      },
      body: {
        message: "Too many requests",
        code: "429",
        status: 429,
      },
    };
  }

  return { allowed: true, headers };
}

export function resetRateLimitForTests() {
  buckets.clear();
}
