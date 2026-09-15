import { expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import {
  augmentManagementOpenApiDocument,
  collectManagementDocumentedRouteContracts,
  collectManagementRouteContracts,
  toManagementOpenApiPath,
} from "./route-contracts";

test("projects contracts from the compiled Elysia route table", () => {
  const body = t.Object({ name: t.String() });
  const response = t.Object({ ok: t.Boolean() });
  const app = new Elysia().post("/items/:id", () => ({ ok: true }), {
    body,
    params: t.Object({ id: t.String() }),
    headers: t.Object({ "x-request-id": t.String() }),
    cookie: t.Object({ session: t.String() }),
    response: { 201: response },
  });

  const [contract] = collectManagementRouteContracts(app);
  expect(contract).toMatchObject({ method: "POST", path: "/items/:id" });
  expect(contract?.schemas.body).toBe(body);
  expect(contract?.schemas.response).toMatchObject({ 201: expect.anything() });
  expect(Object.keys(contract?.schemas.responses ?? {})).toEqual(["201"]);
  expect(Object.isFrozen(contract?.schemas.responses)).toBe(true);
  expect(Object.isFrozen(contract)).toBe(true);
  expect(Object.isFrozen(contract?.schemas)).toBe(true);
});

test("normalizes a single response schema to a 200 response map", () => {
  const response = t.Object({ ok: t.Boolean() });
  const app = new Elysia().get("/items/:id", () => ({ ok: true }), { response });

  const [contract] = collectManagementRouteContracts(app);
  expect(contract?.schemas.response).toBe(response);
  expect(contract?.schemas.responses).toEqual({ 200: response });
  expect(Object.isFrozen(contract?.schemas.responses)).toBe(true);
});

test("documented projection excludes hidden, websocket, wildcard, and ALL routes", () => {
  const app = new Elysia()
    .get("/visible/:id", () => ({ ok: true }), { response: t.Object({ ok: t.Boolean() }) })
    .get("/hidden", () => ({ ok: true }), {
      detail: { hide: true },
      response: t.Object({ ok: t.Boolean() }),
    })
    .get("/wild/*", () => ({ ok: true }), { response: t.Object({ ok: t.Boolean() }) })
    .ws("/socket", { open() {} });

  const all = collectManagementRouteContracts(app);
  expect(all).toHaveLength(4);
  expect(collectManagementDocumentedRouteContracts(app).map((route) => route.path)).toEqual([
    "/visible/:id",
  ]);
  expect(toManagementOpenApiPath("/visible/:id")).toBe("/visible/{id}");
});

test("OpenAPI projection adds cookie parameters without redefining routes", async () => {
  const cookie = t.Object({ session: t.String() });
  const app = new Elysia().get("/items/:id", () => ({ ok: true }), {
    cookie,
    response: { 200: t.Object({ ok: t.Boolean() }), 404: t.Object({ missing: t.Boolean() }) },
  });
  const document = {
    openapi: "3.0.3",
    paths: {
      "/items/{id}": {
        get: {
          parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "OK" }, "404": { description: "Missing" } },
        },
      },
    },
  };

  const projected = augmentManagementOpenApiDocument(document, app) as {
    paths: Record<string, Record<string, { parameters: Array<Record<string, unknown>> }>>;
  };
  const parameters = projected.paths["/items/{id}"]?.get?.parameters ?? [];
  expect(parameters).toContainEqual(expect.objectContaining({
    in: "cookie",
    name: "session",
    required: true,
  }));
  expect(parameters).toContainEqual(expect.objectContaining({ in: "path", name: "id" }));
  expect(document.paths["/items/{id}"]?.get.parameters).toHaveLength(1);
});

test("leaves an OpenAPI document untouched when no projected cookie schema exists", () => {
  const document = { openapi: "3.0.3", paths: {} };
  const app = new Elysia().get("/health", () => ({ ok: true }));
  expect(augmentManagementOpenApiDocument(document, app)).toBe(document);
});
