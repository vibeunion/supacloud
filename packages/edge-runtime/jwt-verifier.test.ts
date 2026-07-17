import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { normalizeJwtJwks, verifyEdgeRuntimeJwt } from "./jwt-verifier";

describe("verifyEdgeRuntimeJwt", () => {
  test("accepts ES256 tokens from project JWKS for Bun Edge Functions", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);
    const kid = "test-es256";
    const token = await new SignJWT({ role: "authenticated", sub: "user_1" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(await crypto.subtle.importKey(
        "jwk",
        { ...privateJwk, kid, alg: "ES256", use: "sig" },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ));

    const verified = await verifyEdgeRuntimeJwt({
      jwtJwks: { keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] },
      jwtSecret: "legacy-secret-with-at-least-32-characters",
    }, `Bearer ${token}`);

    expect(verified).toBe(true);
  });

  test("keeps legacy api key bypasses for anon and service_role", async () => {
    expect(await verifyEdgeRuntimeJwt({
      anonKey: "anon-key",
      serviceRoleKey: "service-role-key",
    }, null, "anon-key")).toBe(true);

    expect(await verifyEdgeRuntimeJwt({
      anonKey: "anon-key",
      serviceRoleKey: "service-role-key",
    }, "Bearer service-role-key")).toBe(true);
  });

  test("does not let a valid anon apikey mask an invalid bearer JWT", async () => {
    expect(await verifyEdgeRuntimeJwt({
      anonKey: "anon-key",
      jwtSecret: "legacy-secret-with-at-least-32-characters",
    }, "Bearer forged-user-token", "anon-key")).toBe(false);
  });

  test("verifies a bearer JWT when supabase-js also sends the anon apikey", async () => {
    const jwtSecret = "legacy-secret-with-at-least-32-characters";
    const token = await new SignJWT({ role: "authenticated", sub: "user_1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(jwtSecret));

    expect(await verifyEdgeRuntimeJwt({
      anonKey: "anon-key",
      jwtSecret,
    }, `Bearer ${token}`, "anon-key")).toBe(true);
  });

  test("normalizes JWKS JSON from runtime env", () => {
    expect(normalizeJwtJwks(JSON.stringify({
      keys: [{ kty: "EC", kid: "kid_1", alg: "ES256" }],
    }))).toEqual({
      keys: [{ kty: "EC", kid: "kid_1", alg: "ES256" }],
    });
  });
});
