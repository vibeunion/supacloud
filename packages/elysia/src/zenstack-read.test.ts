import { expect, test } from "bun:test";
import { t } from "elysia";
import { createZenStackReadPlugin } from "./zenstack-read";

test("ZenStack read adapter binds identity per request and exposes only explicit reads", async () => {
  const calls: Array<{ identity: unknown; args: unknown }> = [];
  const app = createZenStackReadPlugin({
    resources: [{
      path: "/model/orders/:id",
      model: "order",
      operation: "findUnique",
      contract: {
        params: t.Object({ id: t.String() }),
        responses: { 200: t.Object({ id: t.String(), tenantId: t.String() }) },
      },
      args: ({ params, identity }) => ({ where: { id: params["id"], tenantId: identity } }),
    }],
    bindIdentity: request => ({
      identity: request.headers.get("x-tenant") ?? "missing",
      models: {
        order: {
          findUnique: async (args: unknown) => {
            calls.push({ identity: request.headers.get("x-tenant"), args });
            return { id: "o-1", tenantId: request.headers.get("x-tenant") ?? "missing" };
          },
          delete: async () => { throw new Error("must never be exposed"); },
        },
      },
    }),
  });

  const first = await app.handle(new Request("http://local/model/orders/o-1", { headers: { "x-tenant": "a" } }));
  const second = await app.handle(new Request("http://local/model/orders/o-1", { headers: { "x-tenant": "b" } }));
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(calls).toEqual([
    { identity: "a", args: { where: { id: "o-1", tenantId: "a" } } },
    { identity: "b", args: { where: { id: "o-1", tenantId: "b" } } },
  ]);
  expect(await app.handle(new Request("http://local/model/orders/o-1", { method: "POST" }))).toHaveProperty("status", 404);
});

test("ZenStack read adapter rejects write operations at composition time", () => {
  expect(() => createZenStackReadPlugin({
    resources: [{ path: "/model/orders", model: "order", operation: "delete" as never }],
    bindIdentity: () => ({ identity: "x", models: {} }),
  })).toThrow("Unsupported ZenStack read operation");
});
