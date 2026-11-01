import { describe, expect, test } from "bun:test";
import {
  effectiveCollaboratorCapabilities,
  normalizeCapabilityAllowlist,
} from "../../src/services/collaborator-capabilities";
import {
  describeKeyCustody,
  enterpriseGovernanceCatalog,
  keyRotationAuditMetadata,
  scimGovernanceGap,
} from "../../src/services/enterprise-governance";

const secretArn = "arn:aws:kms:us-east-1:123456789012:key/customer-secret";

describe("enterprise governance catalog", () => {
  test("narrows a role and rejects capabilities outside it", () => {
    expect(effectiveCollaboratorCapabilities("admin", ["audit.read", "audit.export"])).toEqual([
      "audit.read",
      "audit.export",
    ]);
    expect(effectiveCollaboratorCapabilities("viewer", null)).toContain("audit.read");
    expect(effectiveCollaboratorCapabilities("member", [])).toEqual([]);
    expect(() => normalizeCapabilityAllowlist("viewer", ["project.manage"])).toThrow(/outside the viewer role/);
    expect(() => normalizeCapabilityAllowlist("admin", [])).toThrow(/cannot be empty/);
  });

  test("key rotation metadata names the kind and omits key material", () => {
    const legacy = keyRotationAuditMetadata("legacy_jwt", "proj_1");
    const opaque = keyRotationAuditMetadata("opaque", "proj_1");
    expect(legacy).toMatchObject({
      action: "project.api_keys.rotate",
      metadata: {
        resource_id: "proj_1",
        rotation_kind: "legacy_jwt",
        restarts_runtime: true,
        invalidates_user_sessions: true,
        material_recorded: false,
      },
    });
    expect(opaque.metadata.restarts_runtime).toBe(false);
    expect(opaque.metadata.invalidates_user_sessions).toBe(false);
    expect(JSON.stringify(legacy)).not.toMatch(/jwt_secret_value|anon_key_value/);
  });

  test("key custody counts a KMS ARN reference and does not echo it", () => {
    const custody = describeKeyCustody({
      auth: {
        oauth_server: {
          jwt_keys: [{
            kty: "RSA",
            alg: "RS256",
            n: "modulus",
            e: "AQAB",
            d: "private-material",
            "aws:kms:arn": secretArn,
          }],
        },
      },
    });
    expect(custody).toMatchObject({
      jwt_signing_key_count: 1,
      aws_kms_arn_references: 1,
      supported_path: "jwt_rs256_signing_jwk_aws_kms_arn",
      provider_call: false,
      data_plane_encryption: "platform_managed",
    });
    const encoded = JSON.stringify(custody);
    expect(encoded).not.toContain(secretArn);
    expect(encoded).not.toContain("private-material");
    expect(encoded).not.toContain("modulus");
  });

  test("catalog and SCIM gap stay explicit", () => {
    const catalog = enterpriseGovernanceCatalog();
    expect(catalog.deployed).toBe(false);
    expect(catalog.scim.available).toBe(false);
    expect(catalog.scim.reason_code).toBe("scim_not_implemented");
    expect(catalog.byok.provider_call).toBe(false);
    expect(scimGovernanceGap().reason_code).toBe("scim_not_implemented");
    expect(catalog.sso.assertion_validation).toBe("gotrue");
  });
});
