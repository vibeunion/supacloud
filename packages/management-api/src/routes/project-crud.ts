/**
 * Project CRUD Routes
 * Handles: list, create, get details, update, delete, pause, restore
 */
import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import { projectService } from "../services";
import { getProjectDb, resolveDbName, resolveRoleName } from "../db";
import { normalizeProjectConfig } from "../utils/project-config";
import { getAuthContext, requireAdminAuth, requireProjectOrAdminAuth } from "../middleware/auth";
import { tenantRuntimeService } from "../services/tenant-runtime.service";
import {
  getAuthRuntimeManagedError,
  getAuthRuntimeOwnerProtectionError,
} from "../services/auth-runtime.service";
import { ScalingService } from "../services/scaling.service";
import { getPgBackRestStanza, isPitrEnabled, listBackups, PgBackRestUnavailableError } from "../services/backup.service";
import {
  PostgresMajorUpgradeError,
  postgresMajorUpgradeService,
} from "../services/postgres-major-upgrade.service";
import type { BackupInfo } from "../types/backup";
import {
  applyAuthEmailTemplatePatch,
  buildLegacyAuthEmailTemplateResponse,
  clearAuthEmailTemplates,
  getAuthEmailTemplates,
  parseAuthEmailTemplatePatch,
} from "../utils/auth-email-templates";

// Available regions list
const AVAILABLE_REGIONS = [
  { code: "local", name: "Local", continent: "local" },
  { code: "us-east-1", name: "US East (N. Virginia)", continent: "americas" },
  { code: "us-west-1", name: "US West (N. California)", continent: "americas" },
  { code: "eu-west-1", name: "EU (Ireland)", continent: "emea" },
  {
    code: "ap-southeast-1",
    name: "Asia Pacific (Singapore)",
    continent: "apac",
  },
];

export const V1ProjectResponseSchema = t.Object(
  {
    id: t.String(),
    ref: t.String(),
    organization_id: t.String(),
    organization_slug: t.String(),
    name: t.String(),
    region: t.String(),
    created_at: t.String(),
    status: t.String(),
  },
  { additionalProperties: false },
);

export const V1ProjectWithDatabaseResponseSchema = t.Object(
  {
    id: t.String(),
    ref: t.String(),
    organization_id: t.String(),
    organization_slug: t.String(),
    name: t.String(),
    region: t.String(),
    created_at: t.String(),
    status: t.String(),
    database: t.Object(
      {
        host: t.String(),
        version: t.String(),
        postgres_engine: t.String(),
        release_channel: t.String(),
      },
      { additionalProperties: false },
    ),
    api: t.Optional(
      t.Object(
        {
          url: t.String(),
        },
        { additionalProperties: true },
      ),
    ),
    studio: t.Optional(
      t.Object(
        {
          url: t.String(),
        },
        { additionalProperties: true },
      ),
    ),
    config: t.Optional(t.Any()),
    anon_key: t.Optional(t.String()),
    services: t.Optional(t.Array(t.Any())),
  },
  { additionalProperties: true },
);

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  return new Date().toISOString();
}

export function toPublicV1ProjectResponse(p: any) {
  return {
    id: String(p.id),
    ref: p.ref,
    organization_id: p.organization_id || "default",
    organization_slug: p.organization_slug || p.organization_id || "default",
    name: p.name,
    region: p.region || "local",
    created_at: normalizeTimestamp(p.created_at),
    status: mapStatus(p.status),
  };
}

export function toPublicV1ProjectWithDatabaseResponse(p: any) {
  return {
    ...toPublicV1ProjectResponse(p),
    database: {
      host: p.database?.host || "localhost",
      version: p.database?.version || "15",
      postgres_engine: p.database?.postgres_engine || "15",
      release_channel: p.database?.release_channel || "stable",
    },
    api: p.api,
    studio: p.studio,
    config: p.config,
    anon_key: p.anon_key,
    services: p.services,
  };
}

function mapStatus(rawStatus: string | undefined): string {
  if (!rawStatus) return "ACTIVE_HEALTHY";
  const s = rawStatus.toLowerCase();
  if (s === "active") return "ACTIVE_HEALTHY";
  if (s === "active_healthy") return "ACTIVE_HEALTHY";
  if (s === "paused") return "INACTIVE";
  if (s === "inactive") return "INACTIVE";
  if (s === "creating") return "COMING_UP";
  if (s === "deleted") return "INACTIVE";
  return rawStatus.toUpperCase();
}

