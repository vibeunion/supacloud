import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AppError } from "./errors";

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

const INVOCATION_KEYS = [
  "method", "path", "query", "headers", "body", "body_encoding", "requested_timeout_sec", "auth", "trace",
] as const;
const AUTH_KEYS = ["kind", "authorization", "apikey", "invoker_user_id", "invoker_role", "apikey_kind"] as const;
const TRACE_KEYS = ["project_ref", "traceparent", "request_id"] as const;

export class InvalidBackgroundInvocationError extends AppError {
  readonly responseStatus = 422;

  constructor() {
    super("Invalid background invocation envelope", 422, "BACKGROUND_INVOCATION_INVALID");
    this.name = "InvalidBackgroundInvocationError";
  }
}

function copyRecord(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidBackgroundInvocationError();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidBackgroundInvocationError();
  }
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (allowed !== undefined && !allowed.includes(key))) {
      throw new InvalidBackgroundInvocationError();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new InvalidBackgroundInvocationError();
    }
    output[key] = descriptor.value;
  }
  return output;
}

function captureInvocation(value: unknown): Record<string, unknown> {
  const invocation = copyRecord(value, INVOCATION_KEYS);
  if (Object.hasOwn(invocation, "headers") && invocation.headers !== undefined) {
    const headers = copyRecord(invocation.headers);
    for (const key of Object.keys(headers)) {
      const descriptor = Object.getOwnPropertyDescriptor(headers, key);
      if (!descriptor || !("value" in descriptor)) throw new InvalidBackgroundInvocationError();
    }
    invocation.headers = headers;
  }
  if (Object.hasOwn(invocation, "auth") && invocation.auth !== undefined) {
    invocation.auth = copyRecord(invocation.auth, AUTH_KEYS);
  }
  if (Object.hasOwn(invocation, "trace") && invocation.trace !== undefined) {
    invocation.trace = copyRecord(invocation.trace, TRACE_KEYS);
  }
  return invocation;
}

export function parseBackgroundInvocation(value: unknown): BackgroundInvocation {
  const captured = captureInvocation(value);
  if (!Value.Check(BackgroundInvocationSchema, captured)) {
    throw new InvalidBackgroundInvocationError();
  }
  const checked = captured as BackgroundInvocation;
  const method = checked.method ?? "POST";
  const path = checked.path ?? "";
  const query = checked.query ?? "";
  const body = checked.body ?? null;
  if ((path !== "" && !path.startsWith("/")) || /[?#\\\r\n\0]/.test(path)
    || (query !== "" && !query.startsWith("?")) || /[#\r\n\0]/.test(query)
    || ((method === "GET" || method === "HEAD") && body !== null && body !== "")) {
    throw new InvalidBackgroundInvocationError();
  }
  const headerNames = new Set<string>();
  for (const name of Object.keys(checked.headers ?? {})) {
    const normalized = name.toLowerCase();
    if (headerNames.has(normalized)) throw new InvalidBackgroundInvocationError();
    headerNames.add(normalized);
  }
  try {
    new Headers(checked.headers);
    for (const entry of Object.values(checked.auth ?? {})) {
      if (typeof entry === "string") new Headers({ "x-auth-value": entry });
    }
  } catch {
    throw new InvalidBackgroundInvocationError();
  }
  const auth = checked.auth ?? {};
  return {
    method,
    path,
    query,
    body,
    body_encoding: "utf8",
    headers: { ...(checked.headers ?? {}) },
    auth: { ...auth },
    ...(checked.trace === undefined
      ? {}
      : { trace: { ...checked.trace } }),
    ...(checked.requested_timeout_sec === undefined
      ? {}
      : { requested_timeout_sec: checked.requested_timeout_sec }),
  };
}
