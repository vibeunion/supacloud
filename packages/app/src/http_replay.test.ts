import { describe, expect, test } from "bun:test";
import { HttpClient } from "./http_client";
import { createAuthoritativeCommandClient } from "./contract_client";
import { HttpReplayError, validateReplayPolicy } from "./http_replay";
import {
  createBearerAuthInterceptor,
  createRetryInterceptor,
  type HttpInterceptorFn,
  type HttpRequestPayload,
} from "./interceptor";

async function withServer(
  handler: (request: Request) => Response | Promise<Response>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  try {
    await run(server.url.toString());
  } finally {
    await server.stop(true);
  }
}

const retry = createRetryInterceptor(2, 0);

describe("HTTP replay policy at the network boundary", () => {
  for (const method of ["POST", "put", "PATCH", "DELETE", "CUSTOM"]) {
    test(`${method} is single-send even on transient failure and with an idempotency header`, async () => {
      let requests = 0;
      await withServer(() => { requests++; return new Response(null, { status: 503 }); }, async (baseUrl) => {
        const client = new HttpClient({ baseUrl }, [retry]);
        const response = await client.request(method, "/write", {
          observe: "response", headers: { "Idempotency-Key": "header-alone-is-not-a-contract" },
        });
        expect(response.status).toBe(503);
        expect(requests).toBe(1);
      });
    });
  }

  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    test(`${method} retains transient retry support`, async () => {
      let requests = 0;
      await withServer(() => new Response(null, { status: ++requests === 1 ? 503 : 200 }), async (baseUrl) => {
        const client = new HttpClient({ baseUrl }, [retry]);
        expect((await client.request(method, "/read", { observe: "response" })).status).toBe(200);
        expect(requests).toBe(2);
      });
    });
  }

  for (const status of [400, 401, 403, 404, 409, 422]) {
    test(`ordinary retry never retries HTTP ${status}`, async () => {
      let requests = 0;
      await withServer(() => { requests++; return new Response(null, { status }); }, async (baseUrl) => {
        const client = new HttpClient({ baseUrl }, [retry]);
        expect((await client.get("/read", { observe: "response" })).status).toBe(status);
        expect(requests).toBe(1);
      });
    });
  }

  test("never policy disables read retries too", async () => {
    let requests = 0;
    await withServer(() => { requests++; return new Response(null, { status: 503 }); }, async (baseUrl) => {
      const client = new HttpClient({ baseUrl }, [retry]);
      await client.get("/read", { observe: "response", replay: { mode: "never" } });
      expect(requests).toBe(1);
    });
  });

  test("opted-in writes retry with the same key, target and serialized payload", async () => {
    const received: { key: string | null; body: string; path: string }[] = [];
    await withServer(async (request) => {
      received.push({
        key: request.headers.get("idempotency-key"), body: await request.text(),
        path: new URL(request.url).pathname,
      });
      return new Response(null, { status: received.length === 1 ? 503 : 200 });
    }, async (baseUrl) => {
      const client = new HttpClient({ baseUrl }, [retry]);
      const response = await client.post("/write", { enabled: true }, {
        observe: "response", replay: { mode: "idempotent", idempotencyKey: "operation-1" },
      });
      expect(response.status).toBe(200);
      expect(received).toEqual([
        { key: "operation-1", body: '{"enabled":true}', path: "/write" },
        { key: "operation-1", body: '{"enabled":true}', path: "/write" },
      ]);
    });
  });

  test("authorization is retained but an authentication interceptor cannot replay a default write", async () => {
    const tokens: (string | null)[] = [];
    let refreshes = 0;
    const authentication: HttpInterceptorFn = async (req, next) => {
      const response = await next(req);
      if (response.status !== 401) return response;
      await response.body?.cancel();
      refreshes++;
      req.headers["authorization"] = "Bearer refreshed";
      return next(req);
    };
    await withServer((request) => {
      tokens.push(request.headers.get("authorization"));
      return new Response(null, { status: tokens.length === 1 ? 401 : 200 });
    }, async (baseUrl) => {
      const client = new HttpClient({ baseUrl }, [
        createBearerAuthInterceptor(async () => "current"), authentication, retry,
      ]);
      await expect(client.put("/write", {})).rejects.toBeInstanceOf(HttpReplayError);
      expect(tokens).toEqual(["Bearer current"]);
      expect(refreshes).toBe(1);
    });
  });

  test("a read may still use an authentication interceptor's refresh flow", async () => {
    let requests = 0;
    const authentication: HttpInterceptorFn = async (req, next) => {
      const response = await next(req);
      if (response.status !== 401) return response;
      await response.body?.cancel();
      req.headers["x-request-id"] = "refreshed-read";
      return next(req);
    };
    await withServer(() => new Response(null, { status: ++requests === 1 ? 401 : 200 }), async (baseUrl) => {
      const client = new HttpClient({ baseUrl }, [authentication, retry]);
      expect((await client.get("/read", { observe: "response" })).status).toBe(200);
      expect(requests).toBe(2);
    });
  });

  test("simultaneous interceptor sends cannot race the single-send guard", async () => {
    let requests = 0;
    const duplicate: HttpInterceptorFn = async (req, next) => {
      const results = await Promise.allSettled([next(req), next(req)]);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      for (const result of results) {
        if (result.status === "fulfilled") return result.value;
      }
      throw new Error("No request completed");
    };
    await withServer(() => { requests++; return new Response(null); }, async (baseUrl) => {
      await new HttpClient({ baseUrl }, [duplicate]).post("/write", {});
      expect(requests).toBe(1);
    });
  });

  for (const changed of ["key", "method", "url", "body", "precondition"] as const) {
    test(`explicit replay cannot change ${changed}`, async () => {
      let requests = 0;
      const mutate: HttpInterceptorFn = async (req, next) => {
        const response = await next(req);
        await response.body?.cancel();
        switch (changed) {
          case "key": req.headers["Idempotency-Key"] = "different"; break;
          case "method": req.method = "DELETE"; break;
          case "url": req.url += "/different"; break;
          case "body": req.body = '{"different":true}'; break;
          case "precondition": req.headers["If-Match"] = "different-version"; break;
        }
        return next(req);
      };
      await withServer(() => { requests++; return new Response(null, { status: 503 }); }, async (baseUrl) => {
        const client = new HttpClient({ baseUrl }, [mutate]);
        await expect(client.post("/write", {}, {
          replay: { mode: "idempotent", idempotencyKey: "operation-1" },
        })).rejects.toBeInstanceOf(HttpReplayError);
        expect(requests).toBe(1);
      });
    });
  }

  test("interceptors cannot promote a default write to replayable", async () => {
    let requests = 0;
    const promote: HttpInterceptorFn = async (req, next) => {
      const response = await next(req);
      await response.body?.cancel();
      req.replay = { mode: "idempotent", idempotencyKey: "injected" };
      return next(req);
    };
    await withServer(() => { requests++; return new Response(null, { status: 401 }); }, async (baseUrl) => {
      await expect(new HttpClient({ baseUrl }, [promote]).post("/write", {})).rejects.toBeInstanceOf(HttpReplayError);
      expect(requests).toBe(1);
    });
  });

  test("conflicting header keys and non-replayable bodies fail before sending", async () => {
    let requests = 0;
    await withServer(() => { requests++; return new Response(null); }, async (baseUrl) => {
      const client = new HttpClient({ baseUrl }, [retry]);
      await expect(client.post("/write", {}, {
        replay: { mode: "idempotent", idempotencyKey: "operation-1" },
        headers: { "Idempotency-Key": "different" },
      })).rejects.toBeInstanceOf(HttpReplayError);
      for (const body of [new FormData(), new URLSearchParams("x=1"), new Uint8Array([1]), new ReadableStream()]) {
        await expect(client.post("/write", body, {
          replay: { mode: "idempotent", idempotencyKey: "operation-1" },
        })).rejects.toThrow("immutable HTTP body");
      }
      expect(requests).toBe(0);
    });
  });

  test("request cancellation reaches native fetch and prevents later sends", async () => {
    const controller = new AbortController();
    let requests = 0;
    controller.abort();
    await withServer(() => { requests++; return new Response(null); }, async (baseUrl) => {
      const client = new HttpClient({ baseUrl }, [retry]);
      await expect(client.get("/read", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(requests).toBe(0);
    });
  });

  for (const status of [307, 308]) {
    test(`native fetch cannot replay a write through HTTP ${status} redirects`, async () => {
      const paths: string[] = [];
      await withServer((request) => {
        const path = new URL(request.url).pathname;
        paths.push(path);
        return path === "/write"
          ? new Response(null, { status, headers: { location: "/redirected" } })
          : new Response(null);
      }, async (baseUrl) => {
        await expect(new HttpClient({ baseUrl }, [retry]).post("/write", {})).rejects.toBeInstanceOf(Error);
        expect(paths).toEqual(["/write"]);
      });
    });
  }

  test("a post-commit 401 plus authentication replay is resolved by authority, with one actual write", async () => {
    let writes = 0, reads = 0, enabled = false;
    const authentication: HttpInterceptorFn = async (req, next) => {
      const response = await next(req);
      if (response.status !== 401) return response;
      await response.body?.cancel();
      return next(req);
    };
    await withServer((request) => {
      if (request.method === "PUT") {
        writes++;
        enabled = true;
        return new Response(null, { status: 401 });
      }
      reads++;
      return Response.json({ id: "target", enabled });
    }, async (baseUrl) => {
      const http = new HttpClient({ baseUrl }, [authentication, retry]);
      const client = createAuthoritativeCommandClient({
        input: (value) => {
          if (value !== "target") throw new Error("Invalid target");
          return value;
        },
        acknowledgement: (value) => {
          if (value !== true) throw new Error("Invalid acknowledgement");
          return value;
        },
        authority: (value) => {
          if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string"
            || !("enabled" in value) || typeof value.enabled !== "boolean") throw new Error("Invalid authority");
          return { id: value.id, enabled: value.enabled };
        },
        matches: (id, value) => value.id === id && value.enabled,
      }, {
        send: (id) => http.put(`/webhooks/${id}`, { enabled: true }),
        lookup: (id) => http.get(`/webhooks/${id}`),
      });
      expect(await client("target")).toMatchObject({
        status: "confirmed", source: "lookup", authority: { id: "target", enabled: true },
      });
      expect([writes, reads]).toEqual([1, 1]);
    });
  });
});

