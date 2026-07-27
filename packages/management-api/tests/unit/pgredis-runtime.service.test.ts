import { describe, expect, mock, test } from "bun:test";
import { PgredisRuntimeService } from "../../src/services/pgredis-runtime.service";

const internalToken = "pgredis-management-test-token".padEnd(32, "x");

function serviceWith(
  handler: (request: Request) => Response | Promise<Response>,
): { service: PgredisRuntimeService; fetchImpl: ReturnType<typeof mock> } {
  const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return await handler(request);
  });
  return {
    service: new PgredisRuntimeService({
      baseUrl: "http://pgredis-runtime:9010",
      internalToken,
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
    fetchImpl,
  };
}

describe("PgredisRuntimeService", () => {
  test("keeps the internal token server-side and maps project operations", async () => {
    const requests: Request[] = [];
    const { service } = serviceWith(async (request) => {
      requests.push(request);
      if (request.method === "GET") {
        return Response.json({
          ok: true,
          service: "pgredis-runtime",
          namespace: "supacloud-edge-runtime",
          queue: false,
          rateLimit: false,
          activeTenants: 0,
          maxTenants: 8,
          connectionsPerTenant: 2,
          l1: { enabled: true, maxEntries: 100, ttlMs: 1_000 },
          tenants: [],
        });
      }
      return Response.json({ written: true });
    });

    await service.platformStatus();
    await service.execute("tenant-a", {
      op: "set",
      key: "key-a",
      value: { enabled: true },
      ttlMs: 500,
    });
    await service.flush("tenant-a");

    expect(requests[0].url).toBe("http://pgredis-runtime:9010/internal/v1/admin/status");
    expect(requests.every((request) => request.headers.get("x-supacloud-internal-auth") === internalToken)).toBeTrue();
    expect(await requests[1].json()).toEqual({
      projectRef: "tenant-a",
      op: "set",
      key: "key-a",
      value: { enabled: true },
      ttlMs: 500,
    });
    expect(await requests[2].json()).toEqual({
      projectRef: "tenant-a",
      op: "flush",
      confirmProjectRef: "tenant-a",
    });
  });

  test("fails closed when the token is missing", async () => {
    const fetchImpl = mock(() => Promise.resolve(Response.json({ ok: true })));
    const service = new PgredisRuntimeService({
      baseUrl: "http://pgredis-runtime:9010",
      internalToken: "short",
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(service.platformStatus()).rejects.toMatchObject({
      statusCode: 503,
      code: "PGREDIS_RUNTIME_NOT_CONFIGURED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("does not expose upstream authentication failures", async () => {
    const { service } = serviceWith(() => Response.json({ error: "Unauthorized" }, { status: 401 }));
    await expect(service.platformStatus()).rejects.toMatchObject({
      statusCode: 502,
      code: "PGREDIS_UPSTREAM_ERROR",
      message: "Cache data plane proxy failed",
    });
  });

  test("maps transport failures without swallowing unexpected errors", async () => {
    const transportFailure = serviceWith(() => { throw new TypeError("connection refused"); }).service;
    await expect(transportFailure.platformStatus()).rejects.toMatchObject({
      statusCode: 503,
      code: "PGREDIS_RUNTIME_UNAVAILABLE",
    });

    const unexpectedFailure = serviceWith(() => { throw new Error("programmer error"); }).service;
    await expect(unexpectedFailure.platformStatus()).rejects.toThrow("programmer error");
  });
});
