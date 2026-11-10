import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hashSecretApiKey } from "../../src/utils/api-keys";
import { decryptSecretIfNeeded, encryptSecretWithKey } from "../../src/utils/secret-crypto";
import { projectAuthInternals } from "../../src/utils/project-auth";
import {
  clearedProjectSecretWrite,
  revealProjectSecrets,
  sealProjectSecrets,
  sealRotatedApiKeys,
} from "../../src/repositories/project-secret-at-rest";

const OTHER_KEY = "another-encryption-key-0123456789abcdef";

describe("project secret storage", () => {
  test("seals tenant secrets without retaining plaintext fields", () => {
    const sealed = sealProjectSecrets({
      db_password: "database-password",
      jwt_secret: "jwt-secret",
      anon_key: "anon-key",
      service_role_key: "service-role-key",
      s3_secret_key: "s3-secret",
    });

    expect(sealed.db_password).toBeNull();
    expect(sealed.jwt_secret).toBeNull();
    expect(sealed.anon_key).toBeNull();
    expect(sealed.service_role_key).toBeNull();
    expect(sealed.s3_secret_key).toBeNull();
    expect(decryptSecretIfNeeded(sealed.db_password_encrypted)).toBe("database-password");
    expect(decryptSecretIfNeeded(sealed.jwt_secret_encrypted)).toBe("jwt-secret");
    expect(decryptSecretIfNeeded(sealed.anon_key_encrypted)).toBe("anon-key");
    expect(decryptSecretIfNeeded(sealed.service_role_key_encrypted)).toBe("service-role-key");
    expect(decryptSecretIfNeeded(sealed.s3_secret_key_encrypted || "")).toBe("s3-secret");
    expect(sealed.anon_key_hash).toBe(hashSecretApiKey("anon-key"));
    expect(sealed.service_role_key_hash).toBe(hashSecretApiKey("service-role-key"));
  });

  test("reads encrypted columns and ignores stale plaintext", () => {
    const sealed = sealRotatedApiKeys({
      jwt_secret: "current-jwt",
      anon_key: "current-anon",
      service_role_key: "current-service",
    });
    const revealed = revealProjectSecrets({
      jwt_secret: "stale-jwt",
      jwt_secret_encrypted: sealed.jwt_secret_encrypted,
      anon_key: "stale-anon",
      anon_key_encrypted: sealed.anon_key_encrypted,
      service_role_key: "stale-service",
      service_role_key_encrypted: sealed.service_role_key_encrypted,
      db_password: "legacy-password",
    });

    expect(revealed.jwt_secret).toBe("current-jwt");
    expect(revealed.anon_key).toBe("current-anon");
    expect(revealed.service_role_key).toBe("current-service");
    expect(revealed.db_password).toBe("legacy-password");
  });

  test("copies legacy plaintext into encrypted columns and is idempotent after clearing", () => {
    const cleared = clearedProjectSecretWrite({
      db_password: "database-password",
      db_password_encrypted: encryptSecretWithKey("divergent-password", OTHER_KEY),
      jwt_secret: null,
      jwt_secret_encrypted: null,
      anon_key: "anon-key",
      anon_key_encrypted: null,
      service_role_key: null,
      service_role_key_encrypted: null,
      s3_secret_key: "s3-secret",
      s3_secret_key_encrypted: null,
    });

    expect(cleared).not.toBeNull();
    expect(decryptSecretIfNeeded(cleared?.db_password_encrypted || "")).toBe("database-password");
    expect(decryptSecretIfNeeded(cleared?.anon_key_encrypted || "")).toBe("anon-key");
    expect(decryptSecretIfNeeded(cleared?.s3_secret_key_encrypted || "")).toBe("s3-secret");
    expect(cleared?.anon_key_hash).toBe(hashSecretApiKey("anon-key"));
    expect(cleared?.service_role_key_hash).toBeNull();

    expect(clearedProjectSecretWrite({
      db_password: null,
      db_password_encrypted: cleared?.db_password_encrypted,
      jwt_secret: null,
      jwt_secret_encrypted: null,
      anon_key: null,
      anon_key_encrypted: cleared?.anon_key_encrypted,
      anon_key_hash: cleared?.anon_key_hash,
      service_role_key: null,
      service_role_key_encrypted: null,
      service_role_key_hash: null,
      s3_secret_key: null,
      s3_secret_key_encrypted: cleared?.s3_secret_key_encrypted,
    })).toBeNull();
  });

  test("fails closed when ciphertext cannot be decrypted and no plaintext remains", () => {
    expect(() => clearedProjectSecretWrite({
      db_password: null,
      db_password_encrypted: encryptSecretWithKey("database-password", OTHER_KEY),
      jwt_secret: null,
      jwt_secret_encrypted: null,
      anon_key: null,
      anon_key_encrypted: null,
      service_role_key: null,
      service_role_key_encrypted: null,
      s3_secret_key: null,
      s3_secret_key_encrypted: null,
    })).toThrow();
  });

  test("looks up anon and service-role keys by hash, with a null-hash plaintext fallback", () => {
    const lookup = projectAuthInternals.buildApiKeyLookup("legacy.service.jwt");
    expect(lookup.query).toContain("anon_key_hash = $2");
    expect(lookup.query).toContain("service_role_key_hash = $2");
    expect(lookup.query).toContain("anon_key_hash IS NULL AND anon_key = $1");
    expect(lookup.query).toContain("service_role_key_hash IS NULL AND service_role_key = $1");
    expect(lookup.params[1]).toBe(hashSecretApiKey("legacy.service.jwt"));
  });

  test("management auth matches a service-role JWT by hash", () => {
    const source = readFileSync(new URL("../../src/middleware/auth.ts", import.meta.url), "utf8");
    expect(source).toContain("service_role_key_hash = ${serviceRoleHash}");
    expect(source).toContain("service_role_key_hash IS NULL AND service_role_key = ${token}");
    expect(source).not.toContain("\n            AND service_role_key = ${token}");
  });
});
