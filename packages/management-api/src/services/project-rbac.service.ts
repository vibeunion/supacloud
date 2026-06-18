import type { Project } from "../db";
import { projectRepository } from "../repositories/project.repository";
import { config } from "../config";
import { resolveProjectServiceRoleKey } from "../utils/service-role";
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";
import { normalizeProjectRoutingConfig, resolveTenantPorts } from "../utils/project-routing";

export interface ProjectRbacPermission {
  id: string;
  name: string;
  description?: string | null;
  resource_id?: string | null;
  scope_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRbacRole {
  id: string;
  name: string;
  description?: string | null;
  permissions: ProjectRbacPermission[];
  created_at: string;
  updated_at: string;
}

export interface ProjectRbacAssignment {
  id: string;
  role_id: string;
  user_id?: string | null;
  organization_id?: string | null;
  application_id?: string | null;
  created_at: string;
}

export interface ProjectRbacConfig {
  roles: ProjectRbacRole[];
  assignments: ProjectRbacAssignment[];
  version: number;
  updated_at?: string;
}

export interface ProjectRbacUserPermissions {
  roles: string[];
  permissions: string[];
  scopes: string[];
}

export interface AssignRoleInput {
  user_id?: string | null;
  userId?: string | null;
  organization_id?: string | null;
  organizationId?: string | null;
  application_id?: string | null;
  applicationId?: string | null;
}

type RoleUpdateInput = {
  name?: string;
  description?: string | null;
};

type PermissionInput = {
  name?: string;
  description?: string | null;
  resource_id?: string | null;
  resourceId?: string | null;
  scope_id?: string | null;
  scopeId?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function normalizePermission(value: unknown): ProjectRbacPermission | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id);
  const name = optionalString(value.name);
  if (!id || !name) return null;
  const createdAt = optionalString(value.created_at) ?? nowIso();
  const updatedAt = optionalString(value.updated_at) ?? createdAt;
  return {
    id,
    name,
    description: optionalString(value.description) ?? null,
    resource_id: optionalString(value.resource_id) ?? optionalString(value.resourceId) ?? null,
    scope_id: optionalString(value.scope_id) ?? optionalString(value.scopeId) ?? null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function normalizeRole(value: unknown): ProjectRbacRole | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id);
  const name = optionalString(value.name);
  if (!id || !name) return null;
  const createdAt = optionalString(value.created_at) ?? nowIso();
  const updatedAt = optionalString(value.updated_at) ?? createdAt;
  const permissions = Array.isArray(value.permissions)
    ? value.permissions.map(normalizePermission).filter((item): item is ProjectRbacPermission => item !== null)
    : [];
  return {
    id,
    name,
    description: optionalString(value.description) ?? null,
    permissions,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function normalizeAssignment(value: unknown): ProjectRbacAssignment | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id);
  const roleId = optionalString(value.role_id) ?? optionalString(value.roleId);
  if (!id || !roleId) return null;
  const userId = optionalString(value.user_id) ?? optionalString(value.userId) ?? null;
  const applicationId = optionalString(value.application_id) ?? optionalString(value.applicationId) ?? null;
  if (!userId && !applicationId) return null;
  return {
    id,
    role_id: roleId,
    user_id: userId,
    organization_id: optionalString(value.organization_id) ?? optionalString(value.organizationId) ?? null,
    application_id: applicationId,
    created_at: optionalString(value.created_at) ?? nowIso(),
  };
}

