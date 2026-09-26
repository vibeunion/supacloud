import { expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { createModulePlugin, type CompiledModule } from "./index";

function moduleFor(route: CompiledModule["controllers"][number]["routes"][number]): CompiledModule {
  return {
    name: "body-policy", createServices: () => ({}),
    controllers: [{ path: "", serviceKey: "controller", scope: "application", routes: [route] }],
  };
}

test('parse: "none" preserves request identity and malformed JSON until authorized domain parsing', async () => {
  let seen: Request | undefined;
  const module = moduleFor({
    method: "POST", path: "/raw", handler: "raw", parse: "none",
    contract: { body: "domain", response: "binary", evidence: "route-body-policy.test.ts" },
  });
  const app = new Elysia().onBeforeHandle(({ request }) => {
    if (!request.headers.has("authorization")) return new Response("denied", { status: 401 });
  }).use(createModulePlugin(module, {
    controller: { raw: async (input: { context: Request }) => {
      seen = input.context;
      expect(seen.bodyUsed).toBe(false);
      return new Response(await seen.arrayBuffer(), { headers: { "content-type": "application/octet-stream" } });
    } },
  }, request => request));
  const denied = new Request("http://localhost/raw", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  expect((await app.handle(denied)).status).toBe(401);
  expect(denied.bodyUsed).toBe(false);
  expect(seen).toBeUndefined();
  const allowed = new Request("http://localhost/raw", {
    method: "POST", headers: { "content-type": "application/json", authorization: "test" },
    body: new Uint8Array([0, 123, 255, 10]),
  });
  const response = await app.handle(allowed);
  expect(response.status).toBe(200);
  expect(seen).toBe(allowed);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 123, 255, 10]));
});

test("explicit DELETE bodies retain framework validation", async () => {
  const module = moduleFor({
    method: "DELETE", path: "/item", handler: "remove", allowDeleteBody: true,
    body: t.Object({ name: t.String() }), response: t.Object({ name: t.String() }),
  });
  let calls = 0;
  const app = createModulePlugin(module, { controller: { remove: (input: { body: { name: string } }) => { calls++; return input.body; } } });
  const request = (body: string) => new Request("http://localhost/item", { method: "DELETE", headers: { "content-type": "application/json" }, body });
  expect((await app.handle(request('{"name":3}'))).status).toBe(422);
  expect(calls).toBe(0);
  expect(await (await app.handle(request('{"name":"pgcrypto"}'))).json()).toEqual({ name: "pgcrypto" });
  expect(calls).toBe(1);
});

test("JavaScript descriptors cannot bypass the raw parsing contract", () => {
  for (const route of [
    { method: "POST" as const, path: "/", handler: "raw", parse: "none" as const },
    { method: "GET" as const, path: "/", handler: "raw", allowDeleteBody: true as const, body: t.String() },
    { method: "DELETE" as const, path: "/", handler: "raw", allowDeleteBody: true as const },
  ]) expect(() => createModulePlugin(moduleFor(route), {})).toThrow("Invalid compiled body policy");
});
