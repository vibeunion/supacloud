import { describe, expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import {
  buildSharedProjectJwtVerificationMaterial,
  buildSharedProjectJwtVerifierJwks,
  resolveSharedAuthIssuer,
  verifyAsymmetricProjectJwt,
} from "../../src/utils/project-jwt";

describe("SupAuth shared JWT verifier material", () => {
  test("derives the owner issuer when OAuth issuer is not explicitly configured", () => {
    expect(resolveSharedAuthIssuer("auth-owner", {
      api_domain: "api.example.com",
      auth: { oauth_server: { enabled: true } },
    })).toBe("https://api.example.com/auth/v1");
  });

  test("preserves an explicitly configured owner issuer", () => {
    expect(resolveSharedAuthIssuer("auth-owner", {
      auth: { oauth_server: { issuer: "https://issuer.example.com/auth" } },
    })).toBe("https://issuer.example.com/auth");
  });

  test("management shared JWT verification requires the owner issuer", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);
    const kid = "owner-issuer-key";
    const signingKey = await crypto.subtle.importKey(
      "jwk",
      { ...privateJwk, kid, alg: "ES256", use: "sig" },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const expectedIssuer = "https://auth-owner.example.com/auth/v1";
    const valid = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer(expectedIssuer)
      .setExpirationTime("5m")
      .sign(signingKey);
    const wrong = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer("https://wrong.example.com/auth/v1")
      .setExpirationTime("5m")
      .sign(signingKey);
    const missing = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setExpirationTime("5m")
      .sign(signingKey);
    const jwks = { keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] };

    expect(await verifyAsymmetricProjectJwt(valid, jwks, expectedIssuer)).not.toBeNull();
    expect(await verifyAsymmetricProjectJwt(wrong, jwks, expectedIssuer)).toBeNull();
    expect(await verifyAsymmetricProjectJwt(missing, jwks, expectedIssuer)).toBeNull();
  });

  test("keeps dependent legacy API-key verification and owner public asymmetric keys only", () => {
    const jwks = buildSharedProjectJwtVerifierJwks({
      projectJwtSecret: "dependent-secret-with-at-least-32-characters",
      projectConfig: {
        auth: {
          oauth_server: {
            jwt_jwks: { keys: [{ kty: "EC", kid: "dependent-old-user-key", alg: "ES256", x: "x", y: "y", crv: "P-256" }] },
          },
        },
      },
      ownerConfig: {
        auth: {
          oauth_server: {
            enabled: true,
            signing_alg: "ES256",
            jwt_keys: [{ kty: "EC", kid: "owner-user-key", alg: "ES256", d: "private", x: "owner-x", y: "owner-y", crv: "P-256" }],
            jwt_jwks: {
              keys: [
                { kty: "EC", kid: "owner-user-key", alg: "ES256", x: "owner-x", y: "owner-y", crv: "P-256" },
                { kty: "oct", kid: "legacy-hs256", alg: "HS256", k: "owner-secret" },
              ],
            },
          },
        },
      },
    });

    expect(jwks.keys.some((key) => key.kty === "oct" && key.kid === "legacy-hs256")).toBe(true);
    expect(jwks.keys.some((key) => key.kid === "owner-user-key" && key.key_ops?.includes("verify"))).toBe(true);
    expect(jwks.keys.some((key) => key.kid === "dependent-old-user-key")).toBe(false);
    expect(jwks.keys.some((key) => key.kty === "oct" && key.k === "owner-secret")).toBe(false);
  });

  test("rejects HS256-only SupAuth owners", () => {
    expect(() => buildSharedProjectJwtVerifierJwks({
      projectJwtSecret: "dependent-secret-with-at-least-32-characters",
      projectConfig: {},
      ownerConfig: {
        auth: {
          oauth_server: {
            enabled: true,
            signing_alg: "HS256",
            jwt_jwks: { keys: [{ kty: "oct", kid: "legacy-hs256", alg: "HS256", k: "owner-secret" }] },
          },
        },
      },
    })).toThrow("must enable asymmetric ES256 or RS256 JWT signing");
  });

  test("excludes dependent third-party trust material while SupAuth is shared", () => {
    const material = buildSharedProjectJwtVerificationMaterial({
      projectJwtSecret: "dependent-secret-with-at-least-32-characters",
      projectConfig: {
        auth: {
          third_party_auth: {
            enabled: true,
            issuer: "https://business-auth.example.com/auth/v1",
            audience: "authenticated",
            client_id: "business-client",
            jwt_jwks: {
              keys: [{
                kty: "EC",
                kid: "business-user-key",
                alg: "ES256",
                crv: "P-256",
                x: "business-x",
                y: "business-y",
                key_ops: ["verify"],
              }],
            },
          },
        },
      },
      ownerConfig: {
        auth: {
          oauth_server: {
            enabled: true,
            signing_alg: "ES256",
            jwt_keys: [{ kty: "EC", kid: "owner-user-key", alg: "ES256", d: "private" }],
            jwt_jwks: {
              keys: [{ kty: "EC", kid: "owner-user-key", alg: "ES256", crv: "P-256", x: "owner-x", y: "owner-y" }],
            },
          },
        },
      },
    });

    expect(material.jwtJwks?.keys.map((key) => key.kid)).toEqual([
      "legacy-hs256",
      "owner-user-key",
    ]);
    expect(material.thirdParty).toBeNull();
    expect(material.jwtJwks?.keys.some((key) => key.kid === "business-user-key")).toBe(false);
  });

  test("does not let an external key forge dependent service-role claims", async () => {
    const ownerPair = await generateKeyPair("ES256", { extractable: true });
    const ownerPublic = await exportJWK(ownerPair.publicKey);
    const ownerPrivate = await exportJWK(ownerPair.privateKey);
    const externalPair = await generateKeyPair("ES256", { extractable: true });
    const externalPublic = await exportJWK(externalPair.publicKey);
    const externalPrivate = await exportJWK(externalPair.privateKey);
    const material = buildSharedProjectJwtVerificationMaterial({
      projectJwtSecret: "dependent-secret-with-at-least-32-characters",
      projectConfig: {
        auth: {
          third_party_auth: {
            enabled: true,
            issuer: "https://business-auth.example.com/auth/v1",
            audience: "business-audience",
            client_id: "business-client",
            jwt_jwks: {
              keys: [{ ...externalPublic, kid: "external-key", alg: "ES256", use: "sig", key_ops: ["verify"] }],
            },
          },
        },
      },
      ownerConfig: {
        auth: {
          oauth_server: {
            enabled: true,
            signing_alg: "ES256",
            jwt_keys: [{ ...ownerPrivate, kid: "owner-key", alg: "ES256", use: "sig", key_ops: ["sign"] }],
            jwt_jwks: {
              keys: [{ ...ownerPublic, kid: "owner-key", alg: "ES256", use: "sig", key_ops: ["verify"] }],
            },
          },
        },
      },
    });
    const forged = await new SignJWT({ iss: "supabase", role: "service_role" })
      .setProtectedHeader({ alg: "ES256", kid: "external-key" })
      .setExpirationTime("5m")
      .sign(await crypto.subtle.importKey(
        "jwk",
        { ...externalPrivate, kid: "external-key", alg: "ES256", use: "sig" },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ));

    let rejected = false;
    try {
      await jwtVerify(forged, createLocalJWKSet(material.jwtJwks!));
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
