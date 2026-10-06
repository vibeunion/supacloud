import { expect, test } from "bun:test";
import { Elysia, status, t } from "elysia";
import { Type } from "typebox";
import { ApplicationError, createApplication, type CompiledModule } from "./index";
import {
  createSchemaDecoder,
  defineElysiaRoute,
  defineJsonContract,
  defineRouteContract,
  registerElysiaRoute,
  responseStatusOf,
  SchemaContractError,
  toElysiaRouteSchema,
} from "./schema_contract";

const body = t.Object({ name: t.String({ minLength: 1 }) });
const response = t.Object({ version: t.Integer({ minimum: 1 }) });
const contract = defineJsonContract({ body, response }, (input) => ({
  method: "POST", url: "/items", body: input,
}));

test("schema-derived decoders reject malformed values without exposing submitted data", () => {
  expect(contract.body).toBe(body);
  expect(contract.response).toBe(response);
  expect(contract.input({ name: "valid" })).toEqual({ name: "valid" });
  expect(contract.result({ version: 1 })).toEqual({ version: 1 });
  for (const value of [null, {}, { version: "secret" }, { version: 0 }]) {
    expect(() => contract.result(value)).toThrow(SchemaContractError);
  }
  try {
    contract.result({ version: "secret" });
  } catch (error) {
    expect(String(error)).not.toContain("secret");
  }
});

test("the same contract rejects invalid HTTP input before writes and invalid output after one write", async () => {
  let writes = 0;
  const module: CompiledModule = {
    name: "items",
    createServices: () => ({ controller: { save: () => {
      writes++;
      return { version: "invalid" };
    } } }),
    controllers: [{
      path: "/items", serviceKey: "controller", scope: "application",
      routes: [{ method: "POST", path: "", handler: "save", ...contract }],
    }],
  };
  const app = createApplication({ modules: [module] });
  const invalid = await app.handle(new Request("http://localhost/items", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: 1 }),
  }));
  expect(invalid.status).toBe(422);
  expect(writes).toBe(0);
  const result = await app.handle(new Request("http://localhost/items", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "valid" }),
  }));
  expect(result.status).toBe(500);
  expect(writes).toBe(1);
});

test("schema transforms preserve the decoded output type", () => {
  const decode = createSchemaDecoder(Type.Codec(t.String()).Decode((value) => value.length).Encode(String));
  const length: number = decode("abc");
  expect(length).toBe(3);
});

// Consumer negative fixtures, checked by typecheck:test.
function schemaTypes() {
  const result: { version: number } = contract.result({ version: 1 });
  const input: { name: string } = contract.input({ name: "valid" });
  // @ts-expect-error Request input is inferred from the schema.
  contract.request({ name: 1 });
  // @ts-expect-error The response type is not chosen by the consumer.
  const wrong: { version: string } = contract.result({});
  // @ts-expect-error A return type cannot be asserted through the schema parameter.
  createSchemaDecoder<{ version: string }>(response);
  return { input, result };
}

const routeContract = defineRouteContract({
  body: t.Object({ name: t.String({ minLength: 1 }) }),
  params: t.Object({ id: t.String({ minLength: 1 }) }),
  query: t.Object({ verbose: t.Optional(t.Boolean()) }),
  headers: t.Object({ authorization: t.String({ minLength: 1 }) }),
  cookie: t.Object({ session: t.String({ minLength: 1 }) }),
  responses: {
    "200": t.Object({ id: t.String(), name: t.String(), verbose: t.Boolean() }),
    "409": t.Object({ conflict: t.Literal(true) }),
  },
});

const route = defineElysiaRoute(
  "POST",
  "/items/:id",
  routeContract,
  ({ body, params, query, headers, cookie, status: responseStatus }) => {
    const id: string = params.id;
    const name: string = body.name;
    const authorization: string = headers.authorization;
    const session: string = cookie.session.value;
    const verbose: boolean = query.verbose ?? false;
    if (name === "existing") return responseStatus(409, { conflict: true });
    return { id, name: `${authorization}:${session}:${name}`, verbose };
  },
);

