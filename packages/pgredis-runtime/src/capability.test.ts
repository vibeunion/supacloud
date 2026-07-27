import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { InvalidCapabilityError, verifyPgredisCapability } from "./capability";

const secret = "capability-secret".padEnd(32, "x");

function token(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

describe("verifyPgredisCapability", () => {
  test("binds a short-lived cache capability to one project", () => {
    const claims = verifyPgredisCapability(token({
      v: 1,
      aud: "pgredis-runtime",
      scope: "cache",
      projectRef: "tenant-a",
      sub: "tenant-a_fn",
      iat: 1_000,
      exp: 2_000,
    }), secret, { now: 1_500, maxTtlMs: 5_000 });
    expect(claims.projectRef).toBe("tenant-a");
  });

  test("rejects tampering, expiry, and overlong capabilities", () => {
    const valid = token({
      v: 1,
      aud: "pgredis-runtime",
      scope: "cache",
      projectRef: "tenant-a",
      sub: "tenant-a_fn",
      iat: 1_000,
      exp: 10_000,
    });
    expect(() => verifyPgredisCapability(`${valid}x`, secret, { now: 2_000, maxTtlMs: 20_000 }))
      .toThrow(InvalidCapabilityError);
    expect(() => verifyPgredisCapability(valid, secret, { now: 11_000, maxTtlMs: 20_000 }))
      .toThrow(InvalidCapabilityError);
    expect(() => verifyPgredisCapability(valid, secret, { now: 2_000, maxTtlMs: 5_000 }))
      .toThrow(InvalidCapabilityError);
  });
});