describe("retry failures and validation", () => {
  test("standalone retry interceptors also install and validate the idempotency key", async () => {
    const keys: (string | undefined)[] = [];
    const request: HttpRequestPayload = {
      method: "POST", url: "/write", headers: {},
      replay: { mode: "idempotent", idempotencyKey: "operation-1" },
    };
    await retry(request, async (payload) => {
      keys.push(payload.headers["idempotency-key"]);
      return new Response(null, { status: keys.length === 1 ? 503 : 200 });
    });
    expect(keys).toEqual(["operation-1", "operation-1"]);
    request.headers["idempotency-key"] = "different";
    await expect(retry(request, async () => {
      throw new Error("Unexpected send");
    })).rejects.toBeInstanceOf(HttpReplayError);
  });

  test("network failures retry reads but not default writes", async () => {
    for (const method of ["GET", "POST"]) {
      let sends = 0;
      await expect(retry({ method, url: "/test", headers: {} }, async () => {
        sends++;
        throw new Error("connection lost");
      })).rejects.toThrow("connection lost");
      expect(sends).toBe(method === "GET" ? 3 : 1);
    }
  });

  test("cancellation interrupts backoff without another attempt", async () => {
    const controller = new AbortController();
    let sends = 0;
    const payload: HttpRequestPayload = {
      method: "GET", url: "/test", headers: {}, signal: controller.signal,
    };
    const result = createRetryInterceptor(3, 60_000)(payload, async () => {
      sends++;
      setTimeout(() => controller.abort(), 5);
      return new Response(null, { status: 503 });
    });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(sends).toBe(1);
  });

  test("unresponsive response stream cleanup cannot prevent cancellation", async () => {
    const controller = new AbortController();
    const result = createRetryInterceptor(3, 60_000)({
      method: "GET", url: "/read", headers: {}, signal: controller.signal,
    }, async () => {
      setTimeout(() => controller.abort(), 5);
      return new Response(new ReadableStream({
        cancel: () => new Promise<void>(() => {}),
      }), { status: 503 });
    });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  test("abort errors without a supplied signal never retry", async () => {
    let sends = 0;
    await expect(retry({ method: "GET", url: "/test", headers: {} }, async () => {
      sends++;
      throw new DOMException("aborted", "AbortError");
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(sends).toBe(1);
  });

  test("invalid retry limits and external policies are rejected", () => {
    for (const count of [-1, 1.5, NaN, Infinity]) expect(() => createRetryInterceptor(count)).toThrow(RangeError);
    for (const delay of [-1, NaN, Infinity, 2 ** 31]) expect(() => createRetryInterceptor(1, delay)).toThrow(RangeError);
    for (const value of [null, "always", {}, { mode: "always" }, { mode: "idempotent" },
      { mode: "idempotent", idempotencyKey: "" }, { mode: "idempotent", idempotencyKey: "private\nheader" }]) {
      expect(() => validateReplayPolicy(value)).toThrow("Invalid HTTP replay policy");
    }
  });
});