async function runPostgresUpgradeRoute<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PostgresMajorUpgradeError) {
      return status(error.statusCode as 400 | 404 | 409 | 503, {
        message: error.message,
        code: error.code,
      });
    }
    throw error;
  }
}

function normalizeBackupTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(millis).toISOString();
}

function buildPitrStatus(ref: string, stanza: string, backups: BackupInfo[]) {
  const dates = backups
    .flatMap((backup) => [
      normalizeBackupTimestamp(backup.timestamp?.start),
      normalizeBackupTimestamp(backup.timestamp?.stop),
    ])
    .filter((value): value is string => Boolean(value))
    .sort();
  const pitrEnabled = isPitrEnabled();
  const hasPhysicalBackups = dates.length > 0;
  const available = pitrEnabled && hasPhysicalBackups;

  return {
    available,
    capability: pitrEnabled,
    status: available
      ? "available"
      : pitrEnabled
        ? "no_physical_backups"
        : "unsupported",
    reason: available
      ? null
      : pitrEnabled
        ? "no_physical_backups"
        : "pitr_not_enabled",
    earliest_physical_backup_date: dates[0] ?? null,
    latest_physical_backup_date: dates.at(-1) ?? null,
    backups: {
      count: backups.length,
      stanza,
      scope: "cluster",
    },
    restore: {
      supported: available,
      method: "POST",
      endpoint: "/v1/platform/backups/restore",
      requires_admin: true,
      request_body: {
        target: "ISO-8601 timestamp",
        confirmation: "RESTORE_CLUSTER:<target>",
      },
    },
  };
}

async function buildProjectResponse(
  project: any,
  detailed = false,
): Promise<Record<string, unknown>> {
  const ref = project.ref;
  const dbName = await resolveDbName(ref);
  const dbUser = resolveRoleName(ref);

  const base: Record<string, unknown> = {
    id: project.id,
    ref: project.ref,
    name: project.name,
    status: mapStatus(project.status),
    region: project.region || "local",
    organization_id: project.organization_id || "default",
    organization_slug:
      (project as Record<string, unknown>).organization_slug ||
      project.organization_id ||
      "default",
    cloud_provider:
      (project as Record<string, unknown>).cloud_provider || "localhost",
    created_at: project.created_at,
    updated_at: project.updated_at,
    inserted_at: project.created_at,
    pause_status: project.status === "paused" ? "paused" : null,
    preview_branch_refs: [],
    database: {
      host: project.database?.host || "localhost",
      version: "15",
      postgres_engine: "15",
      release_channel: "stable",
    },
    endpoint: project.api?.url || `https://${ref}.localhost`,
  };

  if (!detailed) return base;

  let dbVersion = "15.0";
  let dbSize = 0;
  let connectionCount = 0;
  try {
    const projectDb = getProjectDb(dbName);
    const versionResult = await projectDb`SHOW server_version`;
    if (versionResult[0]?.server_version) {
      dbVersion = versionResult[0].server_version.split(" ")[0];
    }
    const sizeResult =
      await projectDb`SELECT pg_database_size(current_database()) as size`;
    dbSize = sizeResult[0]?.size || 0;
    const connectionResult =
      await projectDb`SELECT count(*) as count FROM pg_stat_activity WHERE state = 'active'`;
    connectionCount = connectionResult[0]?.count || 0;
  } catch {}

  const serviceStatuses = await tenantRuntimeService.getProjectServiceStatuses(ref, project.config, "detail");

  return {
    ...base,
    database: {
      host: project.database?.host || "localhost",
      port: (project.database as Record<string, unknown>)?.port || 5432,
      version: dbVersion,
      postgres_engine: dbVersion.split(".")[0],
      release_channel: "stable",
      size: dbSize,
      connection_count: connectionCount,
    },
    db_port: (project.database as Record<string, unknown>)?.port || 5432,
    db_host: project.database?.host || "localhost",
    db_name: dbName,
    db_user: dbUser,
    connection_string: `postgresql://${dbUser}:[YOUR-PASSWORD]@${project.database?.host || "localhost"}:${(project.database as Record<string, unknown>)?.port || 5432}/${dbName}`,
    services: serviceStatuses,
    anon_key: project.anon_key,
    api: project.api,
    studio: project.studio,
    config: normalizeProjectConfig(project.config),
  };
}