const legacyResponseContract = defineRouteContract({
  response: t.Object({ ok: t.Boolean() }),
});
const legacyResponseRoute = defineElysiaRoute(
  "GET",
  "/legacy",
  legacyResponseContract,
  () => ({ ok: true }),
);

const fallbackResponseContract = defineRouteContract({
  responses: {
    default: t.Object({ kind: t.Literal("fallback") }),
    "4XX": t.Object({ kind: t.Literal("client") }),
    "5XX": t.Object({ kind: t.Literal("server") }),
    404: t.Object({ kind: t.Literal("not-found") }),
  },
});
const fallbackResponseRoute = defineElysiaRoute(
  "GET",
  "/fallback/:mode",
  fallbackResponseContract,
  ({ params, status: responseStatus }) => {
    if (params.mode === "not-found") return responseStatus(404, { kind: "not-found" });
    if (params.mode === "client") return responseStatus(418, { kind: "client" });
    if (params.mode === "server") return responseStatus(503, { kind: "server" });
    return responseStatus(302, { kind: "fallback" });
  },
);

const createdOnlyContract = defineRouteContract({
  responses: { 201: t.Object({ created: t.Boolean() }) },
});
const createdOnlyRoute = defineElysiaRoute(
  "GET",
  "/created-only",
  createdOnlyContract,
  ({ status: responseStatus }) => responseStatus(201, { created: true }),
);

const mixedResponseContract = defineRouteContract({
  responses: {
    200: t.Object({ ok: t.Literal(true) }),
    201: t.Object({ created: t.Literal(true) }),
  },
});
const mixedResponseRoute = defineElysiaRoute(
  "GET",
  "/mixed-response",
  mixedResponseContract,
  () => ({ ok: true }),
);

function routeHandlerTypes() {
  // @ts-expect-error Route params are decoded from the declared schema.
  route.handler({ params: { id: 1 } });
  // @ts-expect-error The response map rejects an undeclared status payload.
  const invalid: ReturnType<typeof route.handler> = { conflict: false };
  const typed: typeof route.handler = ({ status: responseStatus }) => {
    // @ts-expect-error The declared 409 payload is literal true.
    return responseStatus(409, { conflict: false });
  };
  void typed;
  return invalid;
}

function fallbackResponseTypes() {
  const typed: typeof fallbackResponseRoute.handler = ({ status: responseStatus }) => {
    const client = responseStatus(429, { kind: "client" });
    const server = responseStatus(503, { kind: "server" });
    const fallback = responseStatus(302, { kind: "fallback" });
    // @ts-expect-error An exact status overrides its family selector.
    responseStatus(404, { kind: "client" });
    // @ts-expect-error A 4XX response cannot use the default payload.
    responseStatus(409, { kind: "fallback" });
    // @ts-expect-error A 5XX response cannot use the default payload.
    responseStatus(500, { kind: "fallback" });
    return Math.random() > 0.5 ? client : Math.random() > 0.5 ? server : fallback;
  };
  void typed;
}

function createdOnlyResponseTypes() {
  // @ts-expect-error A plain return defaults to HTTP 200, which is absent from this map.
  const typed: typeof createdOnlyRoute.handler = () => {
    return { created: true };
  };
  void typed;
}

function mixedResponseTypes() {
  const valid: typeof mixedResponseRoute.handler = () => ({ ok: true });
  // @ts-expect-error A plain return is always HTTP 200; use status(201, value) for the 201 payload.
  const invalid: typeof mixedResponseRoute.handler = () => ({ created: true });
  void valid;
  void invalid;
}

void routeHandlerTypes;
void legacyResponseRoute;
void fallbackResponseTypes;
void createdOnlyResponseTypes;
void mixedResponseTypes;

test("binds one contract to an Elysia-native handler and runtime route", async () => {
  const schema = toElysiaRouteSchema(routeContract);
  expect(schema.body).toBe(routeContract.body);
  expect(schema.response).toBe(routeContract.responses);
  expect("responses" in schema).toBe(false);

  const app = registerElysiaRoute(new Elysia(), route);
  expect(route.contract).toBe(routeContract);
  const response = await app.handle(new Request("http://localhost/items/item-1?verbose=true", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      cookie: "session=s-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "demo" }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    id: "item-1",
    name: "Bearer test:s-1:demo",
    verbose: true,
  });

  const conflict = await app.handle(new Request("http://localhost/items/item-1", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      cookie: "session=s-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "existing" }),
  }));
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ conflict: true });

  const invalid = await app.handle(new Request("http://localhost/items/item-1", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      cookie: "session=s-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: 1 }),
  }));
  expect(invalid.status).toBe(422);
});

