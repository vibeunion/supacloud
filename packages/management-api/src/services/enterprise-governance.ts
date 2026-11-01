import { ROLE_CAPABILITIES } from "./collaborator-capabilities";

export const ORGANIZATION_MEMBER_ROLES = ["owner", "admin", "member", "viewer"] as const;
export const TEAM_MEMBER_ROLES = ["maintainer", "member"] as const;
export const TEAM_PROJECT_ROLES = ["admin", "member", "viewer"] as const;

export const KEY_ROTATION_KINDS = {
  legacy_jwt: {
    action: "project.api_keys.rotate",
    route: "POST /v1/projects/:ref/api-keys/rotate",
    rotates: ["jwt_secret", "anon_key", "service_role_key"],
    restarts_runtime: true,
    invalidates_user_sessions: true,
    material_recorded: false,
  },
  opaque: {
    action: "project.api_keys.rotate_opaque",
    route: "POST /v1/projects/:ref/api-keys/rotate-opaque",
    rotates: ["publishable_key", "secret_key"],
    restarts_runtime: false,
    invalidates_user_sessions: false,
    material_recorded: false,
  },
} as const;

export type KeyRotationKind = keyof typeof KEY_ROTATION_KINDS;

export const SSO_SEAM = {
  protocol: "saml",
  assertion_validation: "gotrue",
  management_api: "proxy",
  routes: {
    list: "GET /v1/projects/:ref/auth/sso/providers",
    create: "POST /v1/projects/:ref/auth/sso/providers",
    read: "GET /v1/projects/:ref/auth/sso/providers/:id",
    update: "PUT /v1/projects/:ref/auth/sso/providers/:id",
    delete: "DELETE /v1/projects/:ref/auth/sso/providers/:id",
  },
  gaps: [
    "Management API does not validate SAML assertions. GoTrue does.",
    "SSO providers belong to one project's GoTrue. There is no organization-level identity provider.",
    "Unconfigured domain discovery is not implemented.",
  ],
} as const;

export const SCIM_GAP = {
  available: false,
  http_status: 501,
  code: "CAPABILITY_UNAVAILABLE",
  reason_code: "scim_not_implemented",
  message: "SCIM provisioning is not implemented. GoTrue's experimental SCIM router is not enabled or proxied.",
  gaps: [
    "No SCIM Users or Groups provisioning.",
    "No SCIM token store in the management API.",
    "No directory-to-organization member sync.",
  ],
} as const;

export const BYOK_GAPS = [
  "SupaCloud can store an aws:kms:arn on a project RS256 JWT signing JWK. It does not call AWS KMS.",
  "Database, storage, backup, and control-secret encryption are not customer-managed keys.",
  "No KMS provider other than that JWT signing-key ARN field is integrated.",
] as const;

export function keyRotationAuditMetadata(kind: KeyRotationKind, projectRef: string) {
  const plan = KEY_ROTATION_KINDS[kind];
  return {
    action: plan.action,
    metadata: {
      resource_type: "project_api_keys",
      resource_id: projectRef,
      rotation_kind: kind,
      rotates: [...plan.rotates],
      restarts_runtime: plan.restarts_runtime,
      invalidates_user_sessions: plan.invalidates_user_sessions,
      material_recorded: false as const,
    },
  };
}

export function scimGovernanceGap() {
  return {
    message: SCIM_GAP.message,
    code: SCIM_GAP.code,
    reason_code: SCIM_GAP.reason_code,
    available: SCIM_GAP.available,
    gaps: [...SCIM_GAP.gaps],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function describeKeyCustody(config: unknown) {
  let parsed = config;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = {};
    }
  }
  const root = asRecord(parsed) ?? {};
  const auth = asRecord(root["auth"]) ?? {};
  const oauth = asRecord(auth["oauth_server"]) ?? {};
  const keys = Array.isArray(oauth["jwt_keys"]) ? oauth["jwt_keys"] : [];
  let awsKmsArnReferences = 0;
  for (const key of keys) {
    const record = asRecord(key);
    const arn = record?.["aws:kms:arn"];
    if (typeof arn === "string" && arn.length > 0) awsKmsArnReferences += 1;
  }
  return {
    jwt_signing_key_count: keys.length,
    aws_kms_arn_references: awsKmsArnReferences,
    supported_path: awsKmsArnReferences > 0 ? "jwt_rs256_signing_jwk_aws_kms_arn" : "none",
    provider_call: false,
    data_plane_encryption: "platform_managed",
    gaps: [...BYOK_GAPS],
  };
}

export function enterpriseGovernanceCatalog() {
  return {
    scope: "control_plane",
    deployed: false,
    membership: {
      organization: {
        roles: [...ORGANIZATION_MEMBER_ROLES],
        route: "/v1/organizations/:slug/members",
      },
      team: {
        roles: [...TEAM_MEMBER_ROLES],
        route: "/v1/organizations/:slug/teams",
        note: "Team roles label membership. They do not grant project capabilities.",
      },
      project: {
        roles: ["owner", "admin", "member", "viewer"],
        route: "/v1/projects/:ref/collaborators",
        enforcement: "project_collaborators.requireCapability",
      },
    },
    fine_rbac: {
      collaborator_capabilities: ROLE_CAPABILITIES,
      allowlist: "optional capability_allowlist on a project collaborator narrows the role; it cannot widen it",
      team_grants: "organization team project grants may set that allowlist for rows they create",
      project_rbac: {
        route: "/v1/projects/:ref/rbac/roles",
        note: "Existing project RBAC roles and permissions stay the GoTrue metadata projection. This slice does not add another permission engine.",
      },
    },
    audit_export: {
      route: "POST /v1/projects/:ref/audit/exports",
      organization_route: "POST /v1/organizations/:slug/audit/exports",
      formats: ["jsonl", "csv"],
      bound: "one project, at most 50000 rows, stored on the existing audit_exports row",
    },
    key_rotation: KEY_ROTATION_KINDS,
    sso: SSO_SEAM,
    scim: SCIM_GAP,
    byok: {
      supported_path: "POST /v1/projects/:ref/auth/oauth-server/kms-rs256 stores aws:kms:arn on the signing JWK",
      provider_call: false,
      gaps: [...BYOK_GAPS],
    },
  };
}
