import {
  getSchemaValidator,
  StatusMap,
  ElysiaCustomStatusResponse,
  type Cookie,
  type AnyElysia,
  type HTTPMethod,
  type InputSchema,
  type MaybePromise,
  type TSchema,
  type UnwrapSchema,
} from "elysia";
import type {
  ResponseMapSelector as AppResponseMapSelector,
  RouteContractSchemas as AppRouteContractSchemas,
} from "@supacloud/app";

/** Response selectors are owned by @supacloud/app and re-exported by the adapter. */
export type ResponseMapSelector = AppResponseMapSelector;

/** The schema fields shared by Elysia routes, generated clients and docs. */
export type RouteContractSchemas = AppRouteContractSchemas;

/**
 * Response selectors supported by the shared contract. Numeric selectors are
 * represented as both numbers and numeric strings at runtime; the latter are
 * useful when contracts are loaded from JSON or generated source.
 */
type StatusDigit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
type StatusFamily = 1 | 2 | 3 | 4 | 5;
type StatusCodeForFamily<Family extends StatusFamily> =
  `${Family}${StatusDigit}${StatusDigit}` extends infer Value
    ? Value extends `${infer Code extends number}` ? Code : never
    : never;
type AllHttpStatusCodes = StatusCodeForFamily<StatusFamily>;

type KeyMatchingLower<Value, Target extends string> = {
  [Key in keyof Value & string]: Lowercase<Key> extends Target ? Key : never;
}[keyof Value & string];

type ExactResponseKey<Value, Code extends number> =
  Code extends keyof Value ? Code : `${Code}` extends keyof Value ? `${Code}` : never;

type FamilyResponseKey<Value, Code extends number> = `${Code}` extends
  `${infer Family extends StatusFamily}${StatusDigit}${StatusDigit}`
  ? KeyMatchingLower<Value, `${Family}xx`>
  : never;

type DefaultResponseKey<Value> = KeyMatchingLower<Value, "default">;

type HasExactResponseKey<Value, Code extends number> =
  [ExactResponseKey<Value, Code>] extends [never] ? false : true;

type HasFamilyResponseKey<Value, Family extends StatusFamily> =
  [KeyMatchingLower<Value, `${Family}xx`>] extends [never] ? false : true;

type AllowsPlainSuccessResponse<Value> =
  HasExactResponseKey<Value, 200> extends true ? true
    : HasFamilyResponseKey<Value, 2> extends true ? true
      : [DefaultResponseKey<Value>] extends [never] ? false : true;

type ResponseSchemaForCode<Value, Code extends number> =
  ExactResponseKey<Value, Code> extends infer Exact
    ? [Exact] extends [never]
      ? FamilyResponseKey<Value, Code> extends infer Family
        ? [Family] extends [never]
          ? DefaultResponseKey<Value> extends infer Default
            ? [Default] extends [never]
              ? never
              : Default extends keyof Value ? Value[Default] : never
            : never
          : Family extends keyof Value ? Value[Family] : never
        : never
      : Exact extends keyof Value ? Value[Exact] : never
    : never;

type DeclaredResponses<Schemas extends RouteContractSchemas> =
  "responses" extends keyof Schemas ? NonNullable<Schemas["responses"]> : never;

type LegacyResponse<Schemas extends RouteContractSchemas> =
  "response" extends keyof Schemas ? NonNullable<Schemas["response"]> : never;

type ResponseField<Schemas extends RouteContractSchemas> =
  [DeclaredResponses<Schemas>] extends [never]
    ? [LegacyResponse<Schemas>] extends [never] ? undefined : LegacyResponse<Schemas>
    : DeclaredResponses<Schemas>;

type NumericResponseCodes<Value> = Value extends Readonly<Record<string | number, unknown>>
  ? {
      [Key in keyof Value]: Key extends number
        ? Key
        : Key extends `${infer Numeric extends number}` ? Numeric : never
    }[keyof Value]
  : never;

type FamilyResponseCodes<Value> = Value extends Readonly<Record<string | number, unknown>>
  ? {
      [Key in keyof Value & string]: Lowercase<Key> extends `${infer Family extends StatusFamily}xx`
        ? StatusCodeForFamily<Family>
        : never
    }[keyof Value & string]
  : never;

type ResponseStatusCodes<Value> = NumericResponseCodes<Value>
  | FamilyResponseCodes<Value>
  | ([DefaultResponseKey<Value>] extends [never] ? never : AllHttpStatusCodes);

type DecodedSchema<Value> = Value extends TSchema ? UnwrapSchema<Value> : unknown;

