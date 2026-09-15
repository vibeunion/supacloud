import type { AnyElysia } from "elysia";

/**
 * The schema fields exposed by a Management API route projection.
 *
 * `response` is retained because it is the field Elysia stores in its route
 * hooks. `responses` is the normalized status map consumed by clients and
 * documentation tooling.
 */
export interface ManagementRouteSchemas {
  body?: unknown;
  params?: unknown;
  query?: unknown;
  headers?: unknown;
  cookie?: unknown;
  response?: unknown;
  responses?: Readonly<Record<string, unknown>>;
}

export interface ManagementRouteContract {
  method: string;
  path: string;
  schemas: ManagementRouteSchemas;
}

export interface ManagementRouteProjectionOptions {
  /** Keep only routes suitable for OpenAPI and generated HTTP clients. */
  documentedOnly?: boolean;
}

export interface ManagementRouteLike {
  method: string;
  path: string;
  hooks?: {
    body?: unknown;
    params?: unknown;
    query?: unknown;
    headers?: unknown;
    cookie?: unknown;
    response?: unknown;
    detail?: unknown;
    websocket?: unknown;
  };
  websocket?: unknown;
};

const DOCUMENTED_HTTP_METHODS = new Set([
  "GET",
  "PUT",
  "POST",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "PATCH",
  "TRACE",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStatusCode(value: string): boolean {
  return value === "default"
    || /^[1-5][0-9]{2}$/.test(value)
    || /^[1-5](?:xx|XX)$/.test(value);
}

/** Top-level keywords that identify a JSON Schema rather than a response map. */
const JSON_SCHEMA_KEYS = new Set([
  "$schema", "$id", "$ref", "$defs", "definitions", "type", "title", "description",
  "default", "enum", "const", "examples", "properties", "patternProperties", "required",
  "additionalProperties", "items", "prefixItems", "contains", "allOf", "anyOf", "oneOf",
  "not", "if", "then", "else", "unevaluatedProperties", "format", "pattern", "minLength",
  "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "contentEncoding",
  "contentMediaType", "deprecated", "readOnly", "writeOnly",
]);

function isJsonSchemaObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).some((key) => JSON_SCHEMA_KEYS.has(key));
}

/** Status-shaped keys include invalid numeric selectors so malformed maps fail closed. */
function isStatusSelectorShape(value: string): boolean {
  return value === "default"
    || /^\d{3}$/.test(value)
    || /^[1-5](?:xx|XX)$/.test(value);
}

function invalidResponseSelector(selector: string): never {
  throw new TypeError(
    `Unsupported response selector "${selector}". Use an HTTP status (100-599), `
      + "a status family such as 4XX/5XX, or default.",
  );
}

function canonicalStatusSelector(value: string): string {
  return /^[1-5](?:xx|XX)$/.test(value) ? value.toUpperCase() : value;
}

/** Elysia stores both single response schemas and status-code maps in `response`. */
function isResponseMap(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([key]) => isStatusCode(key));
}

function normalizeResponses(response: unknown): Readonly<Record<string, unknown>> | undefined {
  if (response === undefined) return undefined;
  if (isResponseMap(response)) {
    const normalized: Record<string, unknown> = {};
    const originalSelectors = new Map<string, string>();
    for (const [selector, schema] of Object.entries(response)) {
      const canonical = canonicalStatusSelector(selector);
      const existing = originalSelectors.get(canonical);
      if (existing !== undefined) {
        throw new TypeError(
          `Duplicate response selectors "${existing}" and "${selector}" resolve to "${canonical}".`,
        );
      }
      originalSelectors.set(canonical, selector);
      normalized[canonical] = schema;
    }
    return Object.freeze(normalized);
  }
  if (isRecord(response) && !isJsonSchemaObject(response)) {
    const entries = Object.entries(response);
    if (entries.some(([key]) => isStatusSelectorShape(key))) {
      const invalid = entries.find(([key]) => !isStatusCode(key));
      if (invalid) invalidResponseSelector(invalid[0]);
    }
  }
  return Object.freeze({ "200": response });
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema) || !isRecord(schema.properties)) return {};
  return schema.properties;
}

function schemaProperty(schema: unknown, name: string): Record<string, unknown> {
  const property = schemaProperties(schema)[name];
  return isRecord(property) ? { ...property } : {};
}

function schemaRequired(schema: unknown, name: string): boolean {
  if (!isRecord(schema) || !Array.isArray(schema.required)) return false;
  return schema.required.includes(name);
}

