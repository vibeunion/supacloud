import { createHmac } from "node:crypto";

export interface PgredisCapabilityOptions {
  projectRef: string;
  subject: string;
  ttlMs: number;
  now?: number;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createPgredisCapability(
  signingSecret: string,
  options: PgredisCapabilityOptions,
): string {
  const issuedAt = options.now ?? Date.now();
  const payload = encode({
    v: 1,
    aud: "pgredis-runtime",
    scope: "cache",
    projectRef: options.projectRef,
    sub: options.subject,
    iat: issuedAt,
    exp: issuedAt + options.ttlMs,
  });
  const signature = createHmac("sha256", signingSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