type DecodedResponse<Schemas extends RouteContractSchemas> = ResponseField<Schemas> extends infer Response
  ? Response extends TSchema
    ? DecodedSchema<Response>
    : Response extends Readonly<Record<string | number, unknown>>
    ? DecodedSchema<Response[keyof Response]>
    : DecodedSchema<Response>
  : unknown;

type StatusResponse<Schemas extends RouteContractSchemas> = ResponseField<Schemas> extends infer Response
  ? Response extends TSchema
    ? never
    : Response extends Readonly<Record<string | number, unknown>>
    ? {
        [Code in ResponseStatusCodes<Response>]: ElysiaCustomStatusResponse<
          Code,
          DecodedSchema<ResponseSchemaForCode<Response, Code>>
        >
      }[ResponseStatusCodes<Response>]
    : never
  : never;

/**
 * A plain handler return is sent as the default HTTP 200 response.  When a
 * status map declares several payloads, only the schema selected for 200 is
 * valid here; every other payload must use `status(code, value)` so its
 * status and schema stay coupled at runtime.
 */
type PlainResponse<Schemas extends RouteContractSchemas> = ResponseField<Schemas> extends infer Response
  ? Response extends Readonly<Record<string | number, unknown>>
    ? AllowsPlainSuccessResponse<Response> extends true
      ? DecodedSchema<ResponseSchemaForCode<Response, 200>>
      : never
    : DecodedResponse<Schemas>
  : never;

type ElysiaRouteOutput<Schemas extends RouteContractSchemas> =
  | PlainResponse<Schemas>
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
  ? Response extends TSchema
    ? never
    : Response extends Readonly<Record<string | number, unknown>>
    ? ResponseStatusCodes<Response>
    : never
  : never;

type StatusResponseValue<Schemas extends RouteContractSchemas, Code extends number> = ResponseField<Schemas> extends infer Response
  ? Response extends TSchema
    ? DecodedSchema<Response>
    : Response extends Readonly<Record<string | number, unknown>>
    ? DecodedSchema<ResponseSchemaForCode<Response, Code>>
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
    status?: number | keyof StatusMap;
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

const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");
const RESPONSE_STATUS_MIN = 100;
const RESPONSE_STATUS_MAX = 599;
const RESPONSE_FAMILY_PATTERN = /^([1-5])(?:xx|XX)$/;
const RESPONSE_STATUS_PATTERN = /^[1-5]\d{2}$/;

function isSchema(value: unknown): boolean {
  return value !== null && typeof value === "object"
    && (TYPEBOX_KIND in value || "~standard" in value);
}

function isJsonSchemaObject(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return [
    "$schema", "$id", "$ref", "$defs", "definitions", "type", "properties", "patternProperties",
    "required", "items", "prefixItems", "contains", "allOf", "anyOf", "oneOf", "not", "enum", "const",
    "additionalProperties", "minLength", "maxLength", "minimum", "maximum", "format", "pattern",
  ].some((key) => key in value);
}

function invalidResponseSelector(selector: string): never {
  throw new TypeError(
    `Unsupported response selector "${selector}". Use an HTTP status (100-599), `
      + "a status family such as 4XX/5XX, or default.",
  );
}

function conflictingResponseSchemas(): never {
  throw new TypeError(
    "Route contracts cannot declare both response and responses. "
      + "Remove response and use responses: { 200: Schema }.",
  );
}

function duplicateResponseSelector(selector: string, existing: string): never {
  throw new TypeError(
    `Duplicate response selectors "${existing}" and "${selector}" differ only by case. `
      + `Keep one ${selector.toUpperCase()} selector.`,
  );
}

/** Select the response schema using exact status > family > default precedence. */
export function responseSchemaForStatus(
  responses: Readonly<Record<string | number, unknown>>,
  status: number,
): unknown | undefined {
  const exact = Object.hasOwn(responses, status)
    ? responses[status]
    : Object.hasOwn(responses, String(status))
      ? responses[String(status)]
      : undefined;
  if (exact !== undefined || Object.hasOwn(responses, status) || Object.hasOwn(responses, String(status))) {
    return exact;
  }
  const family = `${Math.floor(status / 100)}XX`;
  if (Object.hasOwn(responses, family)) return responses[family];
  const lowerFamily = family.toLowerCase();
  if (Object.hasOwn(responses, lowerFamily)) return responses[lowerFamily];
  return Object.hasOwn(responses, "default") ? responses.default : undefined;
}

export function responseStatusDeclared(
  responses: Readonly<Record<string | number, unknown>>,
  status: number,
): boolean {
  return responseSchemaForStatus(responses, status) !== undefined
    || Object.hasOwn(responses, status)
    || Object.hasOwn(responses, String(status));
}