test("schema decoders follow Elysia normalization by default and allow an explicit strict mode", () => {
  const schema = t.Object({ name: t.String() });
  expect(createSchemaDecoder(schema)({ name: "item", ignored: true })).toEqual({ name: "item" });
  expect(() => createSchemaDecoder(schema, { normalize: false })({ name: "item", ignored: true }))
    .toThrow(SchemaContractError);
});

test("expands default and status-family response selectors for Elysia runtime validation", async () => {
  const schema = toElysiaRouteSchema(fallbackResponseContract);
  const responseMap = schema.response as Record<string, unknown>;
  expect(Object.keys(responseMap)).toHaveLength(500);
  expect(responseMap["302"]).toBe(fallbackResponseContract.responses?.default);
  expect(responseMap["409"]).toBe(fallbackResponseContract.responses?.["4XX"]);
  expect(responseMap["418"]).toBe(fallbackResponseContract.responses?.["4XX"]);
  expect(responseMap["404"]).toBe(fallbackResponseContract.responses?.[404]);
  expect(responseMap["503"]).toBe(fallbackResponseContract.responses?.["5XX"]);

  const module: CompiledModule = {
    name: "fallback-response",
    createServices: () => ({ controller: {
      handle: (request: { params?: Record<string, string> }) => {
        const mode = request.params?.mode;
        if (mode === "not-found") return status(404, { kind: "not-found" });
        if (mode === "client") return status(418, { kind: "client" });
        if (mode === "server") return status(503, { kind: "server" });
        return status(302, { kind: "fallback" });
      },
    } }),
    controllers: [{
      path: "/fallback", serviceKey: "controller", scope: "application",
      routes: [{
        method: "GET", path: "/:mode", handler: "handle",
        responses: fallbackResponseContract.responses,
      }],
    }],
  };
  const app = createApplication({ modules: [module] });
  for (const [mode, expectedStatus, expectedBody] of [
    ["not-found", 404, { kind: "not-found" }],
    ["client", 418, { kind: "client" }],
    ["server", 503, { kind: "server" }],
    ["redirect", 302, { kind: "fallback" }],
  ] as const) {
    const response = await app.handle(new Request(`http://localhost/fallback/${mode}`));
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual(expectedBody);
  }

  const invalidModule: CompiledModule = {
    ...module,
    name: "invalid-fallback-response",
    createServices: () => ({ controller: {
      handle: () => status(502, { kind: "wrong" }),
    } }),
  };
  const invalidResponse = await createApplication({ modules: [invalidModule] })
    .handle(new Request("http://localhost/fallback/server"));
  expect(invalidResponse.status).toBe(500);
});

test("rejects an undeclared plain response status before Elysia can silently accept it", async () => {
  const app = registerElysiaRoute(new Elysia(), createdOnlyRoute);
  const valid = await app.handle(new Request("http://localhost/created-only"));
  expect(valid.status).toBe(201);
  expect(await valid.json()).toEqual({ created: true });

  const invalidRoute = {
    ...createdOnlyRoute,
    path: "/created-only-invalid",
    handler: (() => ({ created: true })) as unknown as typeof createdOnlyRoute.handler,
  } as unknown as typeof createdOnlyRoute;
  const invalid = registerElysiaRoute(new Elysia(), invalidRoute);
  const response = await invalid.handle(new Request("http://localhost/created-only-invalid"));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({
    status: 500,
    detail: "Response validation failed",
  });
});

test("rejects response selectors that Elysia would otherwise ignore", () => {
  expect(() => toElysiaRouteSchema({
    responses: { fallback: t.Object({ ok: t.Boolean() }) },
  })).toThrow(/Unsupported response selector/);
});

