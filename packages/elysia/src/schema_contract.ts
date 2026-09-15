import {
  getSchemaValidator,
  type Cookie,
  type Elysia,
  type ElysiaCustomStatusResponse,
  type HTTPMethod,
  type InputSchema,
  type MaybePromise,
  type TSchema,
  type UnwrapSchema,
} from "elysia";

/** The schema fields shared by Elysia routes, generated clients and docs. */
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

type ResponseField<Schemas extends RouteContractSchemas> =
  NonNullable<Schemas["responses"]> extends Readonly<Record<string | number, unknown>>
    ? NonNullable<Schemas["responses"]>
    : NonNullable<Schemas["response"]> extends TSchema | Readonly<Record<string | number, unknown>>
      ? NonNullable<Schemas["response"]>
      : undefined;

type NumericResponseMap<Value> = Value extends Readonly<Record<string | number, unknown>>
  ? {
      [Key in keyof Value as Key extends number
        ? Key
        : Key extends `${infer Numeric extends number}` ? Numeric : never]: Value[Key]
    }
  : Value;

type DecodedSchema<Value> = Value extends TSchema ? UnwrapSchema<Value> : unknown;

type DecodedResponse<Schemas extends RouteContractSchemas> = ResponseField<Schemas> extends infer Response
  ? Response extends Readonly<Record<string | number, unknown>>
    ? DecodedSchema<Response[keyof Response]>
    : DecodedSchema<Response>
  : unknown;

type StatusResponse<Schemas extends RouteContractSchemas> = ResponseField<Schemas> extends infer Response
  ? Response extends Readonly<Record<string | number, unknown>>
    ? NumericResponseMap<Response> extends infer NumericMap extends Readonly<Record<number, unknown>>
      ? {
          [Key in keyof NumericMap]: ElysiaCustomStatusResponse<
            Key extends number ? Key : never,
            DecodedSchema<NumericMap[Key]>
          >
        }[keyof NumericMap]
      : never
    : never
  : never;

type ElysiaRouteOutput<Schemas extends RouteContractSchemas> =
  | DecodedResponse<Schemas>
  | StatusResponse<Schemas>
  | Response
  | void;

/** Raw schema shape consumed by Elysia's route registration API. */
export interface ElysiaRouteSchema<Schemas extends RouteContractSchemas> {
  body?: Schemas["body"] extends TSchema ? Schemas["body"] : undefined;
  params?: Schemas["params"] extends TSchema ? Schemas["params"] : undefined;
  query?: Schemas["query"] extends TSchema ? Schemas["query"] : undefined;
  headers?: Schemas["headers"] extends TSchema ? Schemas["headers"] : undefined;
  cookie?: Schemas["cookie"] extends TSchema ? Schemas["cookie"] : undefined;
  response?: ResponseField<Schemas>;
}

type PathParameterNames<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParameterNames<`/${Rest}`>
  : Path extends `${string}:${infer Name}` ? Name : never;

type PathParameters<Path extends string> = [PathParameterNames<Path>] extends [never]
  ? Record<string, string>
  : { [Name in PathParameterNames<Path>]: string };

type DecodedField<Schemas extends RouteContractSchemas, Key extends keyof RouteContractSchemas> =
  [Extract<Schemas[Key], TSchema>] extends [never]
    ? unknown
    : UnwrapSchema<Extract<Schemas[Key], TSchema>>;

type DecodedCookie<Schemas extends RouteContractSchemas> = DecodedField<Schemas, "cookie"> extends infer Value
  ? Value extends Record<string, unknown>
    ? Record<string, Cookie<unknown>> & { [Key in keyof Value]-?: Cookie<Value[Key]> }
    : Record<string, Cookie<unknown>>
  : Record<string, Cookie<unknown>>;

type StatusCode<Schemas extends RouteContractSchemas> = ResponseField<Schemas> extends infer Response
  ? Response extends Readonly<Record<string | number, unknown>>
    ? keyof NumericResponseMap<Response> & number
    : never
  : never;

type StatusResponseValue<Schemas extends RouteContractSchemas, Code extends number> = ResponseField<Schemas> extends infer Response
  ? Response extends Readonly<Record<string | number, unknown>>
    ? Code extends keyof Response
      ? DecodedSchema<Response[Code]>
      : `${Code}` extends keyof Response ? DecodedSchema<Response[`${Code}`]> : unknown
    : DecodedSchema<Response>
  : unknown;

type RouteStatus<Schemas extends RouteContractSchemas> = [StatusCode<Schemas>] extends [never]
  ? <const Code extends number, const Value>(code: Code, response: Value) => ElysiaCustomStatusResponse<Code, Value>
  : <const Code extends StatusCode<Schemas>, const Value extends StatusResponseValue<Schemas, Code>>(
      code: Code,
      response: Value,
    ) => ElysiaCustomStatusResponse<Code, Value>;

/** Elysia-compatible decoded context inferred from one route contract and path. */
export type ElysiaRouteContext<
  Schemas extends RouteContractSchemas,
  Path extends string = "",
