import { describe, expect, test } from "bun:test";
import {
  buildJwtTruth,
  emptyJwtTruth,
  normalizeAuthRuntime,
} from "./jwt-truth";

describe("JWT truth", () => {
  test("normalizes direct and enveloped runtime descriptors", () => {
    expect(normalizeAuthRuntime({
      mode: "shared",
      authority_project_ref: "auth-owner",
      owner_management_path: "/project/auth-owner/auth",
      configuration_management: "owner_only",
    })).toEqual({
      mode: "shared",
      authorityProjectRef: "auth-owner",
      ownerManagementPath: "/project/auth-owner/auth",
      configurationManagement: "owner_only",
    });

    expect(normalizeAuthRuntime({ data: {
      mode: "local",
      authority_project_ref: "tenant-a",
      owner_management_path: null,
      configuration_management: "local",
    } })).toMatchObject({ mode: "local", authorityProjectRef: "tenant-a" });
  });

  test("uses only canonical auth policy and allowlisted OAuth status", () => {
    const truth = buildJwtTruth({
      jwt_expiry: 3600,
      refresh_token_rotation_enabled: true,
      oauth_server: {
        signing_alg: "HS256",
        jwt_jwks: { keys: [{ kty: "oct", k: "must-not-reach-ui", alg: "HS256" }] },
      },
    }, {
      signing_alg: "ES256",
      key_id: "key-1",
      jwks_url: "https://auth.example.com/.well-known/jwks.json",
      issuer: "https://auth.example.com/auth/v1",
      migration_status: "oidc_es256_migrated",
      enabled: true,
      jwt_jwks: { keys: [{ kty: "oct", k: "also-ignored", alg: "HS256" }] },
    });

    expect(truth).toEqual({
      accessExpiry: 3600,
      signingAlgorithm: "ES256",
      signingSource: "oauth_status",
      signingKeyId: "key-1",
      jwksUrl: "https://auth.example.com/.well-known/jwks.json",
      issuer: "https://auth.example.com/auth/v1",
      migrationStatus: "oidc_es256_migrated",
      oauthEnabled: true,
      refreshRotation: true,
    });
    expect(JSON.stringify(truth)).not.toContain("must-not-reach-ui");
    expect(JSON.stringify(truth)).not.toContain("also-ignored");
    expect(JSON.stringify(truth)).not.toContain("HS256");
  });

  test("does not invent signing truth for an unmigrated status", () => {
    expect(buildJwtTruth({ jwt_expiry: 3600 }, {
      signing_alg: "not_migrated",
      jwks_url: "https://auth.example.com/.well-known/jwks.json",
      enabled: false,
    })).toEqual({
      ...emptyJwtTruth(),
      accessExpiry: 3600,
      jwksUrl: "https://auth.example.com/.well-known/jwks.json",
      oauthEnabled: false,
    });
  });

  test("rejects malformed runtime descriptors instead of falling back", () => {
    expect(normalizeAuthRuntime({ mode: "shared" })).toBeNull();
    expect(normalizeAuthRuntime({ mode: "unknown", authority_project_ref: "tenant-a" })).toBeNull();
  });
});
