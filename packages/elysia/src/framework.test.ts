import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { createSupaCloudFramework } from "./framework";
import { ApplicationError, type CompiledModule } from "./index";
import { createCatalogApplication } from "./examples/framework-catalog";

describe("createSupaCloudFramework", () => {
  test("provides strict SupaCloud defaults while preserving native Elysia plugins", async () => {
    const app = createSupaCloudFramework({
      name: "framework-fixture",
      http: new Elysia({ name: "fixture-http" })
        .decorate("version", "v1")
        .as("scoped"),
    }).get("/health", {
      query: t.Object({}),
    }, ({ version }) => ({ version }));

    expect((await app.handle(new Request("http://localhost/health?unexpected=true"))).status).toBe(422);
    expect(await (await app.handle(new Request("http://localhost/health"))).json()).toEqual({ version: "v1" });
  });

  test("validates compiled input before resolving identity or calling the repository", async () => {
    let calls = 0;
    const app = createCatalogApplication({
      authenticate: async () => { calls++; return { tenantId: "a", subject: "user" }; },
      read: async (_identity, id) => { calls++; return { id, name: "item" }; },
    });
    expect((await app.handle(new Request("http://localhost/catalog/item?extra=yes"))).status).toBe(422);
    expect(calls).toBe(0);
    const result = await app.handle(new Request("http://localhost/catalog/item"));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ id: "item", name: "item" });
    expect(calls).toBe(2);
  });

  test("overlapping compiled requests retain their verified tenant context", async () => {
    let arrivals = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const app = createCatalogApplication({
      // Fixed credentials for this local fixture only, not a production verifier.
      authenticate: async request => {
        const token = request.headers.get("authorization");
        if (token !== "Bearer a" && token !== "Bearer b") {
          throw new ApplicationError("Authentication required", {
            status: 401, code: "AUTHENTICATION_REQUIRED",
          });
        }
        return { tenantId: token.slice(-1), subject: "fixture-user" };
      },
      read: async (identity, id) => {
        if (++arrivals === 2) release();
        await barrier;
        return { id, name: identity.tenantId };
      },
    });
    const responses = await Promise.all(["a", "b"].map(tenant =>
      app.handle(new Request("http://localhost/catalog/item", {
        headers: { authorization: `Bearer ${tenant}` },
      }))));
    expect(await responses[0]!.json()).toEqual({ id: "item", name: "a" });
    expect(await responses[1]!.json()).toEqual({ id: "item", name: "b" });
    const denied = await app.handle(new Request("http://localhost/catalog/item"));
    expect(denied.status).toBe(401);
    expect(arrivals).toBe(2);
  });

  test("redacts repository exceptions and rejects missing command governance", async () => {
    const app = createCatalogApplication({
      authenticate: async () => ({ tenantId: "a", subject: "user" }),
      read: async () => { throw new Error("private-database-password"); },
    });
    const failed = await app.handle(new Request("http://localhost/catalog/item"));
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("private-database-password");

    const module: CompiledModule = {
      name: "writes", createServices: () => ({}), controllers: [],
      commands: [{
        className: "UpdateItem", name: "item.update", permission: "item:update",
        transaction: "required", idempotency: "required", audit: "item.updated",
      }],
    };
    expect(() => createSupaCloudFramework({ name: "writes", modules: [module] }))
      .toThrow();
  });
});
