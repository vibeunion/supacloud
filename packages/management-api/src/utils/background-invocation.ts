import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const NullableText = Type.Union([Type.String({ maxLength: 64 * 1024 }), Type.Null()]);
const HeaderName = Type.String({ pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" });
const HeaderValue = Type.String({ maxLength: 64 * 1024, pattern: "^[^\\r\\n\\u0000]*$" });

export const BackgroundInvocationSchema = Type.Object({
  method: Type.Optional(Type.Union([
    Type.Literal("GET"), Type.Literal("HEAD"), Type.Literal("POST"), Type.Literal("PUT"),
    Type.Literal("PATCH"), Type.Literal("DELETE"), Type.Literal("OPTIONS"),
  ])),
  path: Type.Optional(Type.String({ maxLength: 8192 })),
  query: Type.Optional(Type.String({ maxLength: 8192 })),
  headers: Type.Optional(Type.Record(HeaderName, HeaderValue, { additionalProperties: false, maxProperties: 200 })),
  body: Type.Optional(Type.Union([Type.String({ maxLength: 1024 * 1024 }), Type.Null()])),
  body_encoding: Type.Optional(Type.Literal("utf8")),
  requested_timeout_sec: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800 })),
  auth: Type.Optional(Type.Object({
    kind: Type.Optional(Type.Union([Type.Literal("jwt"), Type.Literal("apikey"), Type.Literal("none")])),
    authorization: Type.Optional(NullableText),
    apikey: Type.Optional(NullableText),
    invoker_user_id: Type.Optional(NullableText),
    invoker_role: Type.Optional(NullableText),
    apikey_kind: Type.Optional(NullableText),
  })),
  trace: Type.Optional(Type.Object({
    project_ref: Type.String({ maxLength: 64 }),
    traceparent: Type.String({ maxLength: 55 }),
    request_id: Type.String({ maxLength: 256 }),
  })),
});

export type BackgroundInvocation = Static<typeof BackgroundInvocationSchema>;

export class InvalidBackgroundInvocationError extends Error {
  readonly responseStatus = 422;
  constructor() { super("Invalid background invocation envelope"); }
}

export function parseBackgroundInvocation(value: unknown) {
  if (!Value.Check(BackgroundInvocationSchema, value)) throw new InvalidBackgroundInvocationError();
  const method = value.method ?? "POST";
  const path = value.path ?? "";
  const query = value.query ?? "";
  const body = value.body ?? null;
  if ((path !== "" && !path.startsWith("/")) || /[?#\\\r\n\0]/.test(path)
    || (query !== "" && !query.startsWith("?")) || /[#\r\n\0]/.test(query)
    || ((method === "GET" || method === "HEAD") && body !== null && body !== "")) {
    throw new InvalidBackgroundInvocationError();
  }
  const headerNames = new Set<string>();
  for (const name of Object.keys(value.headers ?? {})) {
    const normalized = name.toLowerCase();
    if (headerNames.has(normalized)) throw new InvalidBackgroundInvocationError();
    headerNames.add(normalized);
  }
  try {
    new Headers(value.headers);
    for (const entry of Object.values(value.auth ?? {})) {
      if (typeof entry === "string") new Headers({ "x-auth-value": entry });
    }
  } catch {
    throw new InvalidBackgroundInvocationError();
  }
  return {
    method, path, query, body, body_encoding: "utf8" as const,
    headers: { ...value.headers },
    auth: { ...value.auth },
    ...(value.trace === undefined ? {} : { trace: { ...value.trace } }),
    ...(value.requested_timeout_sec === undefined ? {} : { requested_timeout_sec: value.requested_timeout_sec }),
  };
}
