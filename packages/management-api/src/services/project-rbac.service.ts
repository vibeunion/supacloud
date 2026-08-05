import type { Project } from "../db";
import type { SQL } from "bun";
import { projectRepository } from "../repositories/project.repository";
import { config } from "../config";
import { resolveProjectServiceRoleKey } from "../utils/service-role";
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";
import { normalizeProjectRoutingConfig, resolveTenantPorts } from "../utils/project-routing";
import { getProjectDb, resolveDbName, sql } from "../db";
import { getAuthRuntimeDescriptor } from "./auth-runtime.service";
import { enqueueWebhookEventInTransaction } from "./webhook-delivery.service";

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
  application_ids: string[];
  version: number;
  updated_at?: string;
}

interface ProjectRbacPermissionSet {
  roles: string[];
  permissions: string[];
  scopes: string[];
  roles_count?: number;
  roles_truncated?: true;
  roles_projection_limit?: number;
  permissions_count?: number;
  permissions_truncated?: true;
  permissions_projection_limit?: number;
}

interface ProjectRbacApplicationPermissions extends ProjectRbacPermissionSet {
  organization_ids: string[];
  organizations: Record<string, ProjectRbacPermissionSet>;
}

const RBAC_PROJECTION_LIMITS = {
  roles: 64,
  permissions: 256,
  scopesBytes: 2_048,
  organizationIdsBytes: 2_048,
  organizationsBytes: 6_144,
  applicationsBytes: 8_192,
  projectBytes: 16_384,
  namespaceBytes: 65_536,
} as const;

const GOTRUE_METADATA_SYNC_TIMEOUT_MS = 5_000;

const PROJECT_PROJECTION_STATUS_KEYS = new Set([
  "roles_count",
  "roles_truncated",
  "roles_projection_limit",
  "permissions_count",
  "permissions_truncated",
  "permissions_projection_limit",
  "scopes_count",
  "organization_ids_count",
  "organizations_count",
  "applications_count",
  "truncated",
  "projection_limit",
  "projection_unavailable",
]);

