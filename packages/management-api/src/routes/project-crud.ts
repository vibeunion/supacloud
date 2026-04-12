/**
 * Project CRUD Routes
 * Handles: list, create, get details, update, delete, pause, restore
 */
import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import { projectService } from "../services";
import { getProjectDb } from "../db";

// Available regions list
const AVAILABLE_REGIONS = [
  { code: "local", name: "Local", continent: "local" },
  { code: "us-east-1", name: "US East (N. Virginia)", continent: "americas" },
  { code: "us-west-1", name: "US West (N. California)", continent: "americas" },
  { code: "eu-west-1", name: "EU (Ireland)", continent: "emea" },
  { code: "ap-southeast-1", name: "Asia Pacific (Singapore)", continent: "apac" },
];

export const projectCrudRoutes = new Elysia({ prefix: "/v1/projects" })
  // Get available regions
  .get("/available-regions", () => {
    return AVAILABLE_REGIONS;
  })

  // Get all projects
  .get("/", async () => {
    const projects = await projectService.listProjects();
    return projects.map(p => ({
      id: p.id,
      ref: p.ref,
      name: p.name,
      status: p.status?.toUpperCase() || "ACTIVE",
      region: p.region || "local",
      organization_id: p.organization_id || "default",
      created_at: p.created_at,
      updated_at: p.updated_at
    }));
  })
  .get("", async () => {
    const projects = await projectService.listProjects();
    return projects.map(p => ({
      id: p.id,
      ref: p.ref,
      name: p.name,
      status: p.status?.toUpperCase() || "ACTIVE",
      region: p.region || "local",
      organization_id: p.organization_id || "default",
      created_at: p.created_at,
      updated_at: p.updated_at
    }));
  })

  // Create new project
  .post(
    "/",
    async ({ body, set }) => {
      const project = await projectService.createProject(body);
      set.status = 201;
      return project;
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        region: t.Optional(t.String()),
        organization_id: t.Optional(t.String()),
        domain: t.Optional(t.String({ description: "Base custom domain (e.g., 'aorist.cn'). Auto generates api.X / studio.X" })),
        api_domain: t.Optional(t.String({ description: "Explicit API domain (e.g., 'xg-api.example.com')" })),
        studio_domain: t.Optional(t.String({ description: "Explicit Studio domain (e.g., 'xg-studio.example.com')" })),
      }),
    }
  )

  // Get project details (Studio-compatible format)
  .get(
    "/:ref",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) {
                return status(404, { error: "Project not found" });
      }

      // Get real database version and connection count
      let dbVersion = "15.0";
      let dbSize = 0;
      let connectionCount = 0;
      try {
        const projectDb = getProjectDb(project.database?.name || `supa_${project.ref}`);
        const versionResult = await projectDb`SHOW server_version`;
        if (versionResult[0]?.server_version) {
          dbVersion = versionResult[0].server_version.split(" ")[0];
        }
        const sizeResult = await projectDb`SELECT pg_database_size(current_database()) as size`;
        dbSize = sizeResult[0]?.size || 0;
        const connectionResult = await projectDb`SELECT count(*) as count FROM pg_stat_activity WHERE state = 'active'`;
        connectionCount = connectionResult[0]?.count || 0;
      } catch (e: unknown) {
        // Ignore database errors
      }

      // Check service statuses using systemd
      const checkServiceStatus = async (serviceName: string): Promise<string> => {
        try {
          const result = await Bun.$`systemctl is-active ${serviceName} 2>/dev/null || echo "inactive"`.quiet();
          const status = result.text().trim();
          return status === "active" ? "ACTIVE_HEALTHY" : "INACTIVE";
        } catch (err: unknown) {
          logger.warn("[Projects] Failed to check service status", { error: err });
          return "INACTIVE";
        }
      };

      const ref = project.ref;
      const serviceStatuses = await Promise.all([
        checkServiceStatus("patroni").then(s => ({ id: "postgresql", name: "PostgreSQL", status: s, healthy: s === "ACTIVE_HEALTHY" })),
        checkServiceStatus(`supacloud-pgrst@${ref}`).then(s => ({ id: "postgrest", name: "PostgREST", status: s, healthy: s === "ACTIVE_HEALTHY" })),
        checkServiceStatus(`supacloud-gotrue@${ref}`).then(s => ({ id: "gotrue", name: "GoTrue", status: s, healthy: s === "ACTIVE_HEALTHY" })),
        checkServiceStatus(`supacloud-realtime@${ref}`).then(s => ({ id: "realtime", name: "Realtime", status: s, healthy: s === "ACTIVE_HEALTHY" })).catch(() => ({ id: "realtime", name: "Realtime", status: "INACTIVE", healthy: false })),
        checkServiceStatus(`supacloud-storage@${ref}`).then(s => ({ id: "storage", name: "Storage", status: s, healthy: s === "ACTIVE_HEALTHY" })).catch(() => ({ id: "storage", name: "Storage", status: "INACTIVE", healthy: false })),
        checkServiceStatus("kong").then(s => ({ id: "kong", name: "Kong", status: s, healthy: s === "ACTIVE_HEALTHY" })).catch(() => ({ id: "kong", name: "Kong", status: "INACTIVE", healthy: false })),
      ]);

      return {
        id: project.id,
        ref: project.ref,
        name: project.name,
        status: project.status?.toUpperCase() || "ACTIVE_HEALTHY",
        region: project.region || "local",
        organization_id: (project as unknown as Record<string, unknown>).organization_id || "default",
        cloud_provider: (project as unknown as Record<string, unknown>).cloud_provider || "localhost",
        created_at: project.created_at,
        updated_at: project.updated_at,
        inserted_at: project.created_at,
        pause_status: project.status === 'paused' ? 'paused' : undefined,
        preview_branch_refs: [],
        database: {
          identifier: project.database?.name || `supa_${project.ref}`,
          host: project.database?.host || "localhost",
          port: (project.database as unknown as Record<string, unknown>)?.port || 5432,
          version: dbVersion,
          postgres_engine: dbVersion.split(".")[0] + "." + dbVersion.split(".")[1],
          release_channel: "stable",
          size: dbSize,
          connection_count: connectionCount,
        },
        db_port: (project.database as unknown as Record<string, unknown>)?.port || 5432,
        db_host: project.database?.host || "localhost",
        db_name: project.database?.name || `supa_${project.ref}`,
        db_user: "postgres",
        connectionString: `postgresql://postgres:[YOUR-PASSWORD]@${project.database?.host || 'localhost'}:${(project.database as unknown as Record<string, unknown>)?.port || 5432}/${project.database?.name || `supa_${project.ref}`}`,
        services: serviceStatuses,
        endpoint: project.api?.url || `https://${project.ref}.localhost`,
        anon_key: project.anon_key,
        service_key: project.service_key,
        jwt_secret: project.jwt_secret,
        api: project.api,
        studio: project.studio,
        config: project.config,
      };
    },
    {
      params: t.Object({
        ref: t.String({ minLength: 1 }),
      }),
    }
  )

  // Update project (PATCH)
  .patch(
    "/:ref",
    async ({ params, body, set }) => {
      const updated = await projectService.updateProject(params.ref, body);
      if (!updated) {
                return status(404, { error: "Project not found" });
      }
      return { ref: params.ref };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
      }),
    }
  )

  // Delete project
  .delete(
    "/:ref",
    async ({ params, set }) => {
      const deleted = await projectService.deleteProject(params.ref);
      if (!deleted) {
                return status(404, { error: "Project not found" });
      }
      return { ref: params.ref };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Pause project
  .post(
    "/:ref/pause",
    async ({ params, set }) => {
      const paused = await projectService.pauseProject(params.ref);
      if (!paused) {
                return status(404, { error: "Project not found" });
      }
      return { ref: params.ref, status: "paused" };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Restore project
  .post(
    "/:ref/restore",
    async ({ params, set }) => {
      const restored = await projectService.restoreProject(params.ref);
      if (!restored) {
                return status(404, { error: "Project not found" });
      }
      return { ref: params.ref, status: "active" };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Preview Branches — stub endpoints (Studio compatibility)
  .get(
    "/:ref/branches",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { error: "Project not found" });
      return [];
    },
    { params: t.Object({ ref: t.String() }) }
  )
  .post(
    "/:ref/branches",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { error: "Project not found" });
      set.status = 501;
      return { error: "Preview Branches are not supported on this SupaCloud cluster" };
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Read Replicas — stub endpoints (Studio compatibility)
  .get(
    "/:ref/read-replicas",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { error: "Project not found" });
      return [];
    },
    { params: t.Object({ ref: t.String() }) }
  )
  .post(
    "/:ref/read-replicas",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { error: "Project not found" });
      set.status = 501;
      return { error: "Read Replicas are not supported on this SupaCloud cluster" };
    },
    { params: t.Object({ ref: t.String() }) }
  )
  .delete(
    "/:ref/read-replicas/:id",
    async ({ params, set }) => {
      set.status = 501;
      return { error: "Read Replicas are not supported on this SupaCloud cluster" };
    },
    { params: t.Object({ ref: t.String(), id: t.String() }) }
  );