> = {
  body: DecodedField<Schemas, "body">;
  params: Schemas["params"] extends TSchema ? DecodedField<Schemas, "params"> : PathParameters<Path>;
  query: Schemas["query"] extends TSchema ? DecodedField<Schemas, "query"> : Record<string, string>;
  headers: Schemas["headers"] extends TSchema
    ? DecodedField<Schemas, "headers">
    : Record<string, string | undefined>;
  cookie: DecodedCookie<Schemas>;
  request: Request;
  path: string;
  route: Path;
  server: unknown;
  store: Record<string, unknown>;
  set: {
    headers: Record<string, string>;
    status?: number;
    redirect?: string;
    cookie?: Record<string, unknown>;
  };
  status: RouteStatus<Schemas>;
  redirect: (url: string, status?: number) => Response;
};

/** Handler type with Elysia's native decoded context and status-aware return type. */
export type ElysiaRouteHandler<
  Schemas extends RouteContractSchemas,
  Path extends string = "",
> = (
  context: ElysiaRouteContext<Schemas, Path>,
) => MaybePromise<ElysiaRouteOutput<Schemas>>;

export interface ElysiaRouteDefinition<
  Method extends HTTPMethod,
  Path extends string,
  Schemas extends RouteContractSchemas,
> {
  readonly method: Method;
  readonly path: Path;
  readonly contract: Readonly<Schemas>;
  readonly handler: ElysiaRouteHandler<Schemas, Path>;
}

/**
 * Keeps route schemas in one immutable value that can be reused by the
 * compiler, generated clients and the Elysia route helper.
 */
export function defineRouteContract<const Schemas extends RouteContractSchemas>(
  schemas: Schemas,
): Readonly<Schemas> {
  return Object.freeze({ ...schemas });
}

/** Convert the shared contract shape to Elysia's `response` route option. */
export function toElysiaRouteSchema<const Schemas extends RouteContractSchemas>(
  contract: Schemas,
): InputSchema<never> {
  const schema: Record<string, unknown> = {};
  if (contract.body !== undefined) schema.body = contract.body;
  if (contract.params !== undefined) schema.params = contract.params;
  if (contract.query !== undefined) schema.query = contract.query;
  if (contract.headers !== undefined) schema.headers = contract.headers;
  if (contract.cookie !== undefined) schema.cookie = contract.cookie;
  if (contract.responses !== undefined) schema.response = contract.responses;
  else if (contract.response !== undefined) schema.response = contract.response;
  return schema as unknown as InputSchema<never>;
}

/**
 * Binds a shared contract to an Elysia-native handler. The handler callback is
 * contextually typed from the same schemas that will be registered at runtime.
 */
export function defineElysiaRoute<
  const Method extends HTTPMethod,
  const Path extends string,
  const Schemas extends RouteContractSchemas,
>(
  method: Method,
  path: Path,
  contract: Schemas,
  handler: ElysiaRouteHandler<NoInfer<Schemas>, Path>,
): ElysiaRouteDefinition<Method, Path, Schemas> {
  // Preserve the caller's contract identity so route tooling can compare the
  // exact schema object used for registration and handler typing.
  const stableContract = Object.isFrozen(contract) ? contract : Object.freeze(contract);
  return Object.freeze({
    method,
    path,
    contract: stableContract,
    handler,
  });
}

/** Register a contract-bound route while preserving Elysia's fluent app API. */
export function registerElysiaRoute<
  const App extends Elysia,
  const Method extends HTTPMethod,
  const Path extends string,
  const Schemas extends RouteContractSchemas,
>(
  app: App,
  route: ElysiaRouteDefinition<Method, Path, Schemas>,
): App {
  // Elysia's fluent instance type widens after registration. The helper has
  // already established the contract-specific handler type, so keep the
  // public return stable while crossing that mutable fluent boundary.
  app.route(
    route.method,
    route.path,
    route.handler as ((context: unknown) => unknown),
    toElysiaRouteSchema(route.contract),
  );
  return app;
}

export class SchemaContractError extends Error {
  readonly code = "SCHEMA_CONTRACT_INVALID";

  constructor() {
    super("Schema contract validation failed");
    this.name = "SchemaContractError";
  }
}

/** Shares Elysia's validation and transformation semantics without trusting a caller-supplied result type. */
export type SchemaNormalizeMode = boolean | "exactMirror" | "typebox";

export interface SchemaDecoderOptions {
  /** Match Elysia's default route normalization unless explicitly disabled. */
  normalize?: SchemaNormalizeMode;
  /** Query/path coercion is opt-in because body and job payloads are normally typed JSON. */
  coerce?: boolean;
}

export function createSchemaDecoder<const Schema extends TSchema>(
  schema: Schema,
  options: SchemaDecoderOptions = {},
) {
  const validator = getSchemaValidator(schema, {
    coerce: options.coerce ?? false,
    normalize: options.normalize ?? true,
  });
  return (value: unknown): UnwrapSchema<Schema> => {
    try {
      return validator.parse(value);
    } catch {
      throw new SchemaContractError();
    }
  };
}

/**
 * The body and response schemas are also route options. The decoder fields
 * structurally implement @supacloud/app's HttpContract without a runtime import.
 */
export function defineJsonContract<const Input extends TSchema, const Result extends TSchema>(
  schemas: { body: Input; response: Result },
  request: (input: NoInfer<UnwrapSchema<Input>>) => {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    body?: unknown;
  },
  options: SchemaDecoderOptions = {},
) {
  return Object.freeze({
    ...schemas,
    input: createSchemaDecoder(schemas.body, options),
    result: createSchemaDecoder(schemas.response, options),
    request,
  });
}
