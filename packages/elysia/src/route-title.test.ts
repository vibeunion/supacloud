import { expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { createApplication, type CompiledModule } from "./index";

test("compiled route titles preserve Swagger summaries and host tags", async () => {
  const module: CompiledModule = {
    name: "route-titles",
    createServices: () => ({ controller: { read: () => ({ ok: true }) } }),
    controllers: [{
      path: "/projects",
      serviceKey: "controller",
      scope: "application",
      routes: [{
        method: "GET", path: "/environment", handler: "read",
        title: "Get project environment and platform version",
        data: { openapi: { hide: true } },
        responses: { 200: t.Object({ ok: t.Boolean() }) },
      }],
    }],
    commands: [],
    jobs: [],
  };
  const app = new Elysia()
    .guard({ detail: { tags: ["projects"] } })
    .use(createApplication({ modules: [module] }));
  const route = app.routes.find((route) => route.path === "/projects/environment");
  expect(route?.hooks.detail).toMatchObject({
    summary: "Get project environment and platform version",
    tags: ["projects"],
    hide: true,
  });
  const response = await app.handle(new Request("http://localhost/projects/environment"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