test("accepts plain JSON Schema objects as legacy response schemas", () => {
  const response = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };
  expect(toElysiaRouteSchema({ response }).response).toBe(response);
});

test("rejects contracts that declare both legacy and status-map responses", () => {
  const conflictingContract = {
    response: t.Object({ ok: t.Boolean() }),
    responses: { 200: t.Object({ ok: t.Boolean() }) },
  };
  expect(() => toElysiaRouteSchema(conflictingContract)).toThrow(/both response and responses/);
  expect(() => defineElysiaRoute(
    "GET",
    "/conflicting-responses",
    conflictingContract,
    () => ({ ok: true }),
  )).toThrow(/both response and responses/);
});

test("rejects duplicate response-family selectors that differ only by case", () => {
  const duplicateContract = {
    responses: {
      "4XX": t.Object({ kind: t.Literal("upper") }),
      "4xx": t.Object({ kind: t.Literal("lower") }),
    },
  };
  expect(() => toElysiaRouteSchema(duplicateContract)).toThrow(
    /Duplicate response selectors "4XX" and "4xx" differ only by case/,
  );
  expect(() => defineElysiaRoute(
    "GET",
    "/duplicate-response-family",
    duplicateContract,
    () => new Response(),
  )).toThrow(/Duplicate response selectors/);
});

test("does not treat domain payloads with code and response fields as HTTP status objects", async () => {
  expect(responseStatusOf({ code: 404, response: "not-found" }, undefined)).toBe(200);
  expect(responseStatusOf({ code: 404, response: "not-found" }, 201)).toBe(201);
  expect(responseStatusOf(status(404, { kind: "not-found" }), undefined)).toBe(404);
  expect(responseStatusOf(new Response(null, { status: 201 }), undefined)).toBe(201);

  const payloadContract = defineRouteContract({
    responses: {
      200: t.Object({ code: t.Number(), response: t.String() }),
      404: t.Object({ kind: t.Literal("not-found") }),
    },
  });
  const payloadRoute = defineElysiaRoute(
    "GET",
    "/payload-status",
    payloadContract,
    () => ({ code: 404, response: "not-found" }),
  );
  const response = await registerElysiaRoute(new Elysia(), payloadRoute)
    .handle(new Request("http://localhost/payload-status"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ code: 404, response: "not-found" });
});