export const projectCrudRoutes = new Elysia({ prefix: "/v1/projects" })
  .onError(({ code, error, set }) => {
    logger.error(`[ProjectCRUD] Unhandled error [${code}]:`, error);
    if (code === "VALIDATION") {
      set.status = 400;
      return { message: "Validation failed", code: "VALIDATION_ERROR", details: error.message };
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { message: "Not found", code: "NOT_FOUND" };
    }
    const { toAppError } = require("../utils/errors") as typeof import("../utils/errors");
    const appError = toAppError(error);
    set.status = appError.statusCode;
    return appError.toJSON();
  })
  .get("/available-regions", () => {
    return AVAILABLE_REGIONS;
  },
  {
    detail: { tags: ["projects"], summary: "List available regions" },
  },
  )

  // Get all projects
  .get(
    "/",
    async ({ request }) => {
      const auth = await getAuthContext(request);
      if ("status" in auth) return status(auth.status as 401 | 403, { message: auth.body.error, code: String(auth.status) });
      const projects = auth.role === "project"
        ? [await projectService.getProject(auth.ref)].filter(Boolean)
        : await projectService.listProjects();
      const docs = await Promise.all(
        projects.map((p) => buildProjectResponse(p, false)),
      );
      return docs.map(toPublicV1ProjectResponse);
    },
    {
      response: {
        200: t.Array(V1ProjectResponseSchema),
        401: t.Object({ message: t.String(), code: t.String() }),
        403: t.Object({ message: t.String(), code: t.String() }),
      },
      detail: { tags: ["projects"], summary: "List projects" },
    },
  )
  .get(
    "",
    async ({ request }) => {
      const auth = await getAuthContext(request);
      if ("status" in auth) return status(auth.status as 401 | 403, { message: auth.body.error, code: String(auth.status) });
      const projects = auth.role === "project"
        ? [await projectService.getProject(auth.ref)].filter(Boolean)
        : await projectService.listProjects();
      const docs = await Promise.all(
        projects.map((p) => buildProjectResponse(p, false)),
      );
      return docs.map(toPublicV1ProjectResponse);
    },
    {
      response: {
        200: t.Array(V1ProjectResponseSchema),
        401: t.Object({ message: t.String(), code: t.String() }),
        403: t.Object({ message: t.String(), code: t.String() }),
      },
      detail: { tags: ["projects"], summary: "List projects" },
    },
  )

  // Create new project
  .post(
    "/",
    async ({ body, set, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

      const project = await projectService.createProject(body);
      set.status = 201;
      const fullProject = await projectService.getProject(project.ref);
      const raw = await buildProjectResponse(fullProject || project, true);
      return toPublicV1ProjectWithDatabaseResponse(raw);
    },
    {
      response: { 201: V1ProjectWithDatabaseResponseSchema },
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        region: t.Optional(t.String()),
        organization_id: t.Optional(t.String()),
        db_pass: t.Optional(t.String()),
        plan: t.Optional(t.String()),
        cloud_provider: t.Optional(t.String()),
        instance_size: t.Optional(t.String()),
        kubernetes_version: t.Optional(t.String()),
        domain: t.Optional(
          t.String({
            description:
              "Base custom domain (e.g., 'aorist.cn'). Auto generates api.X / studio.X",
          }),
        ),
        api_domain: t.Optional(
          t.String({
            description: "Explicit API domain (e.g., 'xg-api.example.com')",
          }),
        ),
        auth_domain: t.Optional(
          t.String({
            description: "Explicit Auth/OIDC domain (e.g., 'auth.example.com')",
          }),
        ),
        studio_domain: t.Optional(
          t.String({
            description:
              "Explicit Studio domain (e.g., 'xg-studio.example.com')",
          }),
        ),
      }),
      detail: { tags: ["projects"], summary: "Create project" },
    },
  )

  // Get project details (Studio-compatible format)
  .get(
    "/:ref",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const raw = await buildProjectResponse(project, true);
      return toPublicV1ProjectWithDatabaseResponse(raw);
    },
    {
      response: {
        200: V1ProjectWithDatabaseResponseSchema,
        404: t.Object({ message: t.String(), code: t.Optional(t.String()) }),
      },
      params: t.Object({
        ref: t.String({ minLength: 1 }),
      }),
      detail: { tags: ["projects"], summary: "Get project details" },
    },
  )
  .get(
    "/:ref/studio-metrics",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      const full = await buildProjectResponse(project, true);
      const { database, services, db_port, db_host, db_name, db_user, connection_string, anon_key, ...safe } = full;
      return {
        ...safe,
        database: database ? { version: (database as Record<string, unknown>).version, size: (database as Record<string, unknown>).size, connection_count: (database as Record<string, unknown>).connection_count } : undefined,
        services,
      };
    },
    {
      response: {
        200: t.Any(),
        404: t.Object({ message: t.String(), code: t.Optional(t.String()) }),
      },
      params: t.Object({
        ref: t.String({ minLength: 1 }),
      }),
      detail: { tags: ["projects"], summary: "Get project studio metrics" },
    },
  )

  // Update project (PATCH)
  .patch(
    "/:ref",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

      const updated = await projectService.updateProject(params.ref, body);
      if (!updated) {
        return status(404, { message: "Project not found", code: "404" });
      }
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return await buildProjectResponse(project, true);
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
      }),
      detail: { tags: ["projects"], summary: "Update project" },
    },
  )

  // Delete project
  .delete(
    "/:ref",
    async ({ params, set, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) {
        return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
      }
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found", code: "404" });
      }
      const ownerError = getAuthRuntimeOwnerProtectionError(params.ref, "delete");
      if (ownerError) return status(409, ownerError);
      const deleted = await projectService.deleteProject(params.ref);
      if (!deleted) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return await buildProjectResponse(project, true);
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Delete project" },
    },
  )

  // Pause project
  .post(
    "/:ref/pause",
    async ({ params, set, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) {
        return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
      }
      const ownerError = getAuthRuntimeOwnerProtectionError(params.ref, "pause");
      if (ownerError) return status(409, ownerError);
      const paused = await projectService.pauseProject(params.ref);
      if (!paused) {
        return status(404, { message: "Project not found", code: "404" });
      }
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return await buildProjectResponse(project, true);
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Pause project" },
    },
  )

  .post(
    "/:ref/restore",
    async ({ params, set, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) {
        return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
      }
      const restored = await projectService.restoreProject(params.ref);
      if (!restored) {
        return status(404, { message: "Project not found", code: "404" });
      }
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return await buildProjectResponse(project, true);
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Restore project" },
    },
  )

  // Read Replicas — Studio compatibility plus SupaCloud-managed metadata.
  .get(
    "/:ref/read-replicas",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      const state = await ScalingService.getScalingState(params.ref);
      return state?.read_replicas || [];
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "List read replicas" },
    },
  )
  .post(
    "/:ref/read-replicas",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      try {
        const replica = await ScalingService.horizontalScale(
          params.ref,
          body.replica_ip,
          body.region || "local",
        );
        return replica;
      } catch (error: unknown) {
        return status(500, {
          message: error instanceof Error ? error.message : String(error),
          code: "500",
        });
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        replica_ip: t.String({ minLength: 1 }),
        region: t.Optional(t.String()),
      }),
      detail: { tags: ["projects"], summary: "Create read replica" },
    },
  )
  .delete(
    "/:ref/read-replicas/:id",
    async ({ params, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      try {
        const replica = await ScalingService.removeReadReplica(params.ref, params.id);
        if (!replica) return status(404, { message: "Read replica not found", code: "404" });
        return replica;
      } catch (error: unknown) {
        return status(500, {
          message: error instanceof Error ? error.message : String(error),
          code: "500",
        });
      }
    },
    {
      params: t.Object({ ref: t.String(), id: t.String() }),
      detail: { tags: ["projects"], summary: "Delete read replica" },
    },
  )

  // Project endpoint info (Studio compatibility)
  .get(
    "/:ref/endpoint",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      const dbName = await resolveDbName(params.ref);
      const dbUser = resolveRoleName(params.ref);
      return {
        endpoint: project.api?.url || `https://${params.ref}.localhost`,
        auto_idle_disabled: false,
        connection_string: `postgresql://${dbUser}:[YOUR-PASSWORD]@${project.database?.host || "localhost"}:5432/${dbName}`,
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get project endpoint info" },
    },
  )

  // ── Vanity Subdomains (/vanity-subdomain singular (official path)) ──────────
  // Store vanity_subdomain in project config; sets up a custom URL alias for the project.

  // GET — return current vanity subdomain config
  .get(
    "/:ref/vanity-subdomain",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found" });
      const cfg = normalizeProjectConfig(project.config);
      const vanity = (cfg.vanity_subdomain as string | null) || null;
      if (!vanity) {
        return { status: "not-used" };
      }
      return {
        status: "active",
        custom_domain: `${vanity}.${process.env.BASE_DOMAIN || "localhost"}`,
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get vanity subdomain config" },
    },
  )

  // POST check-availability — verify a subdomain is not taken
  .post(
    "/:ref/vanity-subdomain/check-availability",
    async ({ params, body }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found" });
      const requested = (body as Record<string, string>).vanity_subdomain || "";
      if (!requested || !/^[a-z0-9-]{3,63}$/.test(requested)) {
        return {
          available: false,
          error:
            "Invalid subdomain format (lowercase alphanumeric + hyphens, 3-63 chars)",
        };
      }
      // Check if any OTHER project already uses this vanity subdomain
      const { sql } = await import("../db");
      const rows = await sql`
        SELECT ref FROM projects
        WHERE config->>'vanity_subdomain' = ${requested}
          AND ref != ${params.ref}
        LIMIT 1
      `;
      return { available: rows.length === 0 };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({ vanity_subdomain: t.String() }),
      detail: { tags: ["projects"], summary: "Check vanity subdomain availability" },
    },
  )

  // POST activate — set the vanity subdomain
  .post(
    "/:ref/vanity-subdomain/activate",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found" });
      const requested = (body as Record<string, string>).vanity_subdomain || "";
      if (!requested || !/^[a-z0-9-]{3,63}$/.test(requested)) {
        return status(400, {
          message:
            "Invalid subdomain (lowercase alphanumeric + hyphens, 3-63 chars)",
        });
      }
      // Check availability
      const { sql } = await import("../db");
      const conflict = await sql`
        SELECT ref FROM projects
        WHERE config->>'vanity_subdomain' = ${requested}
          AND ref != ${params.ref}
        LIMIT 1
      `;
      if (conflict.length > 0) {
        return status(409, {
          message: `Vanity subdomain '${requested}' is already in use`,
        });
      }
      // Store in project config
      const currentCfg = normalizeProjectConfig(project.config);
      await projectService.updateProjectSettings(params.ref, {
        ...currentCfg,
        vanity_subdomain: requested,
      });
      const domain = process.env.BASE_DOMAIN || "localhost";
      return {
        custom_domain: `${requested}.${domain}`,
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({ vanity_subdomain: t.String() }),
      detail: { tags: ["projects"], summary: "Activate vanity subdomain" },
    },
  )

  // DELETE — remove vanity subdomain
  .delete(
    "/:ref/vanity-subdomain",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found" });
      const currentCfg = normalizeProjectConfig(project.config);
      const updated = { ...currentCfg };
      delete updated.vanity_subdomain;
      await projectService.updateProjectSettings(params.ref, updated);
      return { custom_domain: null, vanity_subdomain: null };
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Remove vanity subdomain" },
    },
  )

  // Postgres Upgrade — explicit capability endpoint
  .post(
    "/:ref/upgrade",
    async ({ params, request, body, set }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      const result = await runPostgresUpgradeRoute(() => postgresMajorUpgradeService.request(params.ref, body.target_version));
      set.status = 202;
      return result;
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({ target_version: t.Union([t.String(), t.Number()]) }),
      detail: { tags: ["projects"], summary: "Upgrade Postgres version" },
    },
  )
  .post(
    "/:ref/upgrade/:upgradeId/approve",
    async ({ params, request, body, set }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found", code: "404" });
      set.status = 202;
      return runPostgresUpgradeRoute(() => postgresMajorUpgradeService.approve(params.upgradeId, body.confirmation, params.ref));
    },
    {
      params: t.Object({ ref: t.String(), upgradeId: t.String() }),
      body: t.Object({ confirmation: t.String({ minLength: 20, maxLength: 200 }) }),
      detail: { tags: ["projects"], summary: "Approve and start a PostgreSQL major upgrade" },
    },
  )
  .post(
    "/:ref/upgrade/:upgradeId/rollback",
    async ({ params, request, body, set }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found", code: "404" });
      set.status = 202;
      return runPostgresUpgradeRoute(() => postgresMajorUpgradeService.rollback(params.upgradeId, body.confirmation, params.ref));
    },
    {
      params: t.Object({ ref: t.String(), upgradeId: t.String() }),
      body: t.Object({ confirmation: t.String({ minLength: 20, maxLength: 200 }) }),
      detail: { tags: ["projects"], summary: "Rollback a PostgreSQL major upgrade" },
    },
  )
  .get(
    "/:ref/upgrade-status",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      return runPostgresUpgradeRoute(() => postgresMajorUpgradeService.get(params.ref));
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get Postgres upgrade status" },
    },
  )

  // Auth Email Templates
  .get(
    "/:ref/auth/template",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
      const managedError = getAuthRuntimeManagedError(params.ref, "email_templates");
      if (managedError) return status(409, managedError);

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      const templates = getAuthEmailTemplates((settings.auth as Record<string, unknown>) || {});
      return {
        capability: true,
        templates,
        variables: [".ConfirmationURL", ".Token", ".SiteURL", ".Email"],
        ...buildLegacyAuthEmailTemplateResponse(templates),
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get auth email templates" },
    },
  )
  .put(
    "/:ref/auth/template",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
      const managedError = getAuthRuntimeManagedError(params.ref, "email_templates");
      if (managedError) return status(409, managedError);

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      const patch = parseAuthEmailTemplatePatch(body);
      if (Object.keys(patch).length === 0) {
        return status(400, { message: "No email templates provided", code: "400" });
      }
      const hasBlankSubject = Object.values(patch).some(
        (template) => template?.subject !== undefined && !template.subject.trim(),
      );
      if (hasBlankSubject) {
        return status(400, { message: "Email template subject is required", code: "AUTH_TEMPLATE_SUBJECT_REQUIRED" });
      }

      const currentAuth = (settings.auth as Record<string, unknown>) || {};
      const nextAuth = applyAuthEmailTemplatePatch(currentAuth, patch);
      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: nextAuth,
      });

      let warning: string | null = null;
      try {
        await tenantRuntimeService.restartRuntime(params.ref);
      } catch (err) {
        warning = "Saved templates, but failed to restart GoTrue runtime. The templates will apply on the next runtime restart.";
        logger.warn("[project-crud] Failed to restart runtime after auth template update", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const templates = getAuthEmailTemplates(nextAuth);
      return {
        saved: true,
        templates,
        ...(warning ? { warning } : {}),
        ...buildLegacyAuthEmailTemplateResponse(templates),
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
      detail: { tags: ["projects"], summary: "Update auth email templates" },
    },
  )
  .delete(
    "/:ref/auth/template",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
      const managedError = getAuthRuntimeManagedError(params.ref, "email_templates");
      if (managedError) return status(409, managedError);

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      const currentAuth = (settings.auth as Record<string, unknown>) || {};
      const nextAuth = clearAuthEmailTemplates(currentAuth);
      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: nextAuth,
      });

      let warning: string | null = null;
      try {
        await tenantRuntimeService.restartRuntime(params.ref);
      } catch (err) {
        warning = "Cleared templates, but failed to restart GoTrue runtime. The defaults will apply on the next runtime restart.";
        logger.warn("[project-crud] Failed to restart runtime after auth template reset", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const templates = getAuthEmailTemplates(nextAuth);
      return {
        reset: true,
        templates,
        ...(warning ? { warning } : {}),
        ...buildLegacyAuthEmailTemplateResponse(templates),
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Reset auth email templates" },
    },
  )

  // PostgREST config — alias without /config/ prefix (Studio compatibility)
  .get(
    "/:ref/postgrest",
    async ({ params }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      return (settings as Record<string, unknown>).postgrest || {};
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get PostgREST config" },
    },
  )
  .patch(
    "/:ref/postgrest",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings)
        return status(404, { message: "Project not found", code: "404" });
      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        postgrest: {
          ...(((settings as Record<string, unknown>).postgrest as Record<
            string,
            unknown
          >) || {}),
          ...body,
        },
      });
      return (updated as Record<string, unknown>)?.postgrest || {};
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
      detail: { tags: ["projects"], summary: "Update PostgREST config" },
    },
  )

  // PITR — capability/status endpoint backed by physical backup inventory
  .get(
    "/:ref/database/backups/pitr",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      const dbName = await resolveDbName(params.ref);
      try {
        const backups = await listBackups(dbName);
        return buildPitrStatus(params.ref, getPgBackRestStanza(), backups);
      } catch (error) {
        if (error instanceof PgBackRestUnavailableError) {
          return status(503, { message: "pgBackRest backup inventory is unavailable", code: "BACKUP_UNAVAILABLE" });
        }
        throw error;
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get PITR backup status" },
    },
  )

  // Enforced project settings — stub endpoint (Studio compatibility)
  .get(
    "/:ref/enforced",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      return {};
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get enforced project settings" },
    },
  );