export function responseStatusOf(value: unknown, configuredStatus: number | string | undefined): number {
  if (value instanceof Response) return value.status;
  if (value instanceof ElysiaCustomStatusResponse) {
    const code = value.code;
    if (typeof code === "number" && Number.isInteger(code) && code >= RESPONSE_STATUS_MIN && code <= RESPONSE_STATUS_MAX) {
      return code;
    }
  }
  if (typeof configuredStatus === "number") return configuredStatus;
  if (typeof configuredStatus === "string") {
    const mapped = (StatusMap as Record<string, unknown>)[configuredStatus];
    if (typeof mapped === "number") return mapped;
  }
  return 200;
}

export function assertResponseStatusDeclared(
  responses: Readonly<Record<string | number, unknown>>,
  status: number,
): void {
  if (responseStatusDeclared(responses, status)) return;
  throw new TypeError("Response validation failed");
}

/**
 * Elysia 1.4 only compiles numeric response-map keys. Expand the shared
 * family/default selectors into the exact status validators Elysia consumes.
 */
function toElysiaResponseMap(
  responses: Readonly<Record<string | number, unknown>>,
): Readonly<Record<string | number, unknown>> {
  const exact = new Map<number, unknown>();
  const families = new Map<number, unknown>();
  const familySelectors = new Map<string, string>();
  let defaultSchema: unknown;
  let hasDefault = false;
  let requiresExpansion = false;

  for (const [selector, schema] of Object.entries(responses)) {
    if (RESPONSE_STATUS_PATTERN.test(selector)) {
      exact.set(Number(selector), schema);
      continue;
    }
    if (selector === "default") {
      defaultSchema = schema;
      hasDefault = true;
      requiresExpansion = true;
      continue;
    }
    const family = RESPONSE_FAMILY_PATTERN.exec(selector);
    if (family) {
      const canonicalSelector = selector.toLowerCase();
      const existingSelector = familySelectors.get(canonicalSelector);
      if (existingSelector !== undefined) duplicateResponseSelector(selector, existingSelector);
      familySelectors.set(canonicalSelector, selector);
      families.set(Number(family[1]), schema);
      requiresExpansion = true;
      continue;
    }
    invalidResponseSelector(selector);
  }

  if (!requiresExpansion) return responses;

  const expanded: Record<number, unknown> = {};
  if (hasDefault) {
    for (let status = RESPONSE_STATUS_MIN; status <= RESPONSE_STATUS_MAX; status++) {
      expanded[status] = defaultSchema;
    }
  }
  for (const [family, schema] of families) {
    const first = family * 100;
    for (let status = first; status < first + 100; status++) expanded[status] = schema;
  }
  for (const [status, schema] of exact) expanded[status] = schema;
  return expanded;
}

function toElysiaResponseSchema(response: unknown): unknown {
  if (typeof response === "string" || isSchema(response) || isJsonSchemaObject(response)) return response;
  if (response === null || typeof response !== "object" || Array.isArray(response)) return response;
  return toElysiaResponseMap(response as Readonly<Record<string | number, unknown>>);
}

/** Convert the shared contract shape to Elysia's `response` route option. */
export function toElysiaRouteSchema<const Schemas extends RouteContractSchemas>(
  contract: Schemas,
): InputSchema<never> {
  if (contract.response !== undefined && contract.responses !== undefined) {
    conflictingResponseSchemas();
  }
  const schema: Record<string, unknown> = {};
  if (contract.body !== undefined) schema.body = contract.body;
  if (contract.params !== undefined) schema.params = contract.params;
  if (contract.query !== undefined) schema.query = contract.query;
  if (contract.headers !== undefined) schema.headers = contract.headers;
  if (contract.cookie !== undefined) schema.cookie = contract.cookie;
  if (contract.responses !== undefined) schema.response = toElysiaResponseMap(contract.responses);
  else if (contract.response !== undefined) schema.response = toElysiaResponseSchema(contract.response);
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
  // Validate before preserving the route definition so invalid contracts fail
  // at their declaration site rather than during application registration.
  toElysiaRouteSchema(contract);
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
  const App extends AnyElysia,
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
  const handler = async (context: Parameters<typeof route.handler>[0]) => {
    const value = await route.handler(context);
    if (route.contract.responses !== undefined) {
      const status = responseStatusOf(value, context.set.status);
      assertResponseStatusDeclared(route.contract.responses, status);
    }
    return value;
  };
  app.route(
    route.method,
    route.path,
    handler as ((context: unknown) => unknown),
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
