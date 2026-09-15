import type { StaticDecode, TSchema } from "@sinclair/typebox";

/** The schema fields understood by every SupaCloud HTTP route. */
export interface RouteContractSchemas {
  body?: unknown | undefined;
  params?: unknown | undefined;
  query?: unknown | undefined;
  headers?: unknown | undefined;
  cookie?: unknown | undefined;
  /** @deprecated Use `responses` with an explicit HTTP status map. */
  response?: unknown | undefined;
  responses?: Readonly<Record<string | number, unknown>> | undefined;
}

type DecodeSchema<Schema> = Schema extends TSchema ? StaticDecode<Schema> : unknown;

/** A response map is keyed by the HTTP status code emitted by the handler. */
export type RouteResponseMap<Schemas extends RouteContractSchemas> =
  Schemas["responses"] extends Readonly<Record<string | number, unknown>>
    ? { [Code in keyof Schemas["responses"]]: DecodeSchema<Schemas["responses"][Code]> }
    : never;

/** The decoded request envelope supplied to a schema-aware route handler. */
export interface RouteHandlerInput<Schemas extends RouteContractSchemas = RouteContractSchemas> {
  body: DecodeSchema<Schemas["body"]>;
  params: DecodeSchema<Schemas["params"]>;
  query: DecodeSchema<Schemas["query"]>;
  headers: DecodeSchema<Schemas["headers"]>;
  cookie: DecodeSchema<Schemas["cookie"]>;
  request: Request;
  context: unknown;
}

/** The decoded result type for a single response schema or a status-code map. */
export type RouteHandlerOutput<Schemas extends RouteContractSchemas = RouteContractSchemas> =
  Schemas["responses"] extends Readonly<Record<string | number, unknown>>
    ? RouteResponseMap<Schemas>[keyof RouteResponseMap<Schemas>]
    : DecodeSchema<Schemas["response"]>;

/** Function shape for handlers that consume the complete decoded route envelope. */
export type RouteHandler<Schemas extends RouteContractSchemas = RouteContractSchemas> = (
  input: RouteHandlerInput<Schemas>,
) => RouteHandlerOutput<Schemas> | Promise<RouteHandlerOutput<Schemas>>;

/**
 * A handler together with the contract it was authored against. The binding
 * is useful for functional route registration and keeps the contract visible
 * to tooling without making callers repeat a generic type argument.
 */
export interface RouteHandlerBinding<Schemas extends RouteContractSchemas = RouteContractSchemas> {
  readonly contract: Readonly<Schemas>;
  readonly handler: RouteHandler<Schemas>;
}

/**
 * Keeps a route's schemas together so the same object can be reused by
 * decorators, generated clients and documentation tooling.
 */
export function defineRouteContract<const Schemas extends RouteContractSchemas>(
  schemas: Schemas,
): Readonly<Schemas> {
  return Object.freeze({ ...schemas });
}

/**
 * Contextually types a route handler from the contract passed as the first
 * argument. `NoInfer` deliberately makes the schema value the sole source of
 * the handler's input and output types.
 */
export function defineRouteHandler<const Schemas extends RouteContractSchemas>(
  contract: Schemas,
  handler: RouteHandler<NoInfer<Schemas>>,
): RouteHandler<Schemas> {
  return handler;
}

/**
 * Creates a portable contract/handler pair for functional adapters. This is
 * the object form of `defineRouteHandler`; both APIs share the same inferred
 * handler type and schema identity.
 */
export function defineTypedRoute<const Schemas extends RouteContractSchemas>(
  contract: Schemas,
  handler: RouteHandler<NoInfer<Schemas>>,
): RouteHandlerBinding<Schemas> {
  return Object.freeze({
    contract,
    handler,
  });
}
