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
  const app = new Elysia().post("/items/:id", {
    body,
    params: t.Object({ id: t.String() }),
    headers: t.Object({ "x-request-id": t.String() }),
    cookie: t.Object({ session: t.String() }),
    response: { 201: response },
  }, () => ({ ok: true }));

  const [contract] = collectManagementRouteContracts(app);
  expect(contract).toMatchObject({ method: "POST", path: "/items/:id" });
  expect(contract?.schemas.body).toEqual(body);
  expect(contract?.schemas.response).toMatchObject({ 201: expect.anything() });
  expect(Object.keys(contract?.schemas.responses ?? {})).toEqual(["201"]);
  expect(Object.isFrozen(contract?.schemas.responses)).toBe(true);
  expect(Object.isFrozen(contract)).toBe(true);
  expect(Object.isFrozen(contract?.schemas)).toBe(true);
});

test("normalizes a single response schema to a 200 response map", () => {
  const response = t.Object({ ok: t.Boolean() });
  const app = new Elysia().get("/items/:id", { response }, () => ({ ok: true }));

  const [contract] = collectManagementRouteContracts(app);
  expect(contract?.schemas.response).toEqual({ 200: response });
  expect(contract?.schemas.responses).toEqual({ 200: response });
  expect(Object.isFrozen(contract?.schemas.responses)).toBe(true);
});

test("preserves status-family and default response selectors in route projections", () => {
  const client = t.Object({ code: t.String() });
  const server = t.Object({ code: t.String() });
  const fallback = t.Object({ code: t.String() });
  const app = { routes: [{
    method: "GET", path: "/selector",
    hooks: { response: { 404: client, "4XX": client, "5xx": server, default: fallback } },
  }] };

  const [contract] = collectManagementRouteContracts(app);
  expect(contract?.schemas.responses).toEqual({
    "404": client,
    "4XX": client,
    "5XX": server,
    default: fallback,
  });
  expect(contract?.schemas.response).toBeDefined();
});

test("rejects mixed valid and invalid response selectors instead of wrapping the map as a 200 schema", () => {
  const app = { routes: [{
    method: "GET", path: "/invalid-selector",
    hooks: { response: { 200: t.String(), invalid: t.String() } },
  }] };

  expect(() => collectManagementRouteContracts(app)).toThrow(
    'Unsupported response selector "invalid"',
  );
});

test("keeps a JSON Schema with a default keyword as a single response schema", () => {
  const response = t.String({ default: "ok" });
  const app = new Elysia().get("/default-value", { response }, () => "ok");

  const [contract] = collectManagementRouteContracts(app);
  expect(contract?.schemas.responses).toEqual({ 200: response });
});

test("documented projection excludes hidden, websocket, wildcard, and ALL routes", () => {
  const app = new Elysia()
    .get("/visible/:id", { response: t.Object({ ok: t.Boolean() }) }, () => ({ ok: true }))
    .get("/hidden", {
      detail: { hide: true },
      response: t.Object({ ok: t.Boolean() }),
    }, () => ({ ok: true }))
    .get("/wild/*", { response: t.Object({ ok: t.Boolean() }) }, () => ({ ok: true }))
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
  const app = new Elysia().get("/items/:id", {
    cookie,
    response: { 200: t.Object({ ok: t.Boolean() }), 404: t.Object({ missing: t.Boolean() }) },
  }, () => ({ ok: true }));
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

test("projects optional custom-parser bodies without mutating the OpenAPI document", () => {
  const body = t.Optional(t.Object({ enabled: t.Optional(t.Boolean()) }));
  const app = new Elysia().post("/settings", {
    body,
    parse: async ({ request }) => JSON.parse(await request.text() || "{}"),
  }, ({ body }) => body);
  const document = {
    openapi: "3.0.3",
    paths: { "/settings": { post: { requestBody: { required: true, content: {} } } } },
  };
  expect(augmentManagementOpenApiDocument(document, app)).toMatchObject({
    paths: {
      "/settings": {
        post: {
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { type: "object", properties: { enabled: { type: "boolean" } } },
              },
            },
          },
        },
      },
    },
  });
  expect(document.paths["/settings"].post.requestBody).toEqual({ required: true, content: {} });
});
