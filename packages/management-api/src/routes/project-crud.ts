/**
 * Project CRUD Routes
 * Handles: list, create, get details, update, delete, pause, restore
 */
import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import { projectService } from "../services";
import { getProjectDb, resolveDbName, resolveRoleName } from "../db";

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
    cloud_provider:
      (project as Record<string, unknown>).cloud_provider || "localhost",
    created_at: project.created_at,
    updated_at: project.updated_at,
    inserted_at: project.created_at,
    pause_status: project.status === "paused" ? "paused" : null,
    preview_branch_refs: [],
    database: {
      host: project.database?.host || "localhost",
      version: "15", // default, overridden in detailed=true
      postgres_engine: "15", // default, overridden in detailed=true
      release_channel: "stable", // always stable
      identifier: ref, // project ref as DB identifier
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

  const checkServiceStatus = async (serviceName: string): Promise<string> => {
    try {
      const result =
        await Bun.$`systemctl is-active ${serviceName} 2>/dev/null || echo "inactive"`.quiet();
      const s = result.text().trim();
      return s === "active" ? "ACTIVE_HEALTHY" : "INACTIVE";
    } catch {
      return "INACTIVE";
    }
  };

  const serviceStatuses = await Promise.all([
    checkServiceStatus("patroni").then((s) => ({
      id: "postgresql",
      name: "PostgreSQL",
      status: s,
      healthy: s === "ACTIVE_HEALTHY",
    })),
    checkServiceStatus(`supacloud-pgrst@${ref}`).then((s) => ({
      id: "postgrest",
      name: "PostgREST",
      status: s,
      healthy: s === "ACTIVE_HEALTHY",
    })),
    checkServiceStatus(`supacloud-gotrue@${ref}`).then((s) => ({
      id: "gotrue",
      name: "GoTrue",
      status: s,
      healthy: s === "ACTIVE_HEALTHY",
    })),
    checkServiceStatus(`supacloud-realtime@${ref}`)
      .then((s) => ({
        id: "realtime",
        name: "Realtime",
        status: s,
        healthy: s === "ACTIVE_HEALTHY",
      }))
      .catch(() => ({
        id: "realtime",
        name: "Realtime",
        status: "INACTIVE",
        healthy: false,
      })),
    checkServiceStatus(`supacloud-storage@${ref}`)
      .then((s) => ({
        id: "storage",
        name: "Storage",
        status: s,
        healthy: s === "ACTIVE_HEALTHY",
      }))
      .catch(() => ({
        id: "storage",
        name: "Storage",
        status: "INACTIVE",
        healthy: false,
      })),
    checkServiceStatus("kong")
      .then((s) => ({
        id: "kong",
        name: "Kong",
        status: s,
        healthy: s === "ACTIVE_HEALTHY",
      }))
      .catch(() => ({
        id: "kong",
        name: "Kong",
        status: "INACTIVE",
        healthy: false,
      })),
  ]);

  return {
    ...base,
    database: {
      host: project.database?.host || "localhost",
      port: (project.database as Record<string, unknown>)?.port || 5432,
      version: dbVersion,
      postgres_engine: dbVersion.split(".")[0], // just major version "15" not "15.6"
      release_channel: "stable",
      identifier: ref, // project ref as DB identifier
      size: dbSize,
      connection_count: connectionCount,
    },
    db_port: (project.database as Record<string, unknown>)?.port || 5432,
    db_host: project.database?.host || "localhost",
    db_name: dbName,
    db_user: dbUser,
    connectionString: `postgresql://${dbUser}:[YOUR-PASSWORD]@${project.database?.host || "localhost"}:${(project.database as Record<string, unknown>)?.port || 5432}/${dbName}`,
    services: serviceStatuses,
    anon_key: project.anon_key,
    service_role_key: project.service_role_key,
    jwt_secret: project.jwt_secret,
    api: project.api,
    studio: project.studio,
    config: project.config,
  };
}

