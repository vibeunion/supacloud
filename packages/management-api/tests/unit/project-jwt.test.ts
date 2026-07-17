import { describe, expect, test } from "bun:test";
import { resolveProjectVerificationJwks, resolveThirdPartyJwtPolicy } from "../../src/utils/project-jwt";

const thirdPartyConfig = {
  enabled: true,
  issuer: "https://auth.example.com/auth/v1",
  audience: "authenticated",
  client_id: "business-client",
};

describe("project JWT verification key resolution", () => {
  test("keeps legacy HS256 verification when third-party auth is enabled", () => {
    const jwks = resolveProjectVerificationJwks({
      auth: {
        third_party_auth: {
          ...thirdPartyConfig,
          jwt_jwks: {
            keys: [{ kty: "EC", kid: "central-kid", alg: "ES256", crv: "P-256", x: "x", y: "y" }],
          },
        },
      },
    }, "legacy-secret");

    expect(jwks?.keys.map((key) => key.kid)).toEqual(["central-kid", "legacy-hs256"]);
    expect(jwks?.keys.find((key) => key.kid === "legacy-hs256")?.kty).toBe("oct");
  });

  test("does not add external keys when third-party auth is disabled", () => {
    expect(resolveProjectVerificationJwks({
      auth: {
        third_party_auth: {
          enabled: false,
          jwt_jwks: { keys: [{ kty: "EC", kid: "should-not-be-used", alg: "ES256" }] },
        },
      },
    }, "legacy-secret")).toBeNull();
  });

  test("merges local OAuth keys, external keys, and the legacy key", () => {
    const jwks = resolveProjectVerificationJwks({
      auth: {
        oauth_server: {
          jwt_jwks: { keys: [{ kty: "EC", kid: "local-kid", alg: "ES256" }] },
        },
        third_party_auth: {
          ...thirdPartyConfig,
          jwt_jwks: { keys: [{ kty: "EC", kid: "central-kid", alg: "ES256", crv: "P-256", x: "x", y: "y" }] },
        },
      },
    }, "legacy-secret");

    expect(jwks?.keys.map((key) => key.kid)).toEqual(["local-kid", "central-kid", "legacy-hs256"]);
  });

  test("rejects unscoped or symmetric third-party trust material", () => {
    expect(() => resolveThirdPartyJwtPolicy({
      auth: { third_party_auth: { enabled: true, jwt_jwks: { keys: [] } } },
    })).toThrow("issuer is required");

    expect(() => resolveThirdPartyJwtPolicy({
      auth: {
        third_party_auth: {
          ...thirdPartyConfig,
          jwt_jwks: { keys: [{ kty: "oct", kid: "legacy-hs256", alg: "HS256", k: "secret" }] },
        },
      },
    })).toThrow("reserved");
  });

  test("rejects a conflicting external key that reuses a local key id", () => {
    expect(() => resolveProjectVerificationJwks({
      auth: {
        oauth_server: {
          jwt_jwks: { keys: [{ kty: "EC", kid: "shared-kid", alg: "ES256", crv: "P-256", x: "local", y: "local" }] },
        },
        third_party_auth: {
          ...thirdPartyConfig,
          jwt_jwks: { keys: [{ kty: "EC", kid: "shared-kid", alg: "ES256", crv: "P-256", x: "external", y: "external" }] },
        },
      },
    }, "legacy-secret")).toThrow("JWT verification key conflict");
  });
});
