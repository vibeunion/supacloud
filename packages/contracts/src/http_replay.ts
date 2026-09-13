export type HttpReplayPolicy =
  | { mode: "never" }
  | { mode: "idempotent"; idempotencyKey: string };

export class HttpReplayError extends Error {
  readonly code = "HTTP_REPLAY_BLOCKED";

  constructor() {
    super("HTTP request replay blocked");
    this.name = "HttpReplayError";
  }
}

export function validateReplayPolicy(value: unknown): HttpReplayPolicy | undefined {
  if (value === undefined) return undefined;
  if (value !== null && typeof value === "object" && "mode" in value) {
    if (value.mode === "never") return { mode: "never" };
    if (value.mode === "idempotent" && "idempotencyKey" in value
      && typeof value.idempotencyKey === "string"
      && /^[A-Za-z0-9._:-]{1,200}$/.test(value.idempotencyKey)) {
      return { mode: "idempotent", idempotencyKey: value.idempotencyKey };
    }
  }
  throw new TypeError("Invalid HTTP replay policy");
}

export function isReadMethod(method: string): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function allowsHttpReplay(method: string, policy: HttpReplayPolicy | undefined): boolean {
  if (policy?.mode === "never") return false;
  return policy?.mode === "idempotent" || isReadMethod(method);
}

export function replayHeaders(
  headers: Record<string, string>,
  policy: HttpReplayPolicy | undefined,
): Record<string, string> {
  const result = { ...headers };
  if (policy?.mode !== "idempotent") return result;
  const existing = new Headers(result).get("idempotency-key");
  if (existing !== null && existing !== policy.idempotencyKey) throw new HttpReplayError();
  for (const name of Object.keys(result)) {
    if (name.toLowerCase() === "idempotency-key") delete result[name];
  }
  result["idempotency-key"] = policy.idempotencyKey;
  return result;
}
