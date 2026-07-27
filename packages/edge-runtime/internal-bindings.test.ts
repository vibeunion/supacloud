import { describe, expect, test } from "bun:test";
import { PgredisBindingController, PgredisBindingError } from "./internal-bindings";

describe("PgredisBindingController", () => {
  test("routes a stable facade through the current tenant context", async () => {
    const calls: Array<{ url: string; authorization: string; body: unknown }> = [];
    const controller = new PgredisBindingController(async (input, init) => {
      calls.push({
        url: input,
        authorization: String(new Headers(init?.headers).get("authorization")),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ value: calls.at(-1)?.body });
    });
    await controller.run({
      baseUrl: "http://pgredis-runtime/",
      capabilityToken: "tenant-capability-a",
      timeoutMs: 100,
    }, async () => {
      expect(await controller.facade.get("key")).toEqual({ op: "get", key: "key" });
    });
    await expect(controller.facade.get("key")).rejects.toBeInstanceOf(PgredisBindingError);

    await controller.run({
      baseUrl: "http://pgredis-runtime",
      capabilityToken: "tenant-capability-b",
      timeoutMs: 100,
    }, async () => {
      await controller.facade.set("key", { tenant: "b" }, 500);
    });
    expect(calls.at(-1)).toMatchObject({
      url: "http://pgredis-runtime/internal/v1/cache",
      authorization: "Bearer tenant-capability-b",
    });
  });

  test("rejects detached work after its request context closes", async () => {
    const controller = new PgredisBindingController(async () => Response.json({ value: "unexpected" }));
    let detached: Promise<unknown> | undefined;

    await controller.run({
      baseUrl: "http://pgredis-runtime",
      capabilityToken: "tenant-capability-a",
      timeoutMs: 100,
    }, async () => {
      detached = Bun.sleep(10).then(() => controller.facade.get("late"));
    });

    await expect(detached).rejects.toBeInstanceOf(PgredisBindingError);
  });
});
