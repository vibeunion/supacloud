import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import {
  defineRouteHandler,
  defineRouteContract,
  defineTypedRoute,
  type RouteHandler,
  type RouteHandlerBinding,
  type RouteHandlerInput,
  type RouteHandlerOutput,
} from "./route_contract";

const contract = defineRouteContract({
  body: Type.Object({ name: Type.String() }),
  params: Type.Object({ id: Type.String() }),
  headers: Type.Object({ authorization: Type.String() }),
  cookie: Type.Object({ session: Type.String() }),
  responses: {
    200: Type.Object({ ok: Type.Boolean() }),
    202: Type.Object({ accepted: Type.Boolean() }),
  },
});

test("keeps all route schemas in one reusable immutable contract", () => {
  expect(contract.body).toBeDefined();
  expect(contract.responses?.[200]).toBeDefined();
  expect(Object.isFrozen(contract)).toBe(true);
});

function typedHandler(input: RouteHandlerInput<typeof contract>): RouteHandlerOutput<typeof contract> {
  const name: string = input.body.name;
  const id: string = input.params.id;
  const authorization: string = input.headers.authorization;
  const session: string = input.cookie.session;
  return { ok: Boolean(name && id && authorization && session) };
}

const handler: RouteHandler<typeof contract> = typedHandler;
void handler;

const inferredHandler = defineRouteHandler(contract, ({ body, params, headers, cookie }) => ({
  ok: Boolean(body.name && params.id && headers.authorization && cookie.session),
}));

const typedRoute = defineTypedRoute(contract, inferredHandler);
const typedRouteBinding: RouteHandlerBinding<typeof contract> = typedRoute;
void typedRouteBinding;

test("binds callback handler types to the contract without a second generic source", () => {
  expect(typeof inferredHandler).toBe("function");
  expect(typedRoute.contract).toBe(contract);
  expect(typedRoute.handler).toBe(inferredHandler);
});

function routeContractTypes() {
  // @ts-expect-error body is decoded from the declared schema.
  const invalidBody: RouteHandlerInput<typeof contract> = { body: { name: 1 } };
  // @ts-expect-error The callback return is checked against every declared response.
  defineRouteHandler(contract, () => ({ ok: "not-a-boolean" }));
  return invalidBody;
}

void routeContractTypes;
