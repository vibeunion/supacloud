import { createHmac, timingSafeEqual } from "node:crypto";
import { PROJECT_REF_PATTERN } from "./tenant-config";

interface CapabilityClaims {
  v: 1;
  aud: "pgredis-runtime";
  scope: "cache";
  projectRef: string;
  sub: string;
  iat: number;
  exp: number;
}

export class InvalidCapabilityError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "InvalidCapabilityError";
  }
}

function invalid(): never {
  throw new InvalidCapabilityError();
}

export function verifyPgredisCapability(
  token: string,
  signingSecret: string,
  options: { now?: number; maxTtlMs: number },
): CapabilityClaims {
  const [payload, encodedSignature, extra] = token.split(".");
  if (!payload || !encodedSignature || extra !== undefined) invalid();

  const expected = createHmac("sha256", signingSecret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, "base64url");
  } catch {
    invalid();
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) invalid();

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    invalid();
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) invalid();
  const value = claims as Record<string, unknown>;
  const now = options.now ?? Date.now();
  if (
    value.v !== 1
    || value.aud !== "pgredis-runtime"
    || value.scope !== "cache"
    || typeof value.projectRef !== "string"
    || !PROJECT_REF_PATTERN.test(value.projectRef)
    || typeof value.sub !== "string"
    || value.sub.length < 1
    || value.sub.length > 256
    || typeof value.iat !== "number"
    || typeof value.exp !== "number"
    || !Number.isSafeInteger(value.iat)
    || !Number.isSafeInteger(value.exp)
    || value.iat > now + 30_000
    || value.exp <= now
    || value.exp - value.iat > options.maxTtlMs
  ) invalid();
  return value as unknown as CapabilityClaims;
}
