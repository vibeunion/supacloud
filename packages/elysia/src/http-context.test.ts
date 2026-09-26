import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import {
  createApplication, createMemorySandbox, createModulePlugin, createTestApp, defineElysiaRoute, registerElysiaRoute,
  type CompiledModule,
} from "./index";

function fixture(calls: string[]): CompiledModule {
  return {
    name: "http-context",
    createServices: () => ({}),
    createRequestScope: (_services, context) => {
      calls.push("scope");
      return { controller: { run: () => context } };
    },
    destroyRequestScope: async () => { calls.push("destroy"); },
    controllers: [{
      path: "/items",
      serviceKey: "controller",
      scope: "request",
      routes: [{
        method: "POST", path: "/:id", handler: "run",
        params: t.Object({ id: t.Numeric() }),
        body: t.Object({ name: t.String() }),
      }],
    }],
  };
}

function request(id = "42", name: unknown = "item") {
  return new Request(`http://localhost/items/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tenant": id },
    body: JSON.stringify({ name }),
  });
}

describe("native HTTP context composition", () => {
  test("decorate, derive and validated resolve reach request-scoped DI in order", async () => {
    const calls: string[] = [];
    const catalog = { prefix: "tenant:" };
    const http = new Elysia()
      .decorate("catalog", catalog)
      .derive({ as: "scoped" }, ({ headers, catalog }) => {
        calls.push("derive");
        return { tenant: catalog.prefix + headers["x-tenant"] };
      })
      .resolve({ as: "scoped" }, ({ tenant, params, body }) => {
        calls.push("resolve");
        expect(typeof params.id).toBe("number");
        return { identity: { tenant }, validated: body };
      });
    const app = createApplication({
      http,
      modules: [fixture(calls)],
      requestContext: (request, context) => {
        calls.push("context");
        const tenant: string = context.identity.tenant;
        const prefix: string = context.catalog.prefix;
        // @ts-expect-error Dynamic compiled inputs cannot claim a route-specific type.
        const invalid: string = context.params.id;
        return { tenant, prefix, body: context.validated, id: context.params.id, url: request.url };
      },
    });
    const response = await app.handle(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tenant: "tenant:42", prefix: "tenant:", body: { name: "item" },
      id: 42, url: "http://localhost/items/42",
    });
    await Bun.sleep(0);
    expect(calls).toEqual(["derive", "resolve", "context", "scope", "destroy"]);
  });

  test("invalid input runs derive but never resolve, context factory or scope", async () => {
    const calls: string[] = [];
    const http = new Elysia()
      .derive({ as: "scoped" }, () => { calls.push("derive"); return {}; })
      .resolve({ as: "scoped" }, () => { calls.push("resolve"); return {}; });
    const app = createApplication({
      http, modules: [fixture(calls)],
      requestContext: () => { calls.push("context"); return {}; },
    });
    expect((await app.handle(request("bad", 12))).status).toBe(422);
    expect(calls).toEqual(["derive"]);
  });

  test("native routes retain decorator, derive and resolve inference after composition", async () => {
    const http = new Elysia()
      .decorate("catalog", { count: 7 })
      .derive({ as: "scoped" }, () => ({ tenant: "demo" }))
      .resolve({ as: "scoped" }, ({ tenant }) => ({ actor: { tenant } }));
    const app = createApplication({ http }).get("/native", ({ catalog, tenant, actor }) => {
      const count: number = catalog.count;
      const name: string = actor.tenant;
      // @ts-expect-error Context properties must not decay to any.
      const invalid: number = tenant;
      return { count, name, tenant };
    });
    expect(await (await app.handle(new Request("http://localhost/native"))).json())
      .toEqual({ count: 7, name: "demo", tenant: "demo" });
  });

  test("module plugin preserves concrete service types for native routes", async () => {
    const module = { name: "typed", createServices: () => ({}), controllers: [] };
    const plugin = createModulePlugin(module, { catalog: { count: 9 } })
      .get("/service", ({ services }) => {
        const count: number = services.catalog.count;
        // @ts-expect-error Service properties must not decay to any.
        const invalid: string = services.catalog.count;
        return count;
      });
    expect(await (await plugin.handle(new Request("http://localhost/service"))).json()).toBe(9);
  });

  test("concurrent requests keep extensions and request scopes isolated", async () => {
    const calls: string[] = [];
    const http = new Elysia()
      .derive({ as: "scoped" }, ({ headers }) => ({ tenant: headers["x-tenant"] }))
      .resolve({ as: "scoped" }, async ({ tenant }) => {
        await Bun.sleep(tenant === "1" ? 5 : 0);
        return { identity: { tenant } };
      });
    const app = createApplication({
      http, modules: [fixture(calls)],
      requestContext: (_request, context) => context.identity,
    });
    const values = await Promise.all(["1", "2", "3"].map(async (id) =>
      (await app.handle(request(id))).json()));
    expect(values).toEqual([{ tenant: "1" }, { tenant: "2" }, { tenant: "3" }]);
    await Bun.sleep(0);
    expect(calls.filter((call) => call === "destroy")).toHaveLength(3);
  });

  for (const scope of ["scoped", "global"] as const) {
    test(`named ${scope} plugins run once across modules and subsequent native routes`, async () => {
      const calls: string[] = [];
      const scoped = new Elysia({ name: `extensions-${scope}` })
        .decorate("catalog", { count: 1 })
        .derive({ as: "scoped" }, () => { calls.push("derive"); return { tenant: "demo" }; })
        .resolve({ as: "scoped" }, ({ tenant }) => { calls.push("resolve"); return { actor: tenant }; });
      const second = fixture(calls);
      second.name = "second";
      second.controllers[0]!.path = "/other";
      const modules = [fixture(calls), second];
      const app = scope === "global"
        ? createApplication({
          http: scoped.as("global"), modules,
          requestContext: (_request, context) => ({ actor: context.actor }),
        }).get("/native", ({ actor, catalog }) => ({ actor, count: catalog.count }))
        : createApplication({
          http: scoped, modules,
          requestContext: (_request, context) => ({ actor: context.actor }),
        }).get("/native", ({ actor, catalog }) => ({ actor, count: catalog.count }));
      for (const path of ["/items/1", "/other/2", "/native"]) {
        calls.length = 0;
        const response = await app.handle(path === "/native"
          ? new Request("http://localhost/native")
          : new Request(`http://localhost${path}`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "item" }),
          }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(path === "/native" ? { actor: "demo", count: 1 } : { actor: "demo" });
        expect(calls.filter((value) => value === "derive")).toHaveLength(1);
        expect(calls.filter((value) => value === "resolve")).toHaveLength(1);
        await Bun.sleep(0);
      }
    });
  }

  test("resolver early responses skip context construction and DI", async () => {
    const calls: string[] = [];
    const http = new Elysia().resolve({ as: "scoped" }, ({ status }) => status(403, "denied"));
    const app = createApplication({
      http, modules: [fixture(calls)],
      requestContext: () => { calls.push("context"); return {}; },
    });
    expect((await app.handle(request())).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("resolver errors use the adapter error mapper without creating a scope", async () => {
    const calls: string[] = [];
    const http = new Elysia().resolve({ as: "scoped" }, () => { throw new Error("private"); });
    const app = createApplication({
      http, modules: [fixture(calls)],
      errorMapper: (_error, context) => {
        expect(context.requestContext).toBeUndefined();
        return Response.json({ unavailable: true }, { status: 503 });
      },
    });
    const response = await app.handle(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ unavailable: true });
    expect(calls).toEqual([]);
  });

  test("native guard schemas type validated resolve inputs", async () => {
    const http = new Elysia()
      .guard({ body: t.Object({ name: t.String() }) })
      .resolve(({ body }) => {
        const name: string = body.name;
        // @ts-expect-error The schema must retain its inferred type.
        const invalid: number = body.name;
        return { label: name.toUpperCase() };
      }).as("scoped");
    const app = createApplication({
      http, modules: [fixture([])],
      requestContext: (_request, { label }) => ({ label }),
    });
    expect(await (await app.handle(request())).json()).toEqual({ label: "ITEM" });
  });

  test("contract route registration accepts and preserves an extended application", async () => {
    const app = createApplication({
      http: new Elysia().decorate("catalog", { count: 11 }),
    });
    const registered = registerElysiaRoute(app, defineElysiaRoute(
      "GET", "/contract", { response: t.Number() }, () => 1,
    )).get("/extension", ({ catalog }) => {
      const count: number = catalog.count;
      return count;
    });
    expect(await (await registered.handle(new Request("http://localhost/extension"))).json()).toBe(11);
  });

  test("null context is built only once and cannot be replaced by native context fields", async () => {
    const calls: string[] = [];
    const app = createApplication({
      http: new Elysia().resolve({ as: "scoped" }, () => ({ requestContext: { forged: true } })),
      modules: [fixture(calls)],
      requestContext: () => { calls.push("context"); return null; },
    });
    const response = await app.handle(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(calls.filter((call) => call === "context")).toHaveLength(1);
    expect(calls.filter((call) => call === "scope")).toHaveLength(1);
  });

  test("local plugin hooks neither leak to compiled routes nor appear as typed extensions", async () => {
    const calls: string[] = [];
    const http = new Elysia().derive(() => { calls.push("local"); return { privateValue: 1 }; });
    const app = createApplication({
      http, modules: [fixture(calls)],
      requestContext: (_request, context) => {
        // @ts-expect-error Local plugin fields do not propagate through use().
        const hidden: number = context.privateValue;
        return { visible: true };
      },
    });
    expect(await (await app.handle(request())).json()).toEqual({ visible: true });
    expect(calls).not.toContain("local");
  });

  test("test app and memory sandbox preserve HTTP extension inference", async () => {
    const http = new Elysia()
      .decorate("catalog", { count: 7 })
      .resolve({ as: "scoped" }, ({ catalog }) => ({ total: catalog.count }));
    const app = createTestApp({ http }).get("/count", ({ total }) => total);
    expect(await (await app.handle(new Request("http://localhost/count"))).json()).toBe(7);
    const sandbox = createMemorySandbox({
      http, modules: [fixture([])],
      requestContext: (_request, context) => {
        const count: number = context.total;
        // @ts-expect-error Sandbox factories retain the same inference as production.
        const invalid: string = context.total;
        return { count };
      },
    });
    expect(await (await sandbox.app.handle(request())).json()).toEqual({ count: 7 });
  });

  test("standalone module plugins infer the HTTP extension in the factory", async () => {
    const http = new Elysia().resolve({ as: "scoped" }, () => ({ label: "standalone" }));
    const plugin = createModulePlugin(fixture([]), {}, (_request, context) => {
      const label: string = context.label;
      // @ts-expect-error The options argument supplies contextual types to the factory.
      const invalid: number = context.label;
      return { label };
    }, { http });
    expect(await (await plugin.handle(request())).json()).toEqual({ label: "standalone" });
  });

  test("request-scoped cleanup still runs when a handler throws", async () => {
    const calls: string[] = [];
    const module = fixture(calls);
    module.createRequestScope = () => ({
      controller: { run: () => { throw new Error("private"); } },
    });
    const app = createApplication({
      http: new Elysia().resolve({ as: "scoped" }, () => ({ trace: "request-1" })),
      modules: [module],
      requestContext: (_request, context) => ({ trace: context.trace }),
      errorMapper: (_error, context) => {
        expect(context.requestContext).toEqual({ trace: "request-1" });
        return Response.json({ failed: true }, { status: 500 });
      },
    });
    expect((await app.handle(request())).status).toBe(500);
    await Bun.sleep(0);
    expect(calls).toEqual(["destroy"]);
  });

  test("anonymous global hooks execute once across modules and native routes", async () => {
    const calls: string[] = [];
    const http = new Elysia()
      .derive({ as: "global" }, () => { calls.push("derive"); return { label: "global" }; })
      .resolve({ as: "global" }, ({ label }) => { calls.push("resolve"); return { actor: label }; });
    const second = fixture(calls);
    second.name = "second";
    second.controllers[0]!.path = "/other";
    const app = createApplication({
      http, modules: [fixture(calls), second],
      requestContext: (_request, context) => ({ actor: context.actor }),
    }).get("/native", ({ actor }) => ({ actor }));
    for (const path of ["/items/1", "/other/2", "/native"]) {
      calls.length = 0;
      const response = await app.handle(path === "/native"
        ? new Request("http://localhost/native")
        : new Request(`http://localhost${path}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "item" }),
        }));
      expect(await response.json()).toEqual({ actor: "global" });
      expect(calls.filter((call) => call === "derive")).toHaveLength(1);
      expect(calls.filter((call) => call === "resolve")).toHaveLength(1);
      await Bun.sleep(0);
    }
  });

  test("sibling module service names retain their own runtime values and types", async () => {
    const firstServices = { settings: { value: 7 } };
    const secondServices = { settings: { value: "second" } };
    const first = createModulePlugin(
      { name: "first", createServices: () => firstServices, controllers: [] }, firstServices,
    ).get("/first", ({ services }) => {
      const value: number = services.settings.value;
      return value.toFixed(1);
    });
    const second = createModulePlugin(
      { name: "second", createServices: () => secondServices, controllers: [] }, secondServices,
    ).get("/second", ({ services }) => {
      const value: string = services.settings.value;
      return value.toUpperCase();
    });
    const app = new Elysia().use(first).use(second);
    expect(await (await app.handle(new Request("http://localhost/first"))).text()).toBe("7.0");
    expect(await (await app.handle(new Request("http://localhost/second"))).text()).toBe("SECOND");
    expect(firstServices).toEqual({ settings: { value: 7 } });
    expect(secondServices).toEqual({ settings: { value: "second" } });
  });
});
