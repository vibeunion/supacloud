import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  VERIFIED_JWT_SUB_HEADER,
  normalizeJwtJwks,
  withVerifiedJwtContext,
  verifyEdgeRuntimeJwt,
  verifyEdgeRuntimeJwtContext,
} from "./jwt-verifier";

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

  test("returns the verified subject for downstream Edge Functions", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);
    const kid = "test-subject";
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("00000000-0000-4000-8000-000000000001")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(await crypto.subtle.importKey(
        "jwk",
        { ...privateJwk, kid, alg: "ES256", use: "sig" },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ));

    const result = await verifyEdgeRuntimeJwtContext({
      jwtJwks: { keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] },
    }, `Bearer ${token}`);

    expect(result).toMatchObject({
      verified: true,
      source: "jwt",
      payload: { sub: "00000000-0000-4000-8000-000000000001" },
    });
  });

  test("overwrites spoofed verified-sub headers and preserves the request body", async () => {
    const spoofed = new Request("https://example.com/functions/v1/fa", {
      method: "POST",
      headers: {
        Authorization: "Bearer user-token",
        "Content-Type": "application/json",
        [VERIFIED_JWT_SUB_HEADER]: "attacker-controlled",
      },
      body: JSON.stringify({ action: "analyze" }),
    });

    const trusted = withVerifiedJwtContext(spoofed, {
      sub: "00000000-0000-4000-8000-000000000002",
    });
    expect(trusted.headers.get(VERIFIED_JWT_SUB_HEADER)).toBe(
      "00000000-0000-4000-8000-000000000002",
    );
    expect(trusted.method).toBe("POST");
    expect(await trusted.json()).toEqual({ action: "analyze" });
  });

  test("strips spoofed verified-sub headers without verified JWT claims", () => {
    const spoofed = new Request("https://example.com/functions/v1/fa", {
      headers: {
        Authorization: "Bearer user-token",
        [VERIFIED_JWT_SUB_HEADER]: "attacker-controlled",
      },
    });

    const stripped = withVerifiedJwtContext(spoofed);
    expect(stripped.headers.has(VERIFIED_JWT_SUB_HEADER)).toBe(false);
    expect(stripped.headers.get("authorization")).toBe("Bearer user-token");
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

  test("verifies a user bearer JWT even when supabase-js also sends the anon apikey", async () => {
    const jwtSecret = "legacy-secret-with-at-least-32-characters";
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("00000000-0000-4000-8000-000000000003")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(jwtSecret));

    const result = await verifyEdgeRuntimeJwtContext({
      anonKey: "anon-key",
      jwtSecret,
    }, `Bearer ${token}`, "anon-key");

    expect(result).toMatchObject({
      verified: true,
      source: "jwt",
      payload: { sub: "00000000-0000-4000-8000-000000000003" },
    });
  });

  test("does not let a valid anon apikey mask an invalid bearer JWT", async () => {
    expect(await verifyEdgeRuntimeJwtContext({
      anonKey: "anon-key",
      jwtSecret: "legacy-secret-with-at-least-32-characters",
    }, "Bearer forged-user-token", "anon-key")).toEqual({
      verified: false,
      source: "none",
    });
  });

  test("normalizes JWKS JSON from runtime env", () => {
    expect(normalizeJwtJwks(JSON.stringify({
      keys: [{ kty: "EC", kid: "kid_1", alg: "ES256" }],
    }))).toEqual({
      keys: [{ kty: "EC", kid: "kid_1", alg: "ES256" }],
    });
  });

  test("shared mode accepts owner user tokens but rejects owner service-role tokens", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);
    const kid = "supauth-owner";
    const signingKey = await crypto.subtle.importKey(
      "jwk",
      { ...privateJwk, kid, alg: "ES256", use: "sig" },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const userToken = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("user_1")
      .setExpirationTime("5m")
      .sign(signingKey);
    const serviceToken = await new SignJWT({ role: "service_role" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setExpirationTime("5m")
      .sign(signingKey);
    const secrets = {
      authRuntimeMode: "shared" as const,
      jwtJwks: { keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] },
    };

    expect(await verifyEdgeRuntimeJwt(secrets, `Bearer ${userToken}`)).toBe(true);
    expect(await verifyEdgeRuntimeJwt(secrets, `Bearer ${serviceToken}`)).toBe(false);
  });
});
