import { describe, expect, test } from "bun:test";
import { constantTimeSecretMatches, createWorkerHttpHandler } from "./index";

const SECRET = "worker-secret-012345678901234567890123";

function request(
  body?: unknown,
  init: RequestInit = {},
): Request {
  return new Request("https://edge/functions/v1/worker", {
    method: "POST",
    headers: { "x-supacloud-worker-secret": SECRET },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });
}

describe("worker HTTP adapter", () => {
  test("compares secrets including empty and unequal-length inputs", async () => {
    expect(await constantTimeSecretMatches(SECRET, SECRET)).toBe(true);
    expect(await constantTimeSecretMatches("", "")).toBe(false);
    expect(await constantTimeSecretMatches("wrong", SECRET)).toBe(false);
    expect(await constantTimeSecretMatches("x".repeat(SECRET.length), SECRET)).toBe(false);
  });

  test("rejects invalid configuration and unconfigured secrets", async () => {
    const options = { expectedSecret: SECRET, defaultBatchSize: 1, runBatch: () => null };
    for (const defaultBatchSize of [0, 21, 1.5, NaN]) {
      expect(() => createWorkerHttpHandler({ ...options, defaultBatchSize })).toThrow(RangeError);
    }
    expect(() => createWorkerHttpHandler({ ...options, maxBatchSize: Infinity })).toThrow(RangeError);
    expect(() => createWorkerHttpHandler({ ...options, minimumSecretLength: 0 })).toThrow(RangeError);
    for (const expectedSecret of ["", "short"]) {
      const response = await createWorkerHttpHandler({ ...options, expectedSecret })(request());
      expect(response.status).toBe(503);
    }
  });

  test("uses defaults and custom headers, codes and accepted status", async () => {
    const handler = createWorkerHttpHandler({
      expectedSecret: SECRET,
      secretHeader: "x-app-worker",
      defaultBatchSize: 2,
      maxBatchSize: 3,
      runBatch: ({ batchSize }) => batchSize,
      successStatus: () => 202,
      errorCodes: { unauthorized: "APP_UNAUTHORIZED" },
    });
    const unauthorized = await handler(request());
    expect(await unauthorized.json()).toMatchObject({ error: { code: "APP_UNAUTHORIZED" } });
    const response = await handler(request(undefined, { headers: { "x-app-worker": SECRET } }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, result: 2 });
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("rejects invalid bodies without executing work", async () => {
    let calls = 0;
    const handler = createWorkerHttpHandler({
      expectedSecret: SECRET,
      defaultBatchSize: 2,
      runBatch: () => { calls += 1; },
    });
    for (const body of [null, [], "text", { batchSize: 0 }, { batchSize: -1 }, { batchSize: 1.1 }, { batchSize: "2" }]) {
      expect((await handler(request(body))).status).toBe(400);
    }
    expect(calls).toBe(0);
    for (const body of [{}, { batchSize: 1 }, { batchSize: 20 }]) {
      expect((await handler(request(body))).status).toBe(200);
    }
    expect(calls).toBe(3);
  });

  test("runs a bounded batch and returns a no-store JSON response", async () => {
    const calls: number[] = [];
    const handler = createWorkerHttpHandler({
      expectedSecret: SECRET,
      defaultBatchSize: 3,
      runBatch: ({ batchSize }) => {
        calls.push(batchSize);
        return { processed: batchSize };
      },
    });

    const response = await handler(request({ batchSize: 4 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, result: { processed: 4 } });
    expect(calls).toEqual([4]);
  });

  test("rejects method, authentication, malformed JSON, and invalid batches", async () => {
    const handler = createWorkerHttpHandler({
      expectedSecret: SECRET,
      defaultBatchSize: 3,
      runBatch: () => ({ processed: 0 }),
    });

    expect((await handler(request(undefined, { method: "GET" }))).status).toBe(405);
    expect(
      (await handler(new Request("https://edge/functions/v1/worker", { method: "POST" }))).status,
    ).toBe(401);
    expect(
      (await handler(new Request("https://edge/functions/v1/worker", {
        method: "POST",
        headers: { "x-supacloud-worker-secret": SECRET },
        body: "{",
      }))).status,
    ).toBe(400);
    expect((await handler(request({ batchSize: 21 }))).status).toBe(400);
  });

  test("does not expose callback errors", async () => {
    const logged: unknown[] = [];
    const handler = createWorkerHttpHandler({
      expectedSecret: SECRET,
      defaultBatchSize: 1,
      runBatch: () => {
        throw new Error("private database detail");
      },
      logError: (error) => logged.push(error),
    });

    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "SUPACLOUD_WORKER_UNAVAILABLE",
        message: "Worker execution failed.",
      },
    });
    expect(logged).toHaveLength(1);
  });
});
