import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  VERIFIED_JWT_SUB_HEADER,
  normalizeJwtJwks,
  readEdgeRuntimeProjectSecrets,
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
      authRuntimeMode: "local",
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
      authRuntimeMode: "local",
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

    const trusted = withVerifiedJwtContext(
      spoofed,
      "00000000-0000-4000-8000-000000000002",
    );
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

  test("omits subjects that cannot be forwarded without changing the signed value", () => {
    // Cases: missing, empty, surrounding whitespace, C0/C1 controls, and non-Latin-1 text.
    const unsafeSubjects = [
      undefined,
      "",
      " user_1",
      "user_1 ",
      "\u00a0user_1",
      "user_1\u00a0",
      "user\nadmin",
      "user\u0085admin",
      "用户",
    ];

    for (const subject of unsafeSubjects) {
      const request = new Request("https://example.com/functions/v1/fa", {
        headers: { [VERIFIED_JWT_SUB_HEADER]: "attacker-controlled" },
      });
      const trusted = withVerifiedJwtContext(request, subject);

      expect(trusted.headers.has(VERIFIED_JWT_SUB_HEADER)).toBe(false);
    }
  });

  test("keeps legacy api key bypasses for anon and service_role", async () => {
    expect(await verifyEdgeRuntimeJwt({
      authRuntimeMode: "local",
      anonKey: "anon-key",
      serviceRoleKey: "service-role-key",
    }, null, "anon-key")).toBe(true);

    expect(await verifyEdgeRuntimeJwt({
      authRuntimeMode: "local",
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
      authRuntimeMode: "local",
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
      authRuntimeMode: "local",
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

  test("does not parse a missing runtime mode as local verifier material", () => {
    expect(readEdgeRuntimeProjectSecrets({
      JWT_SECRET: "stale-local-secret",
      JWT_JWKS: '{"keys":[{"kid":"stale-key"}]}',
    })).toBeNull();
    expect(readEdgeRuntimeProjectSecrets({
      SUPACLOUD_AUTH_RUNTIME_MODE: "shared",
      SUPACLOUD_AUTH_ISSUER: "https://auth-owner.example.com/auth/v1",
      JWT_JWKS: '{"keys":[{"kid":"owner-key"}]}',
    })).toMatchObject({
      authRuntimeMode: "shared",
      authIssuer: "https://auth-owner.example.com/auth/v1",
      jwtSecret: "",
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
      .setIssuer("https://auth-owner.example.com/auth/v1")
      .setExpirationTime("5m")
      .sign(signingKey);
    const serviceToken = await new SignJWT({ role: "service_role" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer("https://auth-owner.example.com/auth/v1")
      .setExpirationTime("5m")
      .sign(signingKey);
    const secrets = {
      authRuntimeMode: "shared" as const,
      authIssuer: "https://auth-owner.example.com/auth/v1",
      jwtJwks: { keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] },
    };

    expect(await verifyEdgeRuntimeJwt(secrets, `Bearer ${userToken}`)).toBe(true);
    expect(await verifyEdgeRuntimeJwt(secrets, `Bearer ${serviceToken}`)).toBe(false);

    const wrongIssuerToken = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer("https://attacker.example.com/auth/v1")
      .setExpirationTime("5m")
      .sign(signingKey);
    expect(await verifyEdgeRuntimeJwt(secrets, `Bearer ${wrongIssuerToken}`)).toBe(false);

    const missingIssuerToken = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setExpirationTime("5m")
      .sign(signingKey);
    expect(await verifyEdgeRuntimeJwt(secrets, `Bearer ${missingIssuerToken}`)).toBe(false);
    expect(await verifyEdgeRuntimeJwt({ ...secrets, authIssuer: "" }, `Bearer ${userToken}`)).toBe(false);
  });

  test("shared mode never falls back to the dependent legacy JWT secret", async () => {
    const jwtSecret = "dependent-secret-with-at-least-32-characters";
    const dependentUserToken = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("dependent-user")
      .setIssuer("supabase")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(jwtSecret));
    const secrets = {
      anonKey: "dependent-anon-key",
      serviceRoleKey: "dependent-service-role-key",
      jwtSecret,
      jwtJwks: { keys: [] },
      authRuntimeMode: "shared" as const,
      authIssuer: "https://auth-owner.example.com/auth/v1",
    };

    expect(await verifyEdgeRuntimeJwt(secrets, `Bearer ${dependentUserToken}`)).toBe(false);
    expect(await verifyEdgeRuntimeJwt(secrets, "Bearer dependent-anon-key")).toBe(true);
    expect(await verifyEdgeRuntimeJwt(secrets, null, "dependent-service-role-key")).toBe(true);
  });

  test("shared mode never accepts dependent third-party JWT policy", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);
    const kid = "dependent-third-party";
    const token = await new SignJWT({
      role: "authenticated",
      client_id: "dependent-client",
    })
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer("https://dependent-idp.example.com")
      .setAudience("authenticated")
      .setExpirationTime("5m")
      .sign(await crypto.subtle.importKey(
        "jwk",
        { ...privateJwk, kid, alg: "ES256", use: "sig" },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ));

    expect(await verifyEdgeRuntimeJwt({
      authRuntimeMode: "shared",
      authIssuer: "https://auth-owner.example.com/auth/v1",
      thirdParty: {
        issuer: "https://dependent-idp.example.com",
        audience: ["authenticated"],
        clientId: "dependent-client",
        jwtJwks: { keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] },
      },
    }, `Bearer ${token}`)).toBe(false);
  });

  test("missing auth runtime mode rejects JWTs but keeps raw API key compatibility", async () => {
    const jwtSecret = "legacy-secret-with-at-least-32-characters";
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user_1")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(jwtSecret));
    const secrets = {
      anonKey: "anon-key",
      serviceRoleKey: "service-role-key",
      jwtSecret,
    };

    expect(await verifyEdgeRuntimeJwtContext(secrets, `Bearer ${token}`)).toEqual({
      verified: false,
      source: "none",
    });
    expect(await verifyEdgeRuntimeJwt(secrets, "Bearer anon-key")).toBe(true);
    expect(await verifyEdgeRuntimeJwt(secrets, null, "service-role-key")).toBe(true);
  });
});