function readRbacConfig(projectConfig: unknown): ProjectRbacConfig {
  const config = normalizeProjectConfig(projectConfig);
  const raw = isRecord(config.rbac) ? config.rbac : {};
  const roles = Array.isArray(raw.roles)
    ? raw.roles.map(normalizeRole).filter((item): item is ProjectRbacRole => item !== null)
    : [];
  const roleIds = new Set(roles.map((role) => role.id));
  const assignments = Array.isArray(raw.assignments)
    ? raw.assignments
      .map(normalizeAssignment)
      .filter((item): item is ProjectRbacAssignment => item !== null && roleIds.has(item.role_id))
    : [];
  const version = Number(raw.version);
  return {
    roles,
    assignments,
    version: Number.isFinite(version) && version > 0 ? Math.trunc(version) : 0,
    updated_at: optionalString(raw.updated_at) ?? undefined,
  };
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

function getRoleOrThrow(rbac: ProjectRbacConfig, roleId: string): ProjectRbacRole {
  const role = rbac.roles.find((item) => item.id === roleId);
  if (!role) throw Object.assign(new Error("Role not found"), { statusCode: 404 });
  return role;
}

function assignmentMatchesUser(assignment: ProjectRbacAssignment, userId: string, orgId?: string | null): boolean {
  if (assignment.user_id !== userId) return false;
  if (orgId && assignment.organization_id && assignment.organization_id !== orgId) return false;
  return true;
}

function resolvePermissionsFromConfig(
  rbac: ProjectRbacConfig,
  userId: string,
  orgId?: string | null,
): ProjectRbacUserPermissions {
  const rolesById = new Map(rbac.roles.map((role) => [role.id, role]));
  const assignments = rbac.assignments.filter((assignment) => assignmentMatchesUser(assignment, userId, orgId));
  const roles = assignments
    .map((assignment) => rolesById.get(assignment.role_id)?.name)
    .filter((value): value is string => Boolean(value));
  const permissions = assignments.flatMap((assignment) => rolesById.get(assignment.role_id)?.permissions ?? []);

  return {
    roles: uniqueSorted(roles),
    permissions: uniqueSorted(permissions.map((permission) => permission.name)),
    scopes: uniqueSorted(permissions.map((permission) => permission.scope_id)),
  };
}

function withNextVersion(rbac: ProjectRbacConfig): ProjectRbacConfig {
  return {
    ...rbac,
    version: rbac.version + 1,
    updated_at: nowIso(),
  };
}

async function saveRbacConfig(ref: string, currentProjectConfig: unknown, rbac: ProjectRbacConfig): Promise<ProjectRbacConfig> {
  const next = withNextVersion(rbac);
  const updated = await projectRepository.updateConfig(
    ref,
    mergeProjectConfig(currentProjectConfig, { rbac: next }),
  );
  if (!updated) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  return readRbacConfig(updated.config);
}

async function getProjectOrThrow(ref: string): Promise<Project> {
  const project = await projectRepository.findByRef(ref);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  return project;
}

async function getGoTrueAdminContext(ref: string) {
  const project = await projectRepository.findByRef(ref);
  if (!project) return null;

  const serviceRoleKey = await resolveProjectServiceRoleKey(project);
  if (!serviceRoleKey) return null;

  const projectConfig = normalizeProjectConfig(project.config);
  const ports = resolveTenantPorts(normalizeProjectRoutingConfig(projectConfig));
  const apiUrl = ports?.gotruePort
    ? `http://127.0.0.1:${ports.gotruePort}`
    : `http://${config.managementApiInternal}/auth/v1`;
  return { apiUrl, serviceRoleKey };
}

async function gotrueFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Auth service unavailable: ${message}`);
  }
}

async function updateGoTrueUserMetadata(
  apiUrl: string,
  userId: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  const url = `${apiUrl}/admin/users/${encodeURIComponent(userId)}`;
  const init = (method: "PUT" | "PATCH"): RequestInit => ({
    method,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const putRes = await gotrueFetch(url, init("PUT"));
  if (putRes.status !== 405) return putRes;

  return gotrueFetch(url, init("PATCH"));
}

async function syncUserMetadata(ref: string, userId: string, rbac: ProjectRbacConfig): Promise<void> {
  const ctx = await getGoTrueAdminContext(ref);
  if (!ctx) throw Object.assign(new Error("Project service role key not found"), { statusCode: 404 });

  const headers = {
    apikey: ctx.serviceRoleKey,
    Authorization: `Bearer ${ctx.serviceRoleKey}`,
    "x-project-ref": ref,
  };
  const userRes = await gotrueFetch(`${ctx.apiUrl}/admin/users/${encodeURIComponent(userId)}`, { headers });
  if (!userRes.ok) {
    throw Object.assign(new Error("Failed to fetch user for RBAC metadata sync"), { statusCode: userRes.status });
  }

  const user = await userRes.json() as Record<string, unknown>;
  const appMetadata = isRecord(user.app_metadata) ? user.app_metadata : {};
  const existingSupauth = isRecord(appMetadata.supaoauth) ? appMetadata.supaoauth : {};
  const resolved = resolvePermissionsFromConfig(rbac, userId);
  const orgIds = uniqueSorted(rbac.assignments
    .filter((assignment) => assignment.user_id === userId)
    .map((assignment) => assignment.organization_id));
  const existingCurrentOrgId = typeof existingSupauth.current_org_id === "string"
    ? existingSupauth.current_org_id
    : undefined;
  const currentOrgId = existingCurrentOrgId && orgIds.includes(existingCurrentOrgId)
    ? existingCurrentOrgId
    : orgIds.length === 1 ? orgIds[0] : undefined;

  const updateRes = await updateGoTrueUserMetadata(ctx.apiUrl, userId, headers, {
    app_metadata: {
      ...appMetadata,
      supaoauth: {
        ...existingSupauth,
        roles: resolved.roles,
        permissions: resolved.permissions,
        scopes: resolved.scopes,
        organization_ids: orgIds,
        current_org_id: currentOrgId,
        rbac_version: rbac.version,
        rbac_synced_at: nowIso(),
      },
    },
  });
  if (!updateRes.ok) {
    throw Object.assign(new Error("Failed to sync RBAC metadata to user"), { statusCode: updateRes.status });
  }
}

async function syncUsersMetadata(ref: string, userIds: string[], rbac: ProjectRbacConfig): Promise<void> {
  for (const userId of uniqueSorted(userIds)) {
    await syncUserMetadata(ref, userId, rbac);
  }
}

function affectedUserIds(assignments: ProjectRbacAssignment[]): string[] {
  return uniqueSorted(assignments.map((assignment) => assignment.user_id));
}

export const projectRbacService = {
  async listRoles(ref: string): Promise<ProjectRbacRole[]> {
    const project = await getProjectOrThrow(ref);
    return readRbacConfig(project.config).roles;
  },

  async createRole(ref: string, input: { name: string; description?: string | null }): Promise<ProjectRbacRole> {
    const name = input.name.trim();
    if (!name) throw Object.assign(new Error("name is required"), { statusCode: 400 });

    const project = await getProjectOrThrow(ref);
    const rbac = readRbacConfig(project.config);
    if (rbac.roles.some((role) => role.name.toLowerCase() === name.toLowerCase())) {
      throw Object.assign(new Error("Role name already exists"), { statusCode: 409 });
    }

    const timestamp = nowIso();
    const role: ProjectRbacRole = {
      id: makeId("role"),
      name,
      description: input.description ?? null,
      permissions: [],
      created_at: timestamp,
      updated_at: timestamp,
    };
    const saved = await saveRbacConfig(ref, project.config, { ...rbac, roles: [...rbac.roles, role] });
    return getRoleOrThrow(saved, role.id);
  },

  async getRole(ref: string, roleId: string): Promise<ProjectRbacRole> {
    const project = await getProjectOrThrow(ref);
    return getRoleOrThrow(readRbacConfig(project.config), roleId);
  },

  async updateRole(ref: string, roleId: string, input: RoleUpdateInput): Promise<ProjectRbacRole> {
    const project = await getProjectOrThrow(ref);
    const rbac = readRbacConfig(project.config);
    const role = getRoleOrThrow(rbac, roleId);
    const nextName = input.name?.trim() || role.name;
    if (rbac.roles.some((item) => item.id !== roleId && item.name.toLowerCase() === nextName.toLowerCase())) {
      throw Object.assign(new Error("Role name already exists"), { statusCode: 409 });
    }
    const roles = rbac.roles.map((item) => item.id === roleId
      ? { ...item, name: nextName, description: input.description ?? item.description ?? null, updated_at: nowIso() }
      : item);
    const saved = await saveRbacConfig(ref, project.config, { ...rbac, roles });
    const updated = getRoleOrThrow(saved, roleId);
    await syncUsersMetadata(ref, affectedUserIds(saved.assignments.filter((assignment) => assignment.role_id === roleId)), saved);
    return updated;
  },

  async deleteRole(ref: string, roleId: string): Promise<void> {
    const project = await getProjectOrThrow(ref);
    const rbac = readRbacConfig(project.config);
    getRoleOrThrow(rbac, roleId);
    const removedAssignments = rbac.assignments.filter((assignment) => assignment.role_id === roleId);
    const saved = await saveRbacConfig(ref, project.config, {
      ...rbac,
      roles: rbac.roles.filter((role) => role.id !== roleId),
      assignments: rbac.assignments.filter((assignment) => assignment.role_id !== roleId),
    });
    await syncUsersMetadata(ref, affectedUserIds(removedAssignments), saved);
  },

  async listRolePermissions(ref: string, roleId: string): Promise<ProjectRbacPermission[]> {
    const project = await getProjectOrThrow(ref);
    return getRoleOrThrow(readRbacConfig(project.config), roleId).permissions;
  },

  async createPermission(ref: string, roleId: string, input: PermissionInput): Promise<ProjectRbacPermission> {
    const name = input.name?.trim();
    if (!name) throw Object.assign(new Error("name is required"), { statusCode: 400 });

    const project = await getProjectOrThrow(ref);
    const rbac = readRbacConfig(project.config);
    const role = getRoleOrThrow(rbac, roleId);
    if (role.permissions.some((permission) => permission.name.toLowerCase() === name.toLowerCase())) {
      throw Object.assign(new Error("Permission name already exists"), { statusCode: 409 });
    }
    const timestamp = nowIso();
    const permission: ProjectRbacPermission = {
      id: makeId("perm"),
      name,
      description: input.description ?? null,
      resource_id: input.resource_id ?? input.resourceId ?? null,
      scope_id: input.scope_id ?? input.scopeId ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const roles = rbac.roles.map((item) => item.id === roleId
      ? { ...item, permissions: [...item.permissions, permission], updated_at: timestamp }
      : item);
    const saved = await saveRbacConfig(ref, project.config, { ...rbac, roles });
    await syncUsersMetadata(ref, affectedUserIds(saved.assignments.filter((assignment) => assignment.role_id === roleId)), saved);
    return getRoleOrThrow(saved, roleId).permissions.find((item) => item.id === permission.id) ?? permission;
  },

  async deletePermission(ref: string, roleId: string, permissionId: string): Promise<void> {
    const project = await getProjectOrThrow(ref);
    const rbac = readRbacConfig(project.config);
    const role = getRoleOrThrow(rbac, roleId);
    if (!role.permissions.some((permission) => permission.id === permissionId)) {
      throw Object.assign(new Error("Permission not found"), { statusCode: 404 });
    }
    const roles = rbac.roles.map((item) => item.id === roleId
      ? { ...item, permissions: item.permissions.filter((permission) => permission.id !== permissionId), updated_at: nowIso() }
      : item);
    const saved = await saveRbacConfig(ref, project.config, { ...rbac, roles });
    await syncUsersMetadata(ref, affectedUserIds(saved.assignments.filter((assignment) => assignment.role_id === roleId)), saved);
  },

  async assignRole(ref: string, roleId: string, input: AssignRoleInput): Promise<ProjectRbacAssignment> {
    const userId = input.user_id ?? input.userId ?? null;
    const organizationId = input.organization_id ?? input.organizationId ?? null;
    const applicationId = input.application_id ?? input.applicationId ?? null;
    if (!userId && !applicationId) {
      throw Object.assign(new Error("Either userId or applicationId is required for role assignment"), { statusCode: 400 });
    }

    const project = await getProjectOrThrow(ref);
    const rbac = readRbacConfig(project.config);
    getRoleOrThrow(rbac, roleId);
    const existing = rbac.assignments.find((assignment) =>
      assignment.role_id === roleId &&
      assignment.user_id === userId &&
      assignment.organization_id === organizationId &&
      assignment.application_id === applicationId
    );
    if (existing) {
      if (userId) await syncUserMetadata(ref, userId, rbac);
      return existing;
    }

    const assignment: ProjectRbacAssignment = {
      id: makeId("assign"),
      role_id: roleId,
      user_id: userId,
      organization_id: organizationId,
      application_id: applicationId,
      created_at: nowIso(),
    };
    const saved = await saveRbacConfig(ref, project.config, { ...rbac, assignments: [...rbac.assignments, assignment] });
    if (userId) await syncUserMetadata(ref, userId, saved);
    return saved.assignments.find((item) => item.id === assignment.id) ?? assignment;
  },

  async revokeRole(ref: string, roleId: string, assignmentId: string): Promise<void> {
    const project = await getProjectOrThrow(ref);
    const rbac = readRbacConfig(project.config);
    getRoleOrThrow(rbac, roleId);
    const assignment = rbac.assignments.find((item) => item.id === assignmentId && item.role_id === roleId);
    if (!assignment) throw Object.assign(new Error("Assignment not found"), { statusCode: 404 });
    const saved = await saveRbacConfig(ref, project.config, {
      ...rbac,
      assignments: rbac.assignments.filter((item) => item.id !== assignmentId),
    });
    if (assignment.user_id) await syncUserMetadata(ref, assignment.user_id, saved);
  },

  async listUserRoleAssignments(ref: string, userId: string): Promise<Array<ProjectRbacAssignment & { role?: ProjectRbacRole }>> {
    const project = await getProjectOrThrow(ref);
    const rbac = readRbacConfig(project.config);
    const rolesById = new Map(rbac.roles.map((role) => [role.id, role]));
    return rbac.assignments
      .filter((assignment) => assignment.user_id === userId)
      .map((assignment) => ({ ...assignment, role: rolesById.get(assignment.role_id) }));
  },

  async listOrganizationRoleAssignments(ref: string, orgId: string): Promise<Array<ProjectRbacAssignment & { role?: ProjectRbacRole }>> {
    const project = await getProjectOrThrow(ref);
    const rbac = readRbacConfig(project.config);
    const rolesById = new Map(rbac.roles.map((role) => [role.id, role]));
    return rbac.assignments
      .filter((assignment) => assignment.organization_id === orgId)
      .map((assignment) => ({ ...assignment, role: rolesById.get(assignment.role_id) }));
  },

  async resolveUserPermissions(ref: string, userId: string, orgId?: string | null): Promise<ProjectRbacUserPermissions> {
    const project = await getProjectOrThrow(ref);
    return resolvePermissionsFromConfig(readRbacConfig(project.config), userId, orgId);
  },
};
