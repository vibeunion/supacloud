import { describe, expect, test } from "bun:test";
import { createScheduledWorkerHttpHandler } from "./index";

const SERVICE_ROLE = "service-role-secret-012345678901234567890123";

describe("scheduled worker HTTP adapter", () => {
  test("fails closed for absent, weak or ambiguous trust configuration", async () => {
    let calls = 0;
    const runBatch = () => { calls += 1; };
    for (const trust of [
      {},
      { expectedBearer: "" },
      { expectedBearer: "short" },
      { expectedBearer: SERVICE_ROLE, authorize: () => true },
    ]) {
      const response = await createScheduledWorkerHttpHandler({ ...trust, runBatch })(
        new Request("https://edge/scheduled", { method: "POST" }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(calls).toBe(0);
  });

  test("verifier failures and logging failures remain private", async () => {
    let calls = 0;
    const handler = createScheduledWorkerHttpHandler({
      authorize: async () => { throw new Error(SERVICE_ROLE); },
      runBatch: () => { calls += 1; },
      logError: () => { throw new Error(SERVICE_ROLE); },
    });
    const response = await handler(new Request("https://edge/scheduled", { method: "POST" }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(SERVICE_ROLE);
    expect(calls).toBe(0);
  });

  test("denied verifier never invokes the batch", async () => {
    let calls = 0;
    const handler = createScheduledWorkerHttpHandler({
      authorize: async () => false,
      runBatch: () => { calls += 1; },
    });
    expect((await handler(new Request("https://edge/scheduled", { method: "POST" }))).status).toBe(401);
    expect(calls).toBe(0);
  });

  test("authorizes a service-role bearer and runs the batch", async () => {
    const handler = createScheduledWorkerHttpHandler({
      expectedBearer: SERVICE_ROLE,
      runBatch: () => ({ scheduled: 2 }),
    });

    const response = await handler(new Request("https://edge/functions/v1/scheduled", {
      method: "POST",
      headers: { authorization: `Bearer ${SERVICE_ROLE}` },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, result: { scheduled: 2 } });
  });

  test("supports an injected verifier without requiring a bearer secret", async () => {
    let verifiedRequest: Request | undefined;
    const handler = createScheduledWorkerHttpHandler({
      authorize: (request) => {
        verifiedRequest = request;
        return request.headers.get("x-scheduler-signature") === "valid";
      },
      runBatch: () => ({ ok: true }),
    });

    const response = await handler(new Request("https://edge/functions/v1/scheduled", {
      method: "POST",
      headers: { "x-scheduler-signature": "valid" },
    }));
    expect(response.status).toBe(200);
    expect(verifiedRequest).toBeDefined();
  });

  test("rejects invalid or missing authorization and hides failures", async () => {
    const handler = createScheduledWorkerHttpHandler({
      expectedBearer: SERVICE_ROLE,
      runBatch: () => {
        throw new Error("private detail");
      },
    });

    expect(
      (await handler(new Request("https://edge/functions/v1/scheduled", { method: "GET" }))).status,
    ).toBe(405);
    expect(
      (await handler(new Request("https://edge/functions/v1/scheduled", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }))).status,
    ).toBe(401);

    const response = await handler(new Request("https://edge/functions/v1/scheduled", {
      method: "POST",
      headers: { authorization: `Bearer ${SERVICE_ROLE}` },
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "SUPACLOUD_SCHEDULED_WORKER_UNAVAILABLE" },
    });
  });
});
