import { Elysia, t } from "elysia";
import { projectService } from "../services";
import { gatewayService } from "../services/gateway.service";
import { db, getProjectDb } from "../db";

// Available regions list
const AVAILABLE_REGIONS = [
  { code: "local", name: "Local", continent: "local" },
  { code: "us-east-1", name: "US East (N. Virginia)", continent: "americas" },
  { code: "us-west-1", name: "US West (N. California)", continent: "americas" },
  { code: "eu-west-1", name: "EU (Ireland)", continent: "emea" },
  { code: "ap-southeast-1", name: "Asia Pacific (Singapore)", continent: "apac" },
];

export const projectRoutes = new Elysia({ prefix: "/v1/projects" })
  // Get available regions
  .get("/available-regions", () => {
    return AVAILABLE_REGIONS;
  })

  // Get all projects
  .get("/", async () => {
    const projects = await projectService.listProjects();
    return projects;
  })
  .get("", async () => {
    const projects = await projectService.listProjects();
    return projects;
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
        domain: t.Optional(t.String({ description: "Custom domain for the project (e.g., 'aorist.cn')" })),
      }),
    }
  )

  // Get project details (Studio-compatible format)
  .get(
    "/:ref",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) {
        set.status = 404;
        return { error: "Project not found" };
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
      } catch (e) {
        // Ignore database errors
      }

      // Check service statuses using systemd
      const checkServiceStatus = async (serviceName: string): Promise<string> => {
        try {
          const result = await Bun.$`systemctl is-active ${serviceName} 2>/dev/null || echo "inactive"`.quiet();
          const status = result.text().trim();
          return status === "active" ? "ACTIVE_HEALTHY" : "INACTIVE";
        } catch {
          return "INACTIVE";
        }
      };

      const ref = project.ref;
      const serviceStatuses = await Promise.all([
        checkServiceStatus("patroni").then(s => ({ name: "PostgreSQL", status: s })),
        checkServiceStatus(`supacloud-pgrst@${ref}`).then(s => ({ name: "PostgREST", status: s })),
        checkServiceStatus(`supacloud-gotrue@${ref}`).then(s => ({ name: "GoTrue", status: s })),
        // Realtime and Storage are optional, check if service exists
        checkServiceStatus(`supacloud-realtime@${ref}`).then(s => ({ name: "Realtime", status: s })).catch(() => ({ name: "Realtime", status: "INACTIVE" })),
        checkServiceStatus(`supacloud-storage@${ref}`).then(s => ({ name: "Storage", status: s })).catch(() => ({ name: "Storage", status: "INACTIVE" })),
        // Kong is optional
        checkServiceStatus("kong").then(s => ({ name: "Kong", status: s })).catch(() => ({ name: "Kong", status: "INACTIVE" })),
      ]);

      // Return Studio-compatible format
      return {
        id: project.id,
        ref: project.ref,
        name: project.name,
        status: project.status?.toUpperCase() || "ACTIVE_HEALTHY",
        region: project.region || "local",
        organization_id: (project as any).organization_id || "esgfarm",
        cloud_provider: (project as any).cloud_provider || "localhost",
        created_at: project.created_at,
        updated_at: project.updated_at,
        // Studio-specific fields
        database: {
          identifier: project.database?.name || `supa_${project.ref}`,
          host: project.database?.host || "localhost",
          port: (project.database as any)?.port || 5432,
          version: dbVersion,
          postgres_engine: dbVersion.split(".")[0] + "." + dbVersion.split(".")[1],
          release_channel: "stable",
          size: dbSize,
          connection_count: connectionCount,
        },
        services: serviceStatuses,
        endpoint: project.api?.url || `https://${project.ref}.localhost`,
        anon_key: project.anon_key,
        service_key: project.service_key,
        jwt_secret: project.jwt_secret,
        // Original fields for backward compatibility
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
        set.status = 404;
        return { error: "Project not found" };
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
        set.status = 404;
        return { error: "Project not found" };
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
        set.status = 404;
        return { error: "Project not found" };
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
        set.status = 404;
        return { error: "Project not found" };
      }
      return { ref: params.ref, status: "active" };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Get project health status
  .get(
    "/:ref/health",
    async ({ params, set }) => {
      const health = await projectService.getProjectHealth(params.ref);
      if (!health) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return health;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Get project status (legacy compatibility)
  .get(
    "/:ref/status",
    async ({ params, set }) => {
      const status = await projectService.getProjectStatus(params.ref);
      if (!status) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return status;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Get project health status
  .get(
    "/:ref/usage",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) {
        set.status = 404;
        return { error: "Project not found" };
      }
      // Return simulated basic metrics to make Studio dashboard work
      return {
        data: {
          database: { usage: 10, limit: 500, unit: "MB" },
          storage: { usage: 5, limit: 1000, unit: "MB" },
          cpu: { usage: Math.floor(Math.random() * 20), limit: 100, unit: "percent" },
          ram: { usage: 256, limit: 1024, unit: "MB" },
        },
      };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Restart project
  .post(
    "/:ref/restart",
    async ({ params, set }) => {
      const restarted = await projectService.restartProject(params.ref);
      if (!restarted) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return { ref: params.ref, message: "Project restart initiated" };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Get project settings
  .get(
    "/:ref/settings",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (settings === null) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return settings;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Update project settings
  .put(
    "/:ref/settings",
    async ({ params, body, set }) => {
      const settings = await projectService.updateProjectSettings(params.ref, body);
      if (settings === null) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return settings;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Record(t.String(), t.Unknown()),
    }
  )

  // Get project API keys
  .get(
    "/:ref/api-keys",
    async ({ params, set }) => {
      const keys = await projectService.getApiKeys(params.ref);
      if (!keys) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return keys;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Rotate API keys
  .post(
    "/:ref/api-keys/rotate",
    async ({ params, set }) => {
      const keys = await projectService.rotateApiKeys(params.ref);
      if (!keys) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return keys;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Get logs
  .get(
    "/:ref/logs",
    async ({ params, query, set }) => {
      const logs = await projectService.queryLogs(params.ref, query.type);
      return logs;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      query: t.Object({
        type: t.Optional(t.String()),
      }),
    }
  )

  // Get backup list
  .get(
    "/:ref/database/backups",
    async ({ params, set }) => {
      const backups = await projectService.listBackups(params.ref);
      return backups;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Restore backup
  .post(
    "/:ref/database/backups/restore",
    async ({ params, body, set }) => {
      const success = await projectService.restoreBackup(params.ref, body.backup_id);
      if (!success) {
        set.status = 500;
        return { error: "Failed to restore backup" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        backup_id: t.String(),
      }),
    }
  )

  // Update network restrictions
  .post(
    "/:ref/network-restrictions",
    async ({ params, body, set }) => {
      const success = await projectService.updateNetworkRestrictions(params.ref, body.allowed_address_ranges);
      if (!success) {
        set.status = 500;
        return { error: "Failed to update network restrictions" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        allowed_address_ranges: t.Array(t.String()),
      }),
    }
  )

  // Get custom domain
  .get(
    "/:ref/custom-hostname",
    async ({ params, set }) => {
      const domainInfo = await projectService.getCustomDomain(params.ref);
      if (!domainInfo) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return domainInfo;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Add custom domain
  .post(
    "/:ref/custom-hostname",
    async ({ params, body, set }) => {
      const success = await projectService.addCustomDomain(params.ref, body.custom_hostname);
      if (!success) {
        set.status = 500;
        return { error: "Failed to add custom hostname" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        custom_hostname: t.String(),
      }),
    }
  )

  // Delete custom domain
  .delete(
    "/:ref/custom-hostname",
    async ({ params, set }) => {
      const success = await projectService.deleteCustomDomain(params.ref);
      if (!success) {
        set.status = 500;
        return { error: "Failed to delete custom hostname" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Get Auth config (Studio compatible format)
  .get(
    "/:ref/config/auth",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const authConfig = (settings.auth as Record<string, unknown>) || {};
      const externalConfig = (authConfig.external as Record<string, unknown>) || {};

      const studioCompatibleConfig = {
        ...authConfig,
        external: externalConfig,
        external_providers: Object.keys(externalConfig)
          .filter(key => (externalConfig[key] as any)?.client_id)
          .join(","),
      };

      return studioCompatibleConfig;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Modify Auth config (supports deep copy override for third-party Providers)
  .patch(
    "/:ref/config/auth",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const currentAuth = (settings.auth as any) || {};
      const newAuth = typeof body === "object" ? body : {};

      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...currentAuth,
          ...newAuth,
        },
      });
      return updated?.auth || {};
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Record(t.String(), t.Unknown()),
    }
  )

  // Get Database config
  .get(
    "/:ref/config/database",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return settings.database || {};
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Modify Database config
  .patch(
    "/:ref/config/database",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return { error: "Project not found" };

      const current = (settings.database as any) || {};
      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        database: { ...current, ...(typeof body === "object" ? body : {}) },
      });
      return updated?.database || {};
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
    }
  )

  // Get PostgREST config
  .get(
    "/:ref/config/postgrest",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return { error: "Project not found" };
      return settings.postgrest || {};
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Modify PostgREST config
  .patch(
    "/:ref/config/postgrest",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return { error: "Project not found" };
      const current = (settings.postgrest as any) || {};
      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        postgrest: { ...current, ...(typeof body === "object" ? body : {}) },
      });
      return updated?.postgrest || {};
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
    }
  )

  // Get Storage config
  .get(
    "/:ref/config/storage",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return { error: "Project not found" };
      return settings.storage || {};
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Modify Storage config
  .patch(
    "/:ref/config/storage",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return { error: "Project not found" };
      const current = (settings.storage as any) || {};
      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        storage: { ...current, ...(typeof body === "object" ? body : {}) },
      });
      return updated?.storage || {};
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
    }
  )

  // Get Realtime config
  .get(
    "/:ref/config/realtime",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return { error: "Project not found" };
      return settings.realtime || {};
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Modify Realtime config
  .patch(
    "/:ref/config/realtime",
    async ({ params, body, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return { error: "Project not found" };
      const current = (settings.realtime as any) || {};
      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        realtime: { ...current, ...(typeof body === "object" ? body : {}) },
      });
      return updated?.realtime || {};
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
    }
  )

  // Get PgBouncer config (for Studio display)
  .get(
    "/:ref/pgbouncer",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return { error: "Project not found" };
      return settings.pgbouncer || {
        pool_mode: "transaction",
        default_pool_size: 15,
        ignore_startup_parameters: "extra_float_digits"
      };
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Get Typescript Types stub, prevent panel errors
  .get(
    "/:ref/types/typescript",
    async ({ params, query, set }) => {
      // In production environment, usually get pgmeta from real Postgres then generate. Here return a shell for Studio compatibility.
      return { types: "export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];" };
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Optional(t.Object({ included_schemas: t.Optional(t.String()) }))
    }
  )

  // Get environment variables (Secrets)
  .get(
    "/:ref/secrets",
    async ({ params, set }) => {
      const secrets = await projectService.getSecrets(params.ref);
      if (!secrets) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return secrets;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Set environment variables
  .post(
    "/:ref/secrets",
    async ({ params, body, set }) => {
      const success = await projectService.upsertSecrets(params.ref, body as any);
      if (!success) {
        set.status = 500;
        return { error: "Failed to update secrets" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Array(
        t.Object({
          name: t.String(),
          value: t.String(),
        })
      ),
    }
  )

  // Delete environment variable
  .delete(
    "/:ref/secrets/:name",
    async ({ params, set }) => {
      const success = await projectService.deleteSecret(params.ref, params.name);
      if (!success) {
        set.status = 500;
        return { error: "Failed to delete secret" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
        name: t.String(),
      }),
    }
  )

  // Get function list
  .get(
    "/:ref/functions",
    async ({ params, set }) => {
      const functions = await projectService.listFunctions(params.ref);
      return functions;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Get function code
  .get(
    "/:ref/functions/:slug",
    async ({ params, set }) => {
      const code = await projectService.getFunctionCode(params.ref, params.slug);
      if (code === null) {
        set.status = 404;
        return { error: "Function not found" };
      }
      return { code };
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
      }),
    }
  )

  // Deploy function code
  .post(
    "/:ref/functions/:slug",
    async ({ params, body, set }) => {
      const success = await projectService.deployFunction(params.ref, params.slug, body.code);
      if (!success) {
        set.status = 500;
        return { error: "Failed to deploy function" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
      }),
      body: t.Object({
        code: t.String(),
      }),
    }
  )

  // Delete function code
  .delete(
    "/:ref/functions/:slug",
    async ({ params, set }) => {
      const success = await projectService.deleteFunction(params.ref, params.slug);
      if (!success) {
        set.status = 500;
        return { error: "Failed to delete function" };
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
      }),
    }
  )

  // Update gateway config (rate limiting, CORS, JWT)
  .post(
    "/:ref/gateway/config",
    async ({ params, body, set }) => {
      const result = await gatewayService.applyConfig(params.ref, {
        rateLimitTier: body.rate_limit_tier as any,
        corsOrigins: body.cors_origins,
        jwtEnabled: body.jwt_enabled,
        jwtSecret: body.jwt_secret
      });
      if (!result.success) {
        set.status = 500;
        return { error: result.message };
      }
      return result;
    },
    {
      params: t.Object({
        ref: t.String()
      }),
      body: t.Object({
        rate_limit_tier: t.Optional(t.Union([t.Literal('free'), t.Literal('pro'), t.Literal('enterprise')])),
        cors_origins: t.Optional(t.String()),
        jwt_enabled: t.Optional(t.Boolean()),
        jwt_secret: t.Optional(t.String())
      })
    }
  );
