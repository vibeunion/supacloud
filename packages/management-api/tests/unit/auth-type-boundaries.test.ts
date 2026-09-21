import { expect, test } from "bun:test";
import {
  AUTH_SESSION_POLICY_DEFAULTS, applyAuthSessionPolicyPatch,
  normalizeAuthSessionPolicyPatch, readAuthSessionPolicy,
} from "../../src/services/auth-session-policy";
import { projectAuthInternals } from "../../src/utils/project-auth";
import { normalizeThirdPartyAuthConfig } from "../../src/utils/project-config";
import { parseJwkShape } from "../../src/utils/jwk-shape";
import {
  buildAwsKmsRs256JwtKeyMaterial, normalizeProjectJwtJwks,
  normalizeProjectJwtKeys, resolveProjectJwtVerificationMaterial,
} from "../../src/utils/project-jwt";

test("session policy preserves false, zero, reset and duration field types", () => {
  const patch = normalizeAuthSessionPolicyPatch({
    jwt_exp: 0, refresh_token_rotation_enabled: false,
    security_refresh_token_reuse_interval: 0, sessions_inactivity_timeout: "1h30m",
    sessions_timebox: null, password_required_characters: "",
  });
  // These assignments are also checked by the test TypeScript project.
  const expiry: number | null | undefined = patch.values.jwt_expiry;
  const rotation: boolean | null | undefined = patch.values.refresh_token_rotation_enabled;
  const characters: string | null | undefined = patch.values.password_required_characters;
  expect([expiry, rotation, characters]).toEqual([null, false, ""]);
  expect(readAuthSessionPolicy(applyAuthSessionPolicyPatch({}, patch))).toEqual({
    ...AUTH_SESSION_POLICY_DEFAULTS, refresh_token_rotation_enabled: false,
    security_refresh_token_reuse_interval: 0, sessions_inactivity_timeout: 5400,
  });
});

test.each(["", "10junk", "1h2", "Infinity", "1e9s", "0.0000000001s", "1h\n2m"])(
  "rejects malformed duration %s", (duration) => {
    expect(() => normalizeAuthSessionPolicyPatch({ sessions_timebox: duration })).toThrow();
  },
);

test("session policy accepts equivalent aliases but rejects conflicting or explicit undefined values", () => {
  expect(normalizeAuthSessionPolicyPatch({ jwt_expiry: 60, jwt_exp: 60 }).values).toEqual({ jwt_expiry: 60 });
  expect(() => normalizeAuthSessionPolicyPatch({ jwt_expiry: 60, jwt_exp: 61 })).toThrow("conflicting");
  expect(() => normalizeAuthSessionPolicyPatch({ jwt_expiry: undefined })).toThrow("integer");
  expect(readAuthSessionPolicy({ jwt_expiry: 60, jwt_exp: 61 }).jwt_expiry).toBe(60);
});

test("auth config omits absent string fields and preserves prototype-named claim mappings", () => {
  const config = normalizeThirdPartyAuthConfig({
    enabled: true, clientId: " client ", authUpstream: " https://auth.example.com ",
    claim_mapping: JSON.parse('{"__proto__":"subject","constructor":"role"}'),
  });
  expect(config.client_id).toBe("client");
  expect(config.auth_upstream).toBe("https://auth.example.com");
  expect(Object.hasOwn(config, "issuer")).toBe(false);
  expect(Object.hasOwn(config, "audience")).toBe(false);
  expect(Object.hasOwn(config.claim_mapping, "__proto__")).toBe(true);
  expect(config.claim_mapping["__proto__"]).toBe("subject");
  expect(Object.getPrototypeOf(config.claim_mapping)).toBe(Object.prototype);
});

test.each([null, [], {}, { ref: 123 }, { ref: "" }, { ref: "project", anon_key: 42 }].map((row) => ({ row })))(
  "rejects malformed project API-key lookup row %#", ({ row }) => {
    expect(projectAuthInternals.resolveApiKeyRow("42", "hash", row)).toBeNull();
  },
);

test("opaque keys require an actual upstream key and unmatched legacy rows fail closed", () => {
  const lookup = projectAuthInternals.resolveApiKeyRow;
  expect(lookup("publishable", "hash", { ref: "project", publishable_key: "publishable" })).toBeNull();
  expect(lookup("secret", "hash", { ref: "project", secret_key_hash: "hash", service_role_key: {} })).toBeNull();
  expect(lookup("wrong", "hash", { ref: "project", anon_key: "anon", service_role_key: "service" })).toBeNull();
  expect(lookup("secret", "hash", { ref: "project", secret_key_hash: "hash", service_role_key: "service" }))
    .toEqual({ ref: "project", kind: "secret", role: "service_role", upstreamKey: "service" });
});

test.each([
  null, [], "key", {}, { kty: 7 }, { kty: "RSA", n: 7 }, { kty: "RSA", e: null },
  { kty: "EC", key_ops: "verify" }, { kty: "EC", key_ops: [1] },
  { kty: "EC", kid: undefined }, { kty: "RSA", oth: [{ d: undefined }] },
  { kty: "RSA", oth: [null] }, { kty: "RSA", x5c: [1] }, { kty: "EC", ext: "true" },
].map((key) => ({ key })))("rejects malformed JWK representation %#", ({ key }) => {
  expect(parseJwkShape(key)).toBeNull();
  expect(normalizeProjectJwtJwks({ keys: [key] })).toBeNull();
  expect(normalizeProjectJwtKeys([key])).toBeNull();
});

test("keeps valid JWK metadata and rejects malformed configured local keys without legacy fallback", () => {
  const key = { kty: "RSA", n: "AQAB", e: "AQAB", kid: "fixture", key_ops: ["verify"], ext: false };
  expect(parseJwkShape(key)).toEqual(key);
  expect(normalizeProjectJwtJwks(JSON.stringify({ keys: [key] }))).toEqual({ keys: [key] });
  expect(() => resolveProjectJwtVerificationMaterial({
    auth: { oauth_server: { jwt_jwks: { keys: [{ kty: "RSA", n: 7 }] } } },
  }, "synthetic")).toThrow("Invalid local JWT verification key set");
});

test("KMS public input cannot publish private key material", async () => {
  await expect(buildAwsKmsRs256JwtKeyMaterial({
    aws_kms_arn: "arn:aws:kms:us-east-1:123456789012:key/fixture",
    public_jwk: { kty: "RSA", n: "AQAB", e: "AQAB", d: "synthetic-private" },
  })).rejects.toThrow("private key material");
});