export interface ProjectRbacUserPermissions extends ProjectRbacPermissionSet {
  application_id?: string | null;
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

type RoleAssignmentWebhookInput = {
  projectRef: string;
  eventType: "role.assigned" | "role.revoked";
  assignment: ProjectRbacAssignment;
  actor: string;
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
  const configuredApplicationIds = Array.isArray(raw.application_ids)
    ? raw.application_ids.map(optionalString)
    : [];
  return {
    roles,
    assignments,
    application_ids: uniqueSorted([
      ...configuredApplicationIds,
      ...assignments.map((assignment) => assignment.application_id),
    ]),
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

function assignmentScopeMatches(
  assignmentScope: string | null | undefined,
  requestedScope: string | null | undefined,
): boolean {
  if (requestedScope === undefined || requestedScope === null) {
    return !assignmentScope;
  }
  return !assignmentScope || assignmentScope === requestedScope;
}

function assignmentMatchesUser(
  assignment: ProjectRbacAssignment,
  userId: string,
  orgId?: string | null,
  applicationId?: string | null,
): boolean {
  if (assignment.user_id !== userId) return false;
  return assignmentScopeMatches(assignment.organization_id, orgId)
    && assignmentScopeMatches(assignment.application_id, applicationId);
}

function resolvePermissionSet(
  rbac: ProjectRbacConfig,
  assignments: ProjectRbacAssignment[],
): ProjectRbacPermissionSet {
  const rolesById = new Map(rbac.roles.map((role) => [role.id, role]));
  const roles = assignments
    .map((assignment) => rolesById.get(assignment.role_id)?.name)
    .filter((value): value is string => Boolean(value));
  const permissions = assignments.flatMap((assignment) => rolesById.get(assignment.role_id)?.permissions ?? []);

  const resolvedRoles = uniqueSorted(roles);
  const resolvedPermissions = uniqueSorted(permissions.map((permission) => permission.name));
  const roleOverflow = resolvedRoles.length > RBAC_PROJECTION_LIMITS.roles;
  const permissionOverflow = resolvedPermissions.length > RBAC_PROJECTION_LIMITS.permissions;
  return {
    roles: roleOverflow ? [] : resolvedRoles,
    permissions: permissionOverflow ? [] : resolvedPermissions,
    scopes: uniqueSorted(permissions.map((permission) => permission.scope_id)),
    ...(roleOverflow
      ? {
        roles_count: resolvedRoles.length,
        roles_truncated: true,
        roles_projection_limit: RBAC_PROJECTION_LIMITS.roles,
      }
      : {}),
    ...(permissionOverflow
      ? {
        permissions_count: resolvedPermissions.length,
        permissions_truncated: true,
        permissions_projection_limit: RBAC_PROJECTION_LIMITS.permissions,
      }
      : {}),
  };
}

function resolveApplicationMetadata(
  rbac: ProjectRbacConfig,
  userId: string,
  applicationId: string,
): ProjectRbacApplicationPermissions {
  const assignments = rbac.assignments.filter((assignment) =>
    assignment.user_id === userId
    && (!assignment.application_id || assignment.application_id === applicationId)
  );
  const organizationIds = uniqueSorted(assignments.map((assignment) => assignment.organization_id));
  const organizations = Object.fromEntries(organizationIds.map((organizationId) => [
    organizationId,
    resolvePermissionSet(
      rbac,
      assignments.filter((assignment) => !assignment.organization_id || assignment.organization_id === organizationId),
    ),
  ]));

  return {
    ...resolvePermissionSet(rbac, assignments.filter((assignment) => !assignment.organization_id)),
    organization_ids: organizationIds,
    organizations,
  };
}

function resolvePermissionsFromConfig(
  rbac: ProjectRbacConfig,
  userId: string,
  orgId?: string | null,
  applicationId?: string | null,
): ProjectRbacUserPermissions {
  const assignments = rbac.assignments.filter((assignment) => assignmentMatchesUser(assignment, userId, orgId, applicationId));

  return {
    ...(applicationId !== undefined ? { application_id: applicationId } : {}),
    ...resolvePermissionSet(rbac, assignments),
  };
}

function withNextVersion(rbac: ProjectRbacConfig): ProjectRbacConfig {
  return {
    ...rbac,
    application_ids: uniqueSorted([
      ...rbac.application_ids,
      ...rbac.assignments.map((assignment) => assignment.application_id),
    ]),
    version: rbac.version + 1,
    updated_at: nowIso(),
  };
}

async function saveRbacConfig(
  database: SQL,
  ref: string,
  currentProjectConfig: unknown,
  rbac: ProjectRbacConfig,
): Promise<ProjectRbacConfig> {
  const next = withNextVersion(rbac);
  const [updated] = await database`
    UPDATE projects
    SET config = ${JSON.stringify(mergeProjectConfig(currentProjectConfig, { rbac: next }))}::jsonb,
        updated_at = NOW()
    WHERE ref = ${ref} AND deleted_at IS NULL
    RETURNING *
  ` as Project[];
  if (!updated) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  return readRbacConfig(updated.config);
}

async function getProjectOrThrow(ref: string): Promise<Project> {
  const project = await projectRepository.findByRef(ref);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  return project;
}

async function withProjectRbacConfigLock<T>(
  ref: string,
  mutation: (project: Project, rbac: ProjectRbacConfig, transaction: SQL) => Promise<T>,
): Promise<T> {
  return sql.begin(async (transaction) => {
    const lockKey = `rbac-project-config:${ref}`;
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const [project] = await transaction`
      SELECT * FROM projects
      WHERE ref = ${ref} AND deleted_at IS NULL
      FOR UPDATE
    ` as Project[];
    if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
    return mutation(project, readRbacConfig(project.config), transaction);
  });
}

async function enqueueRoleAssignmentWebhook(
  database: SQL,
  input: RoleAssignmentWebhookInput,
): Promise<void> {
  const assignment = input.assignment;
  await enqueueWebhookEventInTransaction(database, {
    projectRef: input.projectRef,
    event: {
      type: input.eventType,
      payload: {
        assignment_id: assignment.id,
        role_id: assignment.role_id,
        user_id: assignment.user_id,
        organization_id: assignment.organization_id,
        application_id: assignment.application_id,
      },
    },
    idempotencyKey: `${input.eventType}:${assignment.id}`,
    actor: input.actor,
  });
}

async function assertAssignmentTargets(
  ref: string,
  userId: string | null,
  applicationId: string | null,
  organizationId: string | null,
): Promise<void> {
  if (!userId && !applicationId) {
    throw Object.assign(new Error("A userId or applicationId target is required for role assignment"), {
      statusCode: 400,
    });
  }

  if (userId) await projectRbacTargetService.assertUser(ref, userId);
  if (applicationId) await projectRbacTargetService.assertApplication(ref, applicationId);
  if (organizationId) await projectRbacTargetService.assertOrganization(ref, organizationId);
}

export const projectRbacTargetService = {
  async assertUser(ref: string, userId: string): Promise<void> {
    const authorityRef = getAuthRuntimeDescriptor(ref).authority_project_ref;
    const authorityDb = getProjectDb(await resolveDbName(authorityRef));
    const [user] = await authorityDb`SELECT id FROM auth.users WHERE id::text = ${userId} LIMIT 1`;
    if (!user) throw Object.assign(new Error("GoTrue user not found"), { statusCode: 404 });
  },

  async assertApplication(ref: string, applicationId: string): Promise<void> {
    const authorityRef = getAuthRuntimeDescriptor(ref).authority_project_ref;
    const authorityDb = getProjectDb(await resolveDbName(authorityRef));
    try {
      const [application] = await authorityDb`
        SELECT id FROM auth.oauth_clients
        WHERE id::text = ${applicationId} AND deleted_at IS NULL
        LIMIT 1
      `;
      if (!application) throw Object.assign(new Error("GoTrue OAuth client not found"), { statusCode: 404 });
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null ? String((error as { code?: unknown }).code || "") : "";
      if (code === "42P01" || code === "42703") {
        throw Object.assign(new Error("GoTrue OAuth server capability is unavailable"), { statusCode: 501 });
      }
      throw error;
    }
  },

  async assertOrganization(ref: string, organizationId: string): Promise<void> {
    const [organization] = await sql`
      SELECT id FROM project_business_organizations
      WHERE project_ref = ${ref} AND id::text = ${organizationId}
      LIMIT 1
    `;
    if (!organization) throw Object.assign(new Error("Business organization not found"), { statusCode: 404 });
  },
};

async function getGoTrueAdminContext(ref: string) {
  const authorityRef = getAuthRuntimeDescriptor(ref).authority_project_ref;
  const authorityProject = await projectRepository.findByRef(authorityRef);
  if (!authorityProject) return null;

  const serviceRoleKey = await resolveProjectServiceRoleKey(authorityProject);
  if (!serviceRoleKey) return null;

  const authorityConfig = normalizeProjectConfig(authorityProject.config);
  const ports = resolveTenantPorts(normalizeProjectRoutingConfig(authorityConfig));
  const apiUrl = ports?.gotruePort
    ? `http://127.0.0.1:${ports.gotruePort}`
    : `http://${config.managementApiInternal}/auth/v1`;
  return { apiUrl, authorityRef, serviceRoleKey };
}

async function gotrueFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    const requestInit = init?.signal
      ? init
      : { ...init, signal: AbortSignal.timeout(GOTRUE_METADATA_SYNC_TIMEOUT_MS) };
    return await fetch(url, requestInit);
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

function resolveOrganizationProjection(
  rbac: ProjectRbacConfig,
  userId: string,
): { organizationIds: string[]; organizations: Record<string, ProjectRbacPermissionSet> } {
  const organizationAssignments = rbac.assignments.filter((assignment) =>
    assignment.user_id === userId && !assignment.application_id,
  );
  const organizationIds = uniqueSorted(organizationAssignments.map((assignment) => assignment.organization_id));
  const organizations = Object.fromEntries(organizationIds.map((organizationId) => [
    organizationId,
    resolvePermissionSet(
      rbac,
      organizationAssignments.filter((assignment) =>
        !assignment.organization_id || assignment.organization_id === organizationId,
      ),
    ),
  ]));
  return { organizationIds, organizations };
}

function currentOrganizationId(
  existingProjection: Record<string, unknown>,
  organizationIds: string[],
): string | undefined {
  const existingCurrentOrgId = typeof existingProjection.current_org_id === "string"
    ? existingProjection.current_org_id
    : undefined;
  return existingCurrentOrgId && organizationIds.includes(existingCurrentOrgId)
    ? existingCurrentOrgId
    : organizationIds.length === 1 ? organizationIds[0] : undefined;
}

function resolveApplicationProjections(
  rbac: ProjectRbacConfig,
  userId: string,
): Record<string, ProjectRbacApplicationPermissions> {
  // Application IDs are project-owned RBAC state. They remain known after the
  // last user assignment is revoked, so a sync cannot erase a namespace that
  // still carries project-wide grants. Existing user metadata is never used as
  // an authority for namespace discovery or permission contents.
  return Object.fromEntries(rbac.application_ids.map((applicationId) => [
    applicationId,
    resolveApplicationMetadata(rbac, userId, applicationId),
  ]));
}

function jsonByteLength(jsonValue: unknown): number {
  return new TextEncoder().encode(JSON.stringify(jsonValue)).byteLength;
}

function exceededProjectionByteLimit(projection: Record<string, unknown>): number | null {
  const fieldBudgets: Array<[unknown, number]> = [
    [projection.scopes, RBAC_PROJECTION_LIMITS.scopesBytes],
    [projection.organization_ids, RBAC_PROJECTION_LIMITS.organizationIdsBytes],
    [projection.organizations, RBAC_PROJECTION_LIMITS.organizationsBytes],
    [projection.applications, RBAC_PROJECTION_LIMITS.applicationsBytes],
  ];
  const exceededField = fieldBudgets.find(([field, limit]) => jsonByteLength(field) > limit);
  if (exceededField) return exceededField[1];
  return jsonByteLength(projection) > RBAC_PROJECTION_LIMITS.projectBytes
    ? RBAC_PROJECTION_LIMITS.projectBytes
    : null;
}

function projectionArrayCount(
  projection: Record<string, unknown>,
  arrayKey: string,
  overflowCountKey: string,
): number {
  const overflowCount = projection[overflowCountKey];
  if (typeof overflowCount === "number") return overflowCount;
  return Array.isArray(projection[arrayKey]) ? projection[arrayKey].length : 0;
}

function unavailableRbacProjection(
  projection: Record<string, unknown>,
  rbacVersion: number,
  projectionLimit: number,
): Record<string, unknown> {
  const organizations = isRecord(projection.organizations) ? projection.organizations : {};
  const applications = isRecord(projection.applications) ? projection.applications : {};
  return {
    roles: [],
    permissions: [],
    scopes: [],
    organization_ids: [],
    organizations: {},
    applications: {},
    rbac_version: rbacVersion,
    roles_count: projectionArrayCount(projection, "roles", "roles_count"),
    permissions_count: projectionArrayCount(projection, "permissions", "permissions_count"),
    scopes_count: projectionArrayCount(projection, "scopes", "scopes_count"),
    organization_ids_count: projectionArrayCount(projection, "organization_ids", "organization_ids_count"),
    organizations_count: Object.keys(organizations).length,
    applications_count: Object.keys(applications).length,
    truncated: true,
    projection_limit: projectionLimit,
    projection_unavailable: true,
  };
}

function projectMetadataWithoutProjectionStatus(
  existingProjection: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(existingProjection).filter(([key]) => !PROJECT_PROJECTION_STATUS_KEYS.has(key)),
  );
}

function buildUserRbacProjection(
  rbac: ProjectRbacConfig,
  userId: string,
  existingProjection: Record<string, unknown>,
): Record<string, unknown> {
  const resolved = resolvePermissionsFromConfig(rbac, userId);
  const { organizationIds, organizations } = resolveOrganizationProjection(rbac, userId);

  const projection = {
    ...projectMetadataWithoutProjectionStatus(existingProjection),
    ...resolved,
    organization_ids: organizationIds,
    current_org_id: currentOrganizationId(existingProjection, organizationIds),
    organizations,
    applications: resolveApplicationProjections(rbac, userId),
    rbac_version: rbac.version,
    rbac_synced_at: nowIso(),
  };
  const exceededLimit = exceededProjectionByteLimit(projection);
  return exceededLimit === null
    ? projection
    : unavailableRbacProjection(projection, rbac.version, exceededLimit);
}

function validSupaoauthHook(rawHook: unknown): Record<string, unknown> | null {
  if (!isRecord(rawHook)) return null;
  const keys = Object.keys(rawHook).sort();
  if (keys.join(",") !== "authentication_method,processed_at,version") return null;
  if (rawHook.version !== 1 || typeof rawHook.authentication_method !== "string") return null;
  if (!rawHook.authentication_method.trim() || typeof rawHook.processed_at !== "string") return null;
  const processedAt = new Date(rawHook.processed_at);
  if (Number.isNaN(processedAt.valueOf()) || processedAt.toISOString() !== rawHook.processed_at) return null;
  return rawHook;
}

function rootSupaoauthMetadata(existingSupaoauth: Record<string, unknown>): Record<string, unknown> {
  const hook = validSupaoauthHook(existingSupaoauth.hook);
  return hook ? { hook } : {};
}

function mergeRbacProjection(
  ref: string,
  existingSupaoauth: Record<string, unknown>,
  rbac: ProjectRbacConfig,
  userId: string,
): Record<string, unknown> {
  const existingProjects = isRecord(existingSupaoauth.projects) ? existingSupaoauth.projects : {};
  const existingProject = isRecord(existingProjects[ref]) ? existingProjects[ref] : {};
  const projection = buildUserRbacProjection(rbac, userId, existingProject);
  return mergeProjectProjection(ref, existingSupaoauth, projection);
}

function mergeProjectProjection(
  ref: string,
  existingSupaoauth: Record<string, unknown>,
  projection: Record<string, unknown>,
): Record<string, unknown> {
  const existingProjects = isRecord(existingSupaoauth.projects) ? existingSupaoauth.projects : {};
  const nextSupaoauth = {
    ...rootSupaoauthMetadata(existingSupaoauth),
    schema_version: 2,
    projects: {
      ...existingProjects,
      [ref]: projection,
    },
  };
  return boundedSupaoauthNamespace(nextSupaoauth);
}

function minimalUnavailableProject(rawProject: unknown): Record<string, unknown> {
  const project = isRecord(rawProject) ? rawProject : {};
  const rawVersion = project.rbac_version;
  const rbacVersion = typeof rawVersion === "number" && Number.isSafeInteger(rawVersion) && rawVersion >= 0
    ? rawVersion
    : 0;
  return unavailableRbacProjection(project, rbacVersion, RBAC_PROJECTION_LIMITS.namespaceBytes);
}

function boundedSupaoauthNamespace(supaoauth: Record<string, unknown>): Record<string, unknown> {
  if (jsonByteLength(supaoauth) <= RBAC_PROJECTION_LIMITS.namespaceBytes) return supaoauth;
  const projects = isRecord(supaoauth.projects) ? supaoauth.projects : {};
  const unavailableProjects = Object.fromEntries(
    Object.entries(projects).map(([ref, project]) => [ref, minimalUnavailableProject(project)]),
  );
  const unavailableNamespace = { ...supaoauth, projects: unavailableProjects };
  return jsonByteLength(unavailableNamespace) <= RBAC_PROJECTION_LIMITS.namespaceBytes
    ? unavailableNamespace
    : { ...supaoauth, projects: {} };
}

function canonicalJson(jsonValue: unknown): string {
  if (Array.isArray(jsonValue)) return `[${jsonValue.map(canonicalJson).join(",")}]`;
  if (!isRecord(jsonValue)) return JSON.stringify(jsonValue) ?? "null";
  return `{${Object.keys(jsonValue).filter((key) => jsonValue[key] !== undefined).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(jsonValue[key])}`
  ).join(",")}}`;
}

async function readGoTrueUserMetadata(
  apiUrl: string,
  userId: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const userRes = await gotrueFetch(`${apiUrl}/admin/users/${encodeURIComponent(userId)}`, { headers });
  if (!userRes.ok) {
    throw Object.assign(new Error("Failed to fetch user for RBAC metadata sync"), { statusCode: userRes.status });
  }
  const user = await userRes.json() as Record<string, unknown>;
  return isRecord(user.app_metadata) ? user.app_metadata : {};
}

function gotrueAdminHeaders(
  ctx: NonNullable<Awaited<ReturnType<typeof getGoTrueAdminContext>>>,
): Record<string, string> {
  return {
    apikey: ctx.serviceRoleKey,
    Authorization: `Bearer ${ctx.serviceRoleKey}`,
    "x-project-ref": ctx.authorityRef,
  };
}

function assertAppMetadataReadBack(
  confirmedMetadata: Record<string, unknown>,
  expectedMetadata: Record<string, unknown>,
): void {
  const confirmedSupaoauth = isRecord(confirmedMetadata.supaoauth) ? confirmedMetadata.supaoauth : {};
  const matchesSchema = confirmedSupaoauth.schema_version === 2;
  const matchesMetadata = canonicalJson(confirmedMetadata) === canonicalJson(expectedMetadata);
  if (!matchesSchema || !matchesMetadata) {
    throw Object.assign(new Error("RBAC metadata read-back verification failed"), { statusCode: 502 });
  }
}

async function persistAndVerifyAppMetadata(
  ctx: NonNullable<Awaited<ReturnType<typeof getGoTrueAdminContext>>>,
  userId: string,
  headers: Record<string, string>,
  nextAppMetadata: Record<string, unknown>,
): Promise<void> {
  const updateRes = await updateGoTrueUserMetadata(ctx.apiUrl, userId, headers, {
    app_metadata: nextAppMetadata,
  });
  if (!updateRes.ok) {
    throw Object.assign(new Error("Failed to sync RBAC metadata to user"), { statusCode: updateRes.status });
  }
  const confirmedMetadata = await readGoTrueUserMetadata(ctx.apiUrl, userId, headers);
  assertAppMetadataReadBack(confirmedMetadata, nextAppMetadata);
}

async function syncLockedUserMetadata(
  ref: string,
  userId: string,
  rbac: ProjectRbacConfig,
  ctx: NonNullable<Awaited<ReturnType<typeof getGoTrueAdminContext>>>,
): Promise<void> {
  const headers = gotrueAdminHeaders(ctx);
  const appMetadata = await readGoTrueUserMetadata(ctx.apiUrl, userId, headers);
  const existingSupaoauth = isRecord(appMetadata.supaoauth) ? appMetadata.supaoauth : {};
  const nextSupaoauth = mergeRbacProjection(ref, existingSupaoauth, rbac, userId);
  const nextAppMetadata = { ...appMetadata, supaoauth: nextSupaoauth };
  await persistAndVerifyAppMetadata(ctx, userId, headers, nextAppMetadata);
}

async function markLockedUserProjectionUnavailable(
  ref: string,
  userId: string,
  rbac: ProjectRbacConfig,
  ctx: NonNullable<Awaited<ReturnType<typeof getGoTrueAdminContext>>>,
): Promise<void> {
  const headers = gotrueAdminHeaders(ctx);
  const appMetadata = await readGoTrueUserMetadata(ctx.apiUrl, userId, headers);
  const existingSupaoauth = isRecord(appMetadata.supaoauth) ? appMetadata.supaoauth : {};
  const existingProjects = isRecord(existingSupaoauth.projects) ? existingSupaoauth.projects : {};
  const existingProject = isRecord(existingProjects[ref]) ? existingProjects[ref] : {};
  const currentProjection = buildUserRbacProjection(rbac, userId, existingProject);
  const unavailableProjection = unavailableRbacProjection(
    currentProjection,
    rbac.version,
    RBAC_PROJECTION_LIMITS.projectBytes,
  );
  const nextSupaoauth = mergeProjectProjection(ref, existingSupaoauth, unavailableProjection);
  await persistAndVerifyAppMetadata(ctx, userId, headers, { ...appMetadata, supaoauth: nextSupaoauth });
}

async function withUserMetadataLock(
  ref: string,
  userId: string,
  operation: (ctx: NonNullable<Awaited<ReturnType<typeof getGoTrueAdminContext>>>) => Promise<void>,
): Promise<void> {
  const ctx = await getGoTrueAdminContext(ref);
  if (!ctx) throw Object.assign(new Error("Project service role key not found"), { statusCode: 404 });

  await sql.begin(async (transaction) => {
    const lockKey = `rbac-user-metadata:${ctx.authorityRef}:${userId}`;
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    await operation(ctx);
  });
}

async function syncUserMetadata(ref: string, userId: string): Promise<void> {
  await withUserMetadataLock(ref, userId, async (ctx) => {
    const project = await getProjectOrThrow(ref);
    const rbac = readRbacConfig(project.config);
    try {
      await syncLockedUserMetadata(ref, userId, rbac, ctx);
    } catch (syncError) {
      try {
        await markLockedUserProjectionUnavailable(ref, userId, rbac, ctx);
      } catch (compensationError) {
        throw new AggregateError(
          [syncError, compensationError],
          "RBAC metadata sync failed and unavailable compensation could not be verified",
        );
      }
      throw syncError;
    }
  });
}

async function markUserProjectionUnavailable(
  transaction: SQL,
  ref: string,
  userId: string,
  rbac: ProjectRbacConfig,
): Promise<void> {
  const ctx = await getGoTrueAdminContext(ref);
  if (!ctx) throw Object.assign(new Error("Project service role key not found"), { statusCode: 404 });
  const lockKey = `rbac-user-metadata:${ctx.authorityRef}:${userId}`;
  await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  await markLockedUserProjectionUnavailable(ref, userId, rbac, ctx);
}

async function markUsersProjectionUnavailable(
  transaction: SQL,
  ref: string,
  userIds: string[],
  rbac: ProjectRbacConfig,
): Promise<void> {
  for (const userId of uniqueSorted(userIds)) {
    await markUserProjectionUnavailable(transaction, ref, userId, rbac);
  }
}

async function syncUsersMetadata(ref: string, userIds: string[]): Promise<void> {
  for (const userId of uniqueSorted(userIds)) {
    await syncUserMetadata(ref, userId);
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

    return withProjectRbacConfigLock(ref, async (project, rbac, transaction) => {
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
      const saved = await saveRbacConfig(transaction, ref, project.config, { ...rbac, roles: [...rbac.roles, role] });
      return getRoleOrThrow(saved, role.id);
    });
  },

  async getRole(ref: string, roleId: string): Promise<ProjectRbacRole> {
    const project = await getProjectOrThrow(ref);
    return getRoleOrThrow(readRbacConfig(project.config), roleId);
  },

  async updateRole(ref: string, roleId: string, input: RoleUpdateInput): Promise<ProjectRbacRole> {
    const { updated, affectedUsers } = await withProjectRbacConfigLock(ref, async (project, rbac, transaction) => {
      const role = getRoleOrThrow(rbac, roleId);
      const nextName = input.name?.trim() || role.name;
      if (rbac.roles.some((item) => item.id !== roleId && item.name.toLowerCase() === nextName.toLowerCase())) {
        throw Object.assign(new Error("Role name already exists"), { statusCode: 409 });
      }
      const roles = rbac.roles.map((item) => item.id === roleId
        ? { ...item, name: nextName, description: input.description ?? item.description ?? null, updated_at: nowIso() }
        : item);
      const affectedUsers = affectedUserIds(rbac.assignments.filter((assignment) => assignment.role_id === roleId));
      await markUsersProjectionUnavailable(transaction, ref, affectedUsers, rbac);
      const saved = await saveRbacConfig(transaction, ref, project.config, { ...rbac, roles });
      return { updated: getRoleOrThrow(saved, roleId), affectedUsers };
    });
    await syncUsersMetadata(ref, affectedUsers);
    return updated;
  },

  async deleteRole(ref: string, roleId: string): Promise<void> {
    const removedAssignments = await withProjectRbacConfigLock(ref, async (project, rbac, transaction) => {
      getRoleOrThrow(rbac, roleId);
      const removedAssignments = rbac.assignments.filter((assignment) => assignment.role_id === roleId);
      await markUsersProjectionUnavailable(transaction, ref, affectedUserIds(removedAssignments), rbac);
      await saveRbacConfig(transaction, ref, project.config, {
        ...rbac,
        roles: rbac.roles.filter((role) => role.id !== roleId),
        assignments: rbac.assignments.filter((assignment) => assignment.role_id !== roleId),
      });
      return removedAssignments;
    });
    await syncUsersMetadata(ref, affectedUserIds(removedAssignments));
  },

  async listRolePermissions(ref: string, roleId: string): Promise<ProjectRbacPermission[]> {
    const project = await getProjectOrThrow(ref);
    return getRoleOrThrow(readRbacConfig(project.config), roleId).permissions;
  },

  async listRoleAssignments(ref: string, roleId: string): Promise<ProjectRbacAssignment[]> {
    const project = await getProjectOrThrow(ref);
    const rbac = readRbacConfig(project.config);
    getRoleOrThrow(rbac, roleId);
    return rbac.assignments.filter((assignment) => assignment.role_id === roleId);
  },

  async createPermission(ref: string, roleId: string, input: PermissionInput): Promise<ProjectRbacPermission> {
    const name = input.name?.trim();
    if (!name) throw Object.assign(new Error("name is required"), { statusCode: 400 });

    const { permission, saved } = await withProjectRbacConfigLock(ref, async (project, rbac, transaction) => {
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
      const saved = await saveRbacConfig(transaction, ref, project.config, { ...rbac, roles });
      return { permission, saved };
    });
    await syncUsersMetadata(ref, affectedUserIds(saved.assignments.filter((assignment) => assignment.role_id === roleId)));
    return getRoleOrThrow(saved, roleId).permissions.find((item) => item.id === permission.id) ?? permission;
  },

  async deletePermission(ref: string, roleId: string, permissionId: string): Promise<void> {
    const affectedUsers = await withProjectRbacConfigLock(ref, async (project, rbac, transaction) => {
      const role = getRoleOrThrow(rbac, roleId);
      if (!role.permissions.some((permission) => permission.id === permissionId)) {
        throw Object.assign(new Error("Permission not found"), { statusCode: 404 });
      }
      const roles = rbac.roles.map((item) => item.id === roleId
        ? { ...item, permissions: item.permissions.filter((permission) => permission.id !== permissionId), updated_at: nowIso() }
        : item);
      const affectedUsers = affectedUserIds(rbac.assignments.filter((assignment) => assignment.role_id === roleId));
      await markUsersProjectionUnavailable(transaction, ref, affectedUsers, rbac);
      await saveRbacConfig(transaction, ref, project.config, { ...rbac, roles });
      return affectedUsers;
    });
    await syncUsersMetadata(ref, affectedUsers);
  },

  async assignRole(ref: string, roleId: string, input: AssignRoleInput, actor: string): Promise<ProjectRbacAssignment> {
    const userId = input.user_id ?? input.userId ?? null;
    const organizationId = input.organization_id ?? input.organizationId ?? null;
    const applicationId = input.application_id ?? input.applicationId ?? null;
    await assertAssignmentTargets(ref, userId, applicationId, organizationId);

    const { assignment, assignmentChanged } = await withProjectRbacConfigLock(ref, async (project, rbac, transaction) => {
      getRoleOrThrow(rbac, roleId);
      const existing = rbac.assignments.find((assignment) =>
        assignment.role_id === roleId &&
        assignment.user_id === userId &&
        assignment.organization_id === organizationId &&
        assignment.application_id === applicationId
      );
      if (existing) return { assignment: existing, assignmentChanged: false };

      const assignment: ProjectRbacAssignment = {
        id: makeId("assign"),
        role_id: roleId,
        user_id: userId,
        organization_id: organizationId,
        application_id: applicationId,
        created_at: nowIso(),
      };
      const saved = await saveRbacConfig(transaction, ref, project.config, {
        ...rbac,
        assignments: [...rbac.assignments, assignment],
      });
      const savedAssignment = saved.assignments.find((item) => item.id === assignment.id) ?? assignment;
      await enqueueRoleAssignmentWebhook(transaction, {
        projectRef: ref,
        eventType: "role.assigned",
        assignment: savedAssignment,
        actor,
      });
      return { assignment: savedAssignment, assignmentChanged: true };
    });
    if (userId && assignmentChanged) await syncUserMetadata(ref, userId);
    return assignment;
  },

  async revokeRole(ref: string, roleId: string, assignmentId: string, actor: string): Promise<void> {
    const assignment = await withProjectRbacConfigLock(ref, async (project, rbac, transaction) => {
      getRoleOrThrow(rbac, roleId);
      const assignment = rbac.assignments.find((item) => item.id === assignmentId && item.role_id === roleId);
      if (!assignment) throw Object.assign(new Error("Assignment not found"), { statusCode: 404 });
      if (assignment.user_id) {
        await markUserProjectionUnavailable(transaction, ref, assignment.user_id, rbac);
      }
      await saveRbacConfig(transaction, ref, project.config, {
        ...rbac,
        assignments: rbac.assignments.filter((item) => item.id !== assignmentId),
      });
      await enqueueRoleAssignmentWebhook(transaction, {
        projectRef: ref,
        eventType: "role.revoked",
        assignment,
        actor,
      });
      return assignment;
    });
    if (assignment.user_id) await syncUserMetadata(ref, assignment.user_id);
  },

  async listUserRoleAssignments(
    ref: string,
    userId: string,
    applicationId?: string | null,
  ): Promise<Array<ProjectRbacAssignment & { role?: ProjectRbacRole }>> {
    const project = await getProjectOrThrow(ref);
    const rbac = readRbacConfig(project.config);
    const rolesById = new Map(rbac.roles.map((role) => [role.id, role]));
    return rbac.assignments
      .filter((assignment) =>
        assignment.user_id === userId
        && assignmentScopeMatches(assignment.application_id, applicationId),
      )
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

  async listApplicationRoleAssignments(ref: string, applicationId: string): Promise<Array<ProjectRbacAssignment & { role?: ProjectRbacRole }>> {
    const project = await getProjectOrThrow(ref);
    const rbac = readRbacConfig(project.config);
    const rolesById = new Map(rbac.roles.map((role) => [role.id, role]));
    return rbac.assignments
      .filter((assignment) => assignment.application_id === applicationId)
      .map((assignment) => ({ ...assignment, role: rolesById.get(assignment.role_id) }));
  },

  async resolveUserPermissions(
    ref: string,
    userId: string,
    orgId?: string | null,
    applicationId?: string | null,
  ): Promise<ProjectRbacUserPermissions> {
    const project = await getProjectOrThrow(ref);
    return resolvePermissionsFromConfig(readRbacConfig(project.config), userId, orgId, applicationId);
  },
};