test("end-to-end schema contract derives handler context and client types with zero codegen", async () => {
  const inputSchema = t.Object({
    title: t.String({ minLength: 2 }),
    tags: t.Array(t.String()),
  });
  const outputSchema = t.Object({
    id: t.String(),
    title: t.String(),
    tagCount: t.Integer(),
  });

  const contract = defineJsonContract(
    { body: inputSchema, response: outputSchema },
    (input) => ({ method: "POST", url: "/posts", body: input }),
  );

  // Inferred client contract types (matches Static<typeof Schema> directly)
  type InferredInput = Parameters<typeof contract.request>[0];
  type InferredResult = ReturnType<typeof contract.result>;

  // @ts-expect-error The request contract rejects non-string titles.
  const invalidPayload: InferredInput = { title: 123, tags: [] };
  void invalidPayload;
  const payload: InferredInput = { title: "Elysia 2", tags: ["framework", "aot"] };
  expect(contract.input(payload)).toEqual(payload);

  // Server-side route handler with automatic type inference
  const postRoute = defineElysiaRoute(
    "POST",
    "/posts",
    { body: inputSchema, responses: { 200: outputSchema } },
    ({ body }) => ({
      id: "p-1",
      title: body.title,
      tagCount: body.tags.length,
    }),
  );

  const app = registerElysiaRoute(new Elysia(), postRoute);
  const response = await app.handle(new Request("http://localhost/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }));

  expect(response.status).toBe(200);
  const json: unknown = await response.json();
  const result: InferredResult = contract.result(json);
  expect(result).toEqual({ id: "p-1", title: "Elysia 2", tagCount: 2 });
});

const transformContract = defineRouteContract({
  query: t.Object({
    page: t.Numeric(),
    flags: t.Optional(t.String()),
  }),
  headers: t.Object({ "x-retry": t.Optional(t.Numeric()) }),
  responses: { 200: t.Object({ page: t.Number(), retry: t.Number() }) },
});
const transformRoute = defineElysiaRoute(
  "GET",
  "/transform",
  transformContract,
  ({ query, headers }) => {
    // `t.Numeric()` is decoded before the handler runs, so the handler sees a
    // number even though the wire format is a numeric string.
    const page: number = query.page;
    const retry: number = headers["x-retry"] ?? 0;
    return { page, retry };
  },
);

test("typed error handlers preserve normalized mapper codes", async () => {
  const codes: (string | number | undefined)[] = [];
  const module: CompiledModule = {
    name: "normalized-errors",
    createServices: () => ({
      controller: {
        run: () => {
          throw new ApplicationError("Conflict", { status: 409, code: "version-conflict" });
        },
      },
    }),
    controllers: [{
      path: "/normalized", serviceKey: "controller", scope: "application",
      routes: [{ method: "GET", path: "", handler: "run" }],
    }],
  };
  const app = createApplication({
    modules: [module],
    errorMapper: (_error, context) => {
      codes.push(context.frameworkCode);
      return undefined;
    },
  });
  const result = await app.handle(new Request("http://localhost/normalized"));
  expect(result.status).toBe(409);
  expect(codes).toEqual(["VERSION_CONFLICT"]);
});

function transformTypes() {
  const base = new Elysia().get("/existing", () => ({ id: 1 }));
  const registered = registerElysiaRoute(base, transformRoute);
  const preserved: typeof base = registered;
  // Runtime-only registration must not invent a string-indexed route tree.
  const knownPath: keyof typeof registered["~Routes"] = "existing";
  // @ts-expect-error Unknown routes must remain invalid.
  const missingPath: keyof typeof registered["~Routes"] = "missing";
  // @ts-expect-error Contract registration does not add Eden route inference.
  const runtimePath: keyof typeof registered["~Routes"] = "transform";
  void [preserved, knownPath, missingPath, runtimePath];
  const typed: typeof transformRoute.handler = ({ query }) => {
    // @ts-expect-error A decoded numeric query field is not a string.
    const wrong: string = query.page;
    void wrong;
    return { page: query.page, retry: 0 };
  };
  void typed;
}

void transformTypes;

test("decodes TypeBox transforms into the strongly-typed handler context", async () => {
  const app = registerElysiaRoute(new Elysia(), transformRoute);
  const response = await app.handle(new Request("http://localhost/transform?page=3", {
    headers: { "x-retry": "2" },
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ page: 3, retry: 2 });
});

test("registerElysiaRoute chains runtime registrations on the same instance", async () => {
  const chainContract = defineRouteContract({
    responses: { 200: t.Object({ chained: t.Literal(true) }) },
  });
  const chainRoute = defineElysiaRoute(
    "GET",
    "/chained",
    chainContract,
    () => ({ chained: true as const }),
  );
  // Registering twice must keep both routes reachable at runtime.
  const app = registerElysiaRoute(
    registerElysiaRoute(new Elysia(), route),
    chainRoute,
  );
  const original = await app.handle(new Request("http://localhost/items/item-1", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      cookie: "session=s-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "demo" }),
  }));
  const chained = await app.handle(new Request("http://localhost/chained"));
  expect(original.status).toBe(200);
  expect(await chained.json()).toEqual({ chained: true });
});

test("ElysiaRouteContext set.headers accepts both strings and numbers", async () => {
  const customHeaderContract = defineRouteContract({
    responses: { 200: t.Object({ ok: t.Boolean() }) },
  });
  const customHeaderRoute = defineElysiaRoute(
    "GET",
    "/custom-headers",
    customHeaderContract,
    ({ set }) => {
      set.headers["x-ratelimit-remaining"] = 100;
      set.headers["x-custom-tag"] = "test";
      return { ok: true };
    },
  );
  const app = registerElysiaRoute(new Elysia(), customHeaderRoute);
  const res = await app.handle(new Request("http://localhost/custom-headers"));
  expect(res.status).toBe(200);
  expect(res.headers.get("x-ratelimit-remaining")).toBe("100");
  expect(res.headers.get("x-custom-tag")).toBe("test");
});
