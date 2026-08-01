import { runtimeFile } from "./deno-compat";

type FetchLike = typeof globalThis.fetch;

export type EdgeFetchTlsPolicy = {
  ca?: string;
  rejectUnauthorized?: boolean;
  source: "none" | "ca-inline" | "ca-file" | "insecure";
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function enabled(value: string | undefined): boolean {
  return value ? TRUE_VALUES.has(value.trim().toLowerCase()) : false;
}

function pickString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function resolveEdgeFetchTlsPolicy(
  env: Record<string, string | undefined>,
  hostEnv: Record<string, string | undefined> = {},
): Promise<EdgeFetchTlsPolicy> {
  if (
    enabled(env.SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY) ||
    enabled(hostEnv.SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY)
  ) {
    return { rejectUnauthorized: false, source: "insecure" };
  }

  const inlineCa = pickString(env.SUPACLOUD_EDGE_TLS_CA) ?? pickString(hostEnv.SUPACLOUD_EDGE_TLS_CA);
  if (inlineCa) {
    return { ca: inlineCa, source: "ca-inline" };
  }

  const caFile = pickString(hostEnv.SUPACLOUD_EDGE_TLS_CA_FILE);
  if (caFile) {
    return { ca: await runtimeFile(caFile).text(), source: "ca-file" };
  }

  return { source: "none" };
}

function isHttpsRequest(input: Parameters<FetchLike>[0]): boolean {
  if (typeof input === "string") return input.startsWith("https:");
  if (input instanceof URL) return input.protocol === "https:";
  return input.url.startsWith("https:");
}

function withTlsPolicy(
  init: Parameters<FetchLike>[1],
  policy: EdgeFetchTlsPolicy,
): Parameters<FetchLike>[1] {
  if (policy.source === "none") return init;

  const currentTls = (init as { tls?: Record<string, unknown> } | undefined)?.tls ?? {};
  const nextTls: Record<string, unknown> = { ...currentTls };

  if (policy.ca && nextTls.ca === undefined) {
    nextTls.ca = policy.ca;
  }
  if (policy.rejectUnauthorized === false) {
    nextTls.rejectUnauthorized = false;
  }

  return { ...init, tls: nextTls } as Parameters<FetchLike>[1];
}

export function installEdgeFetchTlsPolicy(
  policy: EdgeFetchTlsPolicy,
  originalFetch: FetchLike = globalThis.fetch,
): () => void {
  if (policy.source === "none") {
    return () => {};
  }

  globalThis.fetch = ((input, init) => {
    const nextInit = isHttpsRequest(input) ? withTlsPolicy(init, policy) : init;
    return originalFetch(input, nextInit);
  }) as FetchLike;

  return () => {
    globalThis.fetch = originalFetch;
  };
}
