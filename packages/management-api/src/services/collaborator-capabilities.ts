import { ValidationError } from "../utils/errors";

export type CollaboratorRole = "owner" | "admin" | "member" | "viewer";
export type CollaboratorCapability =
  | "applications.read"
  | "applications.manage"
  | "users.read"
  | "users.manage"
  | "roles.read"
  | "roles.manage"
  | "connectors.read"
  | "connectors.manage"
  | "tenant.members.read"
  | "tenant.members.manage"
  | "tenant.owner.transfer"
  | "tenant.config.read"
  | "tenant.config.manage"
  | "tenant.capabilities.read"
  | "tenant.capabilities.manage"
  | "tenant.domains.read"
  | "tenant.domains.manage"
  | "organizations.read"
  | "organizations.manage"
  | "webhooks.read"
  | "webhooks.manage"
  | "webhooks.replay"
  | "audit.read"
  | "audit.write"
  | "audit.export"
  | "audit.read_sensitive"
  | "security.read"
  | "security.manage"
  | "operations.read"
  | "operations.manage"
  | "database.migrations.read"
  | "database.migrations.manage"
  | "project.read"
  | "project.manage";

export const ROLE_CAPABILITIES: Record<CollaboratorRole, readonly CollaboratorCapability[]> = {
  owner: [
    "applications.read", "applications.manage",
    "users.read", "users.manage",
    "roles.read", "roles.manage",
    "connectors.read", "connectors.manage",
    "tenant.members.read", "tenant.members.manage", "tenant.owner.transfer",
    "tenant.config.read", "tenant.config.manage",
    "tenant.capabilities.read", "tenant.capabilities.manage",
    "tenant.domains.read", "tenant.domains.manage",
    "organizations.read", "organizations.manage",
    "webhooks.read", "webhooks.manage", "webhooks.replay",
    "audit.read", "audit.write", "audit.export", "audit.read_sensitive",
    "security.read", "security.manage",
    "operations.read", "operations.manage",
    "database.migrations.read", "database.migrations.manage",
    "project.read", "project.manage",
  ],
  admin: [
    "applications.read", "applications.manage",
    "users.read", "users.manage",
    "roles.read", "roles.manage",
    "connectors.read", "connectors.manage",
    "tenant.members.read", "tenant.members.manage",
    "tenant.config.read", "tenant.config.manage",
    "tenant.capabilities.read", "tenant.capabilities.manage",
    "tenant.domains.read", "tenant.domains.manage",
    "organizations.read", "organizations.manage",
    "webhooks.read", "webhooks.manage", "webhooks.replay",
    "audit.read", "audit.write", "audit.export",
    "security.read", "security.manage",
    "operations.read", "operations.manage",
    "database.migrations.read", "database.migrations.manage",
    "project.read", "project.manage",
  ],
  member: ["tenant.members.read", "organizations.read", "webhooks.read", "audit.read"],
  viewer: ["tenant.members.read", "organizations.read", "webhooks.read", "audit.read"],
};

const TEAM_GRANT_ACTOR_PREFIX = "organization-team:";

export function teamGrantActor(teamId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(teamId)) {
    throw new ValidationError("Invalid team id");
  }
  return `${TEAM_GRANT_ACTOR_PREFIX}${teamId.toLowerCase()}`;
}

export function isTeamGrantActor(createdBy: unknown, teamId?: string): boolean {
  if (typeof createdBy !== "string" || !createdBy.startsWith(TEAM_GRANT_ACTOR_PREFIX)) return false;
  return teamId === undefined || createdBy === teamGrantActor(teamId);
}

/**
 * Null keeps the role default. A list narrows that role and cannot add
 * capabilities the role does not already have.
 */
export function effectiveCollaboratorCapabilities(
  role: CollaboratorRole,
  allowlist: readonly string[] | null | undefined,
): CollaboratorCapability[] {
  const roleCapabilities = ROLE_CAPABILITIES[role] ?? [];
  if (allowlist == null) return [...roleCapabilities];
  const allowed = new Set(allowlist);
  return roleCapabilities.filter((capability) => allowed.has(capability));
}

export function normalizeCapabilityAllowlist(
  role: CollaboratorRole,
  requested: readonly string[] | null | undefined,
): CollaboratorCapability[] | null {
  if (requested == null) return null;
  if (requested.length === 0) {
    throw new ValidationError("capability allowlist cannot be empty; omit it to keep the role default");
  }
  const roleCapabilities = new Set<string>(ROLE_CAPABILITIES[role] ?? []);
  const normalized: CollaboratorCapability[] = [];
  for (const entry of requested) {
    const name = entry.trim();
    if (!roleCapabilities.has(name)) {
      throw new ValidationError(`capability ${name} is outside the ${role} role`);
    }
    const capability = name as CollaboratorCapability;
    if (!normalized.includes(capability)) normalized.push(capability);
  }
  return normalized;
}