/** Convert an Elysia path to the OpenAPI path spelling used by Swagger. */
export function toManagementOpenApiPath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const name = segment.slice(1).replace(/\?$/, "");
      return `{${name}}`;
    })
    .join("/");
}

/**
 * A documented route is an HTTP route that OpenAPI and generated clients can
 * represent. WebSockets, `ALL`, hidden routes, and wildcard paths remain in
 * the complete projection but are intentionally excluded from this view.
 */
export function isManagementDocumentedRoute(route: ManagementRouteLike): boolean {
  const method = route.method.toUpperCase();
  const hidden = isRecord(route.hooks?.detail) && route.hooks?.detail.hide === true;
  const wildcard = route.path.split("/").some((segment) => segment.includes("*"));
  const websocket = method === "WS" || route.websocket !== undefined || route.hooks?.websocket !== undefined;
  return !hidden && !wildcard && !websocket && DOCUMENTED_HTTP_METHODS.has(method);
}

/**
 * Reads the contracts already attached to Elysia's compiled route table.
 * This is a projection for tooling; it is intentionally not a second route
 * declaration source.
 */
export function collectManagementRouteContracts(
  app: Pick<AnyElysia, "routes">,
  options: ManagementRouteProjectionOptions = {},
): readonly ManagementRouteContract[] {
  const projected = app.routes
    .filter((route) => !options.documentedOnly || isManagementDocumentedRoute(route))
    .map((route) => {
      const hooks = route.hooks ?? {};
      const responseSchemas = normalizeResponses(hooks.response);
      const schemas = {
        ...(hooks.body === undefined ? {} : { body: hooks.body }),
        ...(hooks.params === undefined ? {} : { params: hooks.params }),
        ...(hooks.query === undefined ? {} : { query: hooks.query }),
        ...(hooks.headers === undefined ? {} : { headers: hooks.headers }),
        ...(hooks.cookie === undefined ? {} : { cookie: hooks.cookie }),
        ...(hooks.response === undefined ? {} : { response: hooks.response }),
        ...(responseSchemas === undefined ? {} : { responses: responseSchemas }),
      };
      return Object.freeze({
        method: route.method,
        path: route.path,
        schemas: Object.freeze(schemas),
      });
    });
  return Object.freeze(projected);
}

/** Projection used by OpenAPI and generated HTTP client tooling. */
export function collectManagementDocumentedRouteContracts(
  app: Pick<AnyElysia, "routes">,
): readonly ManagementRouteContract[] {
  return collectManagementRouteContracts(app, { documentedOnly: true });
}

/**
 * Add schema fields that the stock Swagger adapter cannot represent itself.
 * The adapter already owns operation and response generation; this function
 * only projects cookie parameters from the same Elysia route table and never
 * creates a second route declaration.
 */
export function augmentManagementOpenApiDocument(
  document: unknown,
  app: Pick<AnyElysia, "routes">,
): unknown {
  if (!isRecord(document) || !isRecord(document.paths)) return document;

  const paths: Record<string, unknown> = { ...document.paths };
  let changed = false;
  for (const contract of collectManagementDocumentedRouteContracts(app)) {
    const pathItem = paths[toManagementOpenApiPath(contract.path)];
    if (!isRecord(pathItem)) continue;
    const method = contract.method.toLowerCase();
    const operation = pathItem[method];
    if (!isRecord(operation)) continue;

    const cookieSchema = contract.schemas.cookie;
    const cookieProperties = schemaProperties(cookieSchema);
    if (Object.keys(cookieProperties).length === 0) continue;

    const parameters = Array.isArray(operation.parameters) ? [...operation.parameters] : [];
    const originalParameterCount = parameters.length;
    const existing = new Set(
      parameters.filter(isRecord).map((parameter) =>
        `${String(parameter.in ?? "")}:${String(parameter.name ?? "")}`),
    );
    for (const name of Object.keys(cookieProperties)) {
      const key = `cookie:${name}`;
      if (existing.has(key)) continue;
      parameters.push({
        in: "cookie",
        name,
        required: schemaRequired(cookieSchema, name),
        schema: schemaProperty(cookieSchema, name),
      });
      existing.add(key);
    }

    if (parameters.length === originalParameterCount) continue;

    paths[toManagementOpenApiPath(contract.path)] = {
      ...pathItem,
      [method]: { ...operation, parameters },
    };
    changed = true;
  }

  return changed ? { ...document, paths } : document;
}
