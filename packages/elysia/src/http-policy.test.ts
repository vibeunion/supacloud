import { expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { createApplication, type CompiledModule, HttpPolicyConfigurationError } from "./index";

function moduleWith(httpPolicies: unknown, calls: string[]): CompiledModule {
  return {
    name: "policies",
    createServices: () => ({}),
    createRequestScope: () => {
      calls.push("scope");
      return { controller: { run: () => { calls.push("handler"); return "ok"; } } };
    },
    controllers: [{
      path: "/items", scope: "request", serviceKey: "controller",
      routes: [{
        method: "GET", path: "/:id", handler: "run",
        params: t.Object({ id: t.Numeric() }), data: { httpPolicies },
      }],
    }],
  };
}

test("policies compile once, execute after validation/context and before request DI", async () => {
  const calls: string[] = [];
  let factories = 0;
  const app = createApplication({
    modules: [moduleWith([{ name: "tenant", options: { required: true } }, { name: "observe" }], calls)],
    http: new Elysia().decorate("tenant", "demo"),
    requestContext: () => { calls.push("context"); return { user: "alice" }; },
    httpPolicies: {
      tenant: (options, route) => {
        factories++;
        expect(options).toEqual({ required: true });
        expect(route.path).toBe("/items/:id");
        return ({ http, requestContext }) => {
          const tenant: string = http.tenant;
          // @ts-expect-error Native plugin context must not decay to any.
          const invalid: number = http.tenant;
          expect(tenant).toBe("demo");
          expect(http.params.id).toBe(42);
          expect(requestContext).toEqual({ user: "alice" });
          calls.push("tenant");
        };
      },
      observe: () => async () => { calls.push("observe"); },
    },
  });
  for (let i = 0; i < 2; i++) {
    expect((await app.handle(new Request("http://localhost/items/42"))).status).toBe(200);
  }
  expect(factories).toBe(1);
  expect(calls).toEqual(Array(2).fill(["context", "tenant", "observe", "scope", "handler"]).flat());
  calls.length = 0;
  expect((await app.handle(new Request("http://localhost/items/bad"))).status).toBe(422);
  expect(calls).toEqual([]);
});

test("denial stops later policies and request scope construction", async () => {
  const calls: string[] = [];
  const app = createApplication({
    modules: [moduleWith([{ name: "auth" }, { name: "later" }], calls)],
    httpPolicies: {
      auth: () => () => new Response("Unauthorized", { status: 401 }),
      later: () => () => { calls.push("later"); },
    },
  });
  expect((await app.handle(new Request("http://localhost/items/1"))).status).toBe(401);
  expect(calls).toEqual([]);
});

test("unknown, inherited and malformed policy declarations fail closed at startup", () => {
  for (const declarations of [
    {}, null, new Array(1), ["auth"], [{ name: "missing" }], [{ name: "toString" }],
    [{ name: "auth", typo: true }], [{ name: 42 }],
  ]) {
    expect(() => createApplication({
      modules: [moduleWith(declarations, [])],
      httpPolicies: { auth: () => () => {} },
    })).toThrow(HttpPolicyConfigurationError);
  }
});

test("policy failures use application error mapping and do not enter the handler", async () => {
  const calls: string[] = [];
  const app = createApplication({
    modules: [moduleWith([{ name: "auth" }], calls)],
    httpPolicies: { auth: () => () => { throw new Error("denied"); } },
    errorMapper: () => new Response("Forbidden", { status: 403 }),
  });
  expect((await app.handle(new Request("http://localhost/items/1"))).status).toBe(403);
  expect(calls).toEqual([]);
});

test("policies stay route-local across siblings and concurrent requests", async () => {
  const seen: number[] = [];
  const protectedModule = moduleWith([{ name: "record" }], []);
  const publicModule = moduleWith(undefined, []);
  publicModule.name = "public";
  publicModule.controllers[0]!.path = "/public";
  const app = createApplication({
    modules: [protectedModule, publicModule],
    httpPolicies: {
      record: () => async ({ http }) => {
        const id = http.params.id as number;
        await Bun.sleep(id === 1 ? 5 : 0);
        expect(http.params.id).toBe(id);
        seen.push(id);
      },
    },
  });
  const responses = await Promise.all(["/items/1", "/items/2", "/public/3"]
    .map((path) => app.handle(new Request(`http://localhost${path}`))));
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  expect(seen.sort()).toEqual([1, 2]);
});

test("invalid factory results and option validation reject startup", () => {
  expect(() => createApplication({
    modules: [moduleWith([{ name: "broken" }], [])],
    // @ts-expect-error JavaScript consumers may supply an invalid factory.
    httpPolicies: { broken: () => null },
  })).toThrow(HttpPolicyConfigurationError);
  expect(() => createApplication({
    modules: [moduleWith([{ name: "broken" }], [])],
    httpPolicies: { broken: () => { throw new Error("options required"); } },
  })).toThrow("options required");
});
