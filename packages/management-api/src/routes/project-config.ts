/**
 * Project Configuration Routes
 * Handles: settings, API keys, auth config, config CRUD factory, pgbouncer, types
 */
import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { gatewayService } from "../services/gateway.service";

/**
 * Factory: generates GET + PATCH routes for a project settings config section.
 * Eliminates repeated boilerplate for database/postgrest/storage/realtime configs.
 */
function addConfigRoutes(section: string) {
  return new Elysia({ prefix: "/v1/projects" })
    .get(
      `/:ref/config/${section}`,
      async ({ params }: { params: { ref: string } }) => {
        const settings = await projectService.getProjectSettings(params.ref);
        if (!settings) return status(404, { error: "Project not found" });
        return (settings as Record<string, unknown>)[section] || {};
      },
      { params: t.Object({ ref: t.String() }) }
    )
    .patch(
      `/:ref/config/${section}`,
      async ({ params, body }: { params: { ref: string }; body: Record<string, unknown> }) => {
        const settings = await projectService.getProjectSettings(params.ref);
        if (!settings) return status(404, { error: "Project not found" });
        const current = ((settings as Record<string, unknown>)[section] as Record<string, unknown>) || {};
        const updated = await projectService.updateProjectSettings(params.ref, {
          ...settings,
          [section]: { ...current, ...(typeof body === "object" ? body : {}) },
        });
        return (updated as Record<string, unknown>)?.[section] || {};
      },
      {
        params: t.Object({ ref: t.String() }),
        body: t.Record(t.String(), t.Unknown()),
      }
    );
}

export const projectConfigRoutes = new Elysia({ prefix: "/v1/projects" })
  // Get project settings
  .get(
    "/:ref/settings",
    async ({ params, set }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (settings === null) {
                return status(404, { error: "Project not found" });
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
                return status(404, { error: "Project not found" });
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
                return status(404, { error: "Project not found" });
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
                return status(404, { error: "Project not found" });
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
                return status(500, { error: "Failed to restore backup" });
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
                return status(500, { error: "Failed to update network restrictions" });
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
                return status(404, { error: "Project not found" });
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
                return status(500, { error: "Failed to add custom hostname" });
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
                return status(500, { error: "Failed to delete custom hostname" });
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
                return status(404, { error: "Project not found" });
      }

      const authConfig = (settings.auth as Record<string, unknown>) || {};
      const externalConfig = (authConfig.external as Record<string, unknown>) || {};

      const studioCompatibleConfig = {
        ...authConfig,
        external: externalConfig,
        external_providers: Object.keys(externalConfig)
          .filter(key => (externalConfig[key] as Record<string, unknown>)?.client_id)
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
                return status(404, { error: "Project not found" });
      }

      const currentAuth = (settings.auth as Record<string, unknown>) || {};
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

  // --- Config CRUD (database, postgrest, storage, realtime) via factory ---
  .use(addConfigRoutes("database"))
  .use(addConfigRoutes("postgrest"))
  .use(addConfigRoutes("storage"))
  .use(addConfigRoutes("realtime"))

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

  // Get Typescript Types stub
  .get(
    "/:ref/types/typescript",
    async ({ params, query, set }) => {
      return { types: "export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];" };
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Optional(t.Object({ included_schemas: t.Optional(t.String()) }))
    }
  )

  // Update gateway config (rate limiting, CORS, JWT)
  .post(
    "/:ref/gateway/config",
    async ({ params, body, set }) => {
      const result = await gatewayService.applyConfig(params.ref, {
        rateLimitTier: body.rate_limit_tier as "free" | "pro" | "enterprise" | undefined,
        corsOrigins: body.cors_origins,
        jwtEnabled: body.jwt_enabled,
        jwtSecret: body.jwt_secret
      });
      if (!result.success) {
                return status(500, { error: result.message });
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
  )

  // Rebuild ALL tenant Kong configs (propagate CORS / template changes)
  .post(
    "/:ref/gateway/rebuild-all",
    async () => {
      const result = await gatewayService.rebuildAllTenantConfigs();
      if (!result.success) {
        return { ...result, error: "Rebuild failed" };
      }
      return result;
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Rebuild all tenant Kong configs" },
    }
  )

  // --- Programmable Rate Limiting (Kong Admin API) ---

  // Get current rate limit config for a project
  .get(
    "/:ref/gateway/rate-limit",
    async ({ params }) => {
      const rateLimit = await gatewayService.getRateLimit(params.ref);
      if (rateLimit === null) {
        return status(500, { error: "Failed to query rate limit from gateway" });
      }
      return rateLimit;
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get project rate limit config" },
    }
  )

  // Set rate limit — supports tier presets OR custom values
  .put(
    "/:ref/gateway/rate-limit",
    async ({ params, body }) => {
      let success: boolean;
      if (body.tier) {
        success = await gatewayService.setRateLimit(params.ref, body.tier);
      } else {
        success = await gatewayService.setRateLimit(params.ref, {
          second: body.second,
          minute: body.minute,
          hour: body.hour,
        });
      }
      if (!success) {
        return status(500, { error: "Failed to update rate limit" });
      }
      return { success: true, message: "Rate limit updated" };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        tier: t.Optional(t.Union([t.Literal("free"), t.Literal("pro"), t.Literal("enterprise")])),
        second: t.Optional(t.Number()),
        minute: t.Optional(t.Number()),
        hour: t.Optional(t.Number()),
      }),
      detail: { tags: ["projects"], summary: "Set project rate limit" },
    }
  );
