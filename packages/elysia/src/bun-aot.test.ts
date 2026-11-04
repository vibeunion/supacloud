import { expect, test } from "bun:test";
import { createBunAotApplication, createBunApplication } from "./bun-aot";

test("Bun AOT adapter preserves the full Elysia application path", async () => {
  const app = createBunAotApplication({
    modules: [{
      name: "aot-test",
      createServices: () => ({ controller: { read: () => ({ ok: true }) } }),
      controllers: [{
        path: "",
        serviceKey: "controller",
        scope: "application",
        routes: [{
          method: "GET",
          path: "/health",
          handler: "read",
          invoker: (controller) => controller.read(),
        }],
      }],
    }],
  });
  const response = await app.fetch(new Request("http://localhost/health"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  await app.destroy();
});

test("hybrid Bun application selects native fast path for simple routes", () => {
  const app = createBunApplication({
    modules: [{
      name: "hybrid-test",
      createServices: () => ({ controller: { read: () => ({ ok: true }) } }),
      controllers: [{ path: "", serviceKey: "controller", scope: "application", routes: [{
        method: "GET", path: "/health", handler: "read", invoker: (controller) => controller.read(),
      }] }],
    }],
  });
  expect(app.mode).toBe("native");
});