export const projectCrudRoutes = new Elysia({ prefix: "/v1/projects" })
  // Get available regions
  .get("/available-regions", () => {
    return AVAILABLE_REGIONS;
  })

  // Get all projects
  .get("/", async () => {
    const projects = await projectService.listProjects();
    return Promise.all(projects.map((p) => buildProjectResponse(p, false)));
  })
  .get("", async () => {
    const projects = await projectService.listProjects();
    return Promise.all(projects.map((p) => buildProjectResponse(p, false)));
  })

  // Create new project
  .post(
    "/",
    async ({ body, set }) => {
      const project = await projectService.createProject(body);
      set.status = 201;
      const fullProject = await projectService.getProject(project.ref);
      if (fullProject) {
        return await buildProjectResponse(fullProject, true);
      }
      return project;
    },
    {
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
        studio_domain: t.Optional(
          t.String({
            description:
              "Explicit Studio domain (e.g., 'xg-studio.example.com')",
          }),
        ),
      }),
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

      return await buildProjectResponse(project, true);
    },
    {
      params: t.Object({
        ref: t.String({ minLength: 1 }),
      }),
    },
  )

  // Update project (PATCH)
  .patch(
    "/:ref",
    async ({ params, body, set }) => {
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
    },
  )

  // Delete project
  .delete(
    "/:ref",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found", code: "404" });
      }
      const deleted = await projectService.deleteProject(params.ref);
      if (!deleted) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return await buildProjectResponse(project, true);
    },
    { params: t.Object({ ref: t.String() }) },
  )

  // Pause project
  .post(
    "/:ref/pause",
    async ({ params, set }) => {
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
    { params: t.Object({ ref: t.String() }) },
  )

  .post(
    "/:ref/restore",
    async ({ params, set }) => {
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
    { params: t.Object({ ref: t.String() }) },
  )

  // Preview Branches — stub endpoints (Studio compatibility)
  .get(
    "/:ref/branches",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      return [];
    },
    { params: t.Object({ ref: t.String() }) },
  )
  .post(
    "/:ref/branches",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      set.status = 501;
      return {
        message: "Preview Branches are not supported on this SupaCloud cluster",
        code: "501",
      };
    },
    { params: t.Object({ ref: t.String() }) },
  )

  // Read Replicas — stub endpoints (Studio compatibility)
  .get(
    "/:ref/read-replicas",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      return [];
    },
    { params: t.Object({ ref: t.String() }) },
  )
  .post(
    "/:ref/read-replicas",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      set.status = 501;
      return {
        message: "Read Replicas are not supported on this SupaCloud cluster",
        code: "501",
      };
    },
    { params: t.Object({ ref: t.String() }) },
  )
  .delete(
    "/:ref/read-replicas/:id",
    async ({ params, set }) => {
      set.status = 501;
      return {
        message: "Read Replicas are not supported on this SupaCloud cluster",
        code: "501",
      };
    },
    { params: t.Object({ ref: t.String(), id: t.String() }) },
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
    { params: t.Object({ ref: t.String() }) },
  )

  // ── Vanity Subdomains (/vanity-subdomains plural — official Supabase API path) ──────────
  // Store vanity_subdomain in project config; sets up a custom URL alias for the project.

  // GET — return current vanity subdomain config
  .get(
    "/:ref/vanity-subdomains",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found" });
      const cfg = (project.config as Record<string, unknown>) || {};
      const vanity = (cfg.vanity_subdomain as string | null) || null;
      if (!vanity) {
        return { status: "not-used" };
      }
      return {
        status: "active",
        custom_domain: `${vanity}.${process.env.BASE_DOMAIN || "localhost"}`,
      };
    },
    { params: t.Object({ ref: t.String() }) },
  )

  // POST check-availability — verify a subdomain is not taken
  .post(
    "/:ref/vanity-subdomains/check-availability",
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
    },
  )

  // POST activate — set the vanity subdomain
  .post(
    "/:ref/vanity-subdomains",
    async ({ params, body }) => {
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
      const currentCfg = (project.config as Record<string, unknown>) || {};
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
    },
  )

  // DELETE — remove vanity subdomain
  .delete(
    "/:ref/vanity-subdomains",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found" });
      const currentCfg = (project.config as Record<string, unknown>) || {};
      const updated = { ...currentCfg };
      delete updated.vanity_subdomain;
      await projectService.updateProjectSettings(params.ref, updated);
      return { custom_domain: null, vanity_subdomain: null };
    },
    { params: t.Object({ ref: t.String() }) },
  )

  // Legacy aliases — keep singular forms for backward compatibility
  .get(
    "/:ref/vanity-subdomain",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found" });
      const cfg = (project.config as Record<string, unknown>) || {};
      return {
        vanity_subdomain: (cfg.vanity_subdomain as string | null) || null,
      };
    },
    { params: t.Object({ ref: t.String() }) },
  )
  .post(
    "/:ref/vanity-subdomains/activate",
    async ({ params, body }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found" });
      const requested = (body as Record<string, string>).vanity_subdomain || "";
      if (!requested || !/^[a-z0-9-]{3,63}$/.test(requested)) {
        return status(400, {
          message: "Invalid subdomain (lowercase alphanumeric + hyphens, 3-63 chars)",
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
      const currentCfg = (project.config as Record<string, unknown>) || {};
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
    },
  )

  // SSL Encryption — stub endpoint (Studio compatibility)
  .get(
    "/:ref/ssl-encryption",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      return { is_ssl_enabled: true };
    },
    { params: t.Object({ ref: t.String() }) },
  )

  // Database Reset — stub endpoint (Studio compatibility)
  .post(
    "/:ref/database/reset",
    async ({ params, set }) => {
      set.status = 501;
      return {
        message: "Database reset is not supported on this SupaCloud cluster",
        code: "501",
      };
    },
    { params: t.Object({ ref: t.String() }) },
  )

  // Postgres Upgrade — stub endpoints (Studio compatibility)
  .post(
    "/:ref/upgrade",
    async ({ params, set }) => {
      set.status = 501;
      return {
        message: "Postgres upgrade is not supported on this SupaCloud cluster",
        code: "501",
      };
    },
    { params: t.Object({ ref: t.String() }) },
  )
  .get(
    "/:ref/upgrade-status",
    async ({ params }) => {
      return { upgrade_status: "none" };
    },
    { params: t.Object({ ref: t.String() }) },
  )

  // Auth Email Templates — stub endpoint (Studio compatibility)
  .get(
    "/:ref/auth/template",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      return {
        confirmation_mail: { subject: "Confirm your signup", content: "" },
        invitation_mail: { subject: "You have been invited", content: "" },
        recovery_mail: { subject: "Reset your password", content: "" },
        email_change: { subject: "Confirm email change", content: "" },
        magic_link: { subject: "Your magic link", content: "" },
      };
    },
    { params: t.Object({ ref: t.String() }) },
  )
  .put(
    "/:ref/auth/template",
    async ({ params, body, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      set.status = 501;
      return {
        message:
          "Auth email templates are not configurable on this SupaCloud cluster",
        code: "501",
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
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
    { params: t.Object({ ref: t.String() }) },
  )
  .patch(
    "/:ref/postgrest",
    async ({ params, body }) => {
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
    },
  )

  // PITR — stub endpoint (Studio compatibility)
  .get(
    "/:ref/database/backups/pitr",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project)
        return status(404, { message: "Project not found", code: "404" });
      return {
        available: false,
        earliest_physical_backup_date: null,
        latest_physical_backup_date: null,
      };
    },
    { params: t.Object({ ref: t.String() }) },
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
    { params: t.Object({ ref: t.String() }) },
  );
