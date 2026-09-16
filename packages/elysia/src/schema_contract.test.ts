import { expect, test } from "bun:test";
import { Elysia, status, t } from "elysia";
import { createApplication, type CompiledModule } from "./index";
import {
  createSchemaDecoder,
  defineElysiaRoute,
  defineJsonContract,
  defineRouteContract,
  registerElysiaRoute,
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
  const decode = createSchemaDecoder(t.Transform(t.String()).Decode((value) => value.length).Encode(String));
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

void routeHandlerTypes;

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
