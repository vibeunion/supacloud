import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createPgredisCapability } from "./pgredis-capability";

describe("createPgredisCapability", () => {
  test("mints a signed project-scoped cache capability", () => {
    const secret = "independent-pgredis-signing-secret-1234567890";
    const token = createPgredisCapability(secret, {
      projectRef: "tenant-a",
      subject: "function:cache",
      ttlMs: 60_000,
      now: 1_000,
    });
    const [payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

    expect(claims).toEqual({
      v: 1,
      aud: "pgredis-runtime",
      scope: "cache",
      projectRef: "tenant-a",
      sub: "function:cache",
      iat: 1_000,
      exp: 61_000,
    });
    expect(signature).toBe(createHmac("sha256", secret).update(payload).digest("base64url"));
    expect(token).not.toContain(secret);
  });
});
