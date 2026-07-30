import { config } from "../config";
import { AppError, ValidationError } from "../utils/errors";

export type PgredisCacheOperationRequest =
  | { op: "get" | "delete" | "ttl" | "getdel"; key: string }
  | { op: "set"; key: string; value: unknown; ttlMs?: number | null }
  | { op: "getset"; key: string; value: unknown };

export interface PgredisPlatformStatus {
  configured: boolean;
  ok: boolean;
  service: string;
  namespace: string;
  queue: false;
  rateLimit: false;
  activeTenants: number;
  maxTenants: number;
  connectionsPerTenant: number;
  l1: {
    enabled: boolean;
    maxEntries: number;
    ttlMs: number;
  };
  tenants: Array<{
    projectRef: string;
    leases: number;
    lastUsedAt: string;
  }>;
}

export interface PgredisProjectStatus {
  projectRef: string;
  configured: boolean;
  active: boolean;
  configurationCurrent: boolean;
  leases: number;
  lastUsedAt: string | null;
}

export interface PgredisRuntimeServiceOptions {
  baseUrl: string;
  internalToken: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

function jsonObject(candidate: unknown): Record<string, unknown> {
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};
}

function upstreamError(statusCode: number, payload: Record<string, unknown>): AppError {
  const upstreamMessage = typeof payload.error === "string" ? payload.error : "Cache data plane request failed";
  if (statusCode === 400) return new ValidationError(upstreamMessage);
  if (statusCode === 404) {
    return new AppError("Project cache is not configured", 503, "PGREDIS_PROJECT_NOT_CONFIGURED");
  }
  if (statusCode === 503) {
    return new AppError("Cache data plane is unavailable", 503, "PGREDIS_RUNTIME_UNAVAILABLE");
  }
  return new AppError("Cache data plane proxy failed", 502, "PGREDIS_UPSTREAM_ERROR");
}

export class PgredisRuntimeService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PgredisRuntimeServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async platformStatus(): Promise<PgredisPlatformStatus> {
    if (!this.isConfigured()) {
      return {
        configured: false,
        ok: false,
        service: "pgredis-runtime",
        namespace: "unconfigured",
        queue: false,
        rateLimit: false,
        activeTenants: 0,
        maxTenants: 0,
        connectionsPerTenant: 0,
        l1: { enabled: false, maxEntries: 0, ttlMs: 0 },
        tenants: [],
      };
    }
    return {
      ...await this.request<Omit<PgredisPlatformStatus, "configured">>("/internal/v1/admin/status"),
      configured: true,
    };
  }

  async projectStatus(projectRef: string): Promise<PgredisProjectStatus> {
    if (!this.isConfigured()) {
      return {
        projectRef,
        configured: false,
        active: false,
        configurationCurrent: false,
        leases: 0,
        lastUsedAt: null,
      };
    }
    return this.request<PgredisProjectStatus>(
      `/internal/v1/admin/projects/${encodeURIComponent(projectRef)}/status`,
    );
  }

  async refresh(projectRef: string): Promise<PgredisProjectStatus> {
    return this.request<PgredisProjectStatus>(
      `/internal/v1/admin/projects/${encodeURIComponent(projectRef)}/refresh`,
      { method: "POST" },
    );
  }

  async execute(
    projectRef: string,
    operation: PgredisCacheOperationRequest,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/internal/v1/admin/cache", {
      method: "POST",
      body: JSON.stringify({ ...operation, projectRef }),
    });
  }

  async flush(projectRef: string): Promise<{ deleted: number }> {
    return this.request<{ deleted: number }>("/internal/v1/admin/cache", {
      method: "POST",
      body: JSON.stringify({
        projectRef,
        op: "flush",
        confirmProjectRef: projectRef,
      }),
    });
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    if (!this.isConfigured()) {
      throw new AppError(
        "Cache data plane is not configured",
        503,
        "PGREDIS_RUNTIME_NOT_CONFIGURED",
      );
    }
    const timeoutMs = Number.isSafeInteger(this.options.timeoutMs) && this.options.timeoutMs > 0
      ? this.options.timeoutMs
      : 5_000;
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("x-supacloud-internal-auth", this.options.internalToken);
    if (init.body) headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(pathname, this.options.baseUrl), {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (
        error instanceof DOMException
        && (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new AppError("Cache data plane request timed out", 504, "PGREDIS_RUNTIME_TIMEOUT");
      }
      if (error instanceof TypeError) {
        throw new AppError("Cache data plane is unavailable", 503, "PGREDIS_RUNTIME_UNAVAILABLE");
      }
      throw error;
    }

    const payload = jsonObject(await response.json().catch(() => ({})));
    if (!response.ok) throw upstreamError(response.status, payload);
    return payload as T;
  }

  private isConfigured(): boolean {
    return new TextEncoder().encode(this.options.internalToken).byteLength >= 32;
  }
}

export const pgredisRuntimeService = new PgredisRuntimeService({
  baseUrl: config.pgredisRuntimeInternalUrl,
  internalToken: config.pgredisRuntimeInternalToken,
  timeoutMs: config.pgredisRuntimeInternalTimeoutMs,
});
