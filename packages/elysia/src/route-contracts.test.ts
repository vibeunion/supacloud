import { expect, test } from "bun:test";
import { status, t } from "elysia";
import { createApplication, type CompiledModule } from "./index";

test("enforces headers and cookies and validates status-code response maps", async () => {
  const module: CompiledModule = {
    name: "contract",
    createServices: () => ({ controller: {
      read: (request: { headers?: Record<string, unknown>; cookie?: Record<string, unknown> }) =>
        request.headers?.authorization === "Bearer conflict"
          ? status(409, { conflict: true })
          : {
              ok: request.headers?.authorization === "Bearer test" && request.cookie?.session === "s-1",
            },
    } }),
    controllers: [{
      path: "/items", serviceKey: "controller", scope: "application",
      routes: [{
        method: "GET", path: "", handler: "read",
        headers: t.Object({ authorization: t.String() }),
        cookie: t.Object({ session: t.String() }),
        responses: {
          200: t.Object({ ok: t.Boolean() }),
          409: t.Object({ conflict: t.Boolean() }),
        },
      }],
    }],
  };
  const app = createApplication({ modules: [module] });
  const invalid = await app.handle(new Request("http://localhost/items", {
    headers: { cookie: "session=s-1" },
  }));
  expect(invalid.status).toBe(422);

  const valid = await app.handle(new Request("http://localhost/items", {
    headers: { authorization: "Bearer test", cookie: "session=s-1" },
  }));
  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ ok: true });

  const conflict = await app.handle(new Request("http://localhost/items", {
    headers: { authorization: "Bearer conflict", cookie: "session=s-1" },
  }));
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ conflict: true });
});

test("passes Elysia-decoded headers to compiled handlers", async () => {
  const decodedHeader = t.Transform(t.String())
    .Decode((value) => Number(value))
    .Encode(String);
  const module: CompiledModule = {
    name: "decoded-headers",
    createServices: () => ({ controller: {
      read: (request: { headers?: Record<string, unknown> }) => ({
        value: request.headers?.["x-count"],
      }),
    } }),
    controllers: [{
      path: "/headers", serviceKey: "controller", scope: "application",
      routes: [{
        method: "GET", path: "", handler: "read",
        headers: t.Object({ "x-count": decodedHeader }),
        response: t.Object({ value: t.Number() }),
      }],
    }],
  };

  const app = createApplication({ modules: [module] });
  const response = await app.handle(new Request("http://localhost/headers", {
    headers: { "x-count": "7" },
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ value: 7 });
});
