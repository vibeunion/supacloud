/**
 * Project Configuration Routes
 * Handles: settings, API keys, auth config, config CRUD factory, pgbouncer, types
 */
import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { gatewayService } from "../services/gateway.service";
import { logger } from "../utils/logger";

/** Map PostgreSQL column types to TypeScript types */
function pgTypeToTs(udtName: string, dataType: string): string {
  const map: Record<string, string> = {
    bool: 'boolean',
    int2: 'number', int4: 'number', int8: 'number',
    float4: 'number', float8: 'number', numeric: 'number',
    text: 'string', varchar: 'string', char: 'string', bpchar: 'string', name: 'string', citext: 'string',
    uuid: 'string',
    date: 'string', time: 'string', timetz: 'string', timestamp: 'string', timestamptz: 'string',
    interval: 'string',
    json: 'Json', jsonb: 'Json',
    bytea: 'string',
    inet: 'string', cidr: 'string', macaddr: 'string',
    oid: 'number',
    void: 'undefined',
    record: 'Record<string, unknown>',
    vector: 'number[]',
  };
  if (udtName.startsWith('_')) return `${pgTypeToTs(udtName.slice(1), dataType)}[]`;
  return map[udtName] || (dataType === 'ARRAY' ? 'unknown[]' : (dataType === 'USER-DEFINED' ? 'string' : 'unknown'));
}

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

  // Get Typescript Types — Real schema reflection (P0-5)
  .get(
    "/:ref/types/typescript",
    async ({ params, query, set }) => {
      const { getProjectDb } = await import("../db");
      const { sql: metaSql } = await import("../db");
      
      const [project] = await metaSql`SELECT db_name FROM projects WHERE ref=${params.ref}`;
      if (!project) return status(404, { error: "Project not found" });

      try {
        const db = getProjectDb(project.db_name);
        const includedSchemas = (query?.included_schemas || "public").split(",").map((s: string) => s.trim());

        // 1. Fetch all enums
        const enums = await db`
          SELECT n.nspname as schema, t.typname as name, 
            array_agg(e.enumlabel ORDER BY e.enumsortorder) as values
          FROM pg_type t
          JOIN pg_enum e ON t.oid = e.enumtypid
          JOIN pg_namespace n ON t.typnamespace = n.oid
          WHERE n.nspname = ANY(${includedSchemas})
          GROUP BY n.nspname, t.typname
          ORDER BY n.nspname, t.typname
        `;

        // 2. Fetch all tables + columns
        const columns = await db`
          SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.udt_name,
            c.is_nullable, c.column_default, c.is_identity, c.identity_generation,
            c.is_generated, c.generation_expression,
            (SELECT tc.constraint_type FROM information_schema.table_constraints tc 
             JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name 
               AND tc.table_schema = kcu.table_schema
             WHERE tc.table_schema = c.table_schema AND tc.table_name = c.table_name 
               AND kcu.column_name = c.column_name AND tc.constraint_type = 'PRIMARY KEY'
             LIMIT 1) as is_primary_key
          FROM information_schema.columns c
          WHERE c.table_schema = ANY(${includedSchemas})
          ORDER BY c.table_schema, c.table_name, c.ordinal_position
        `;

        // 3. Fetch views
        const views = await db`
          SELECT table_schema, table_name 
          FROM information_schema.views 
          WHERE table_schema = ANY(${includedSchemas})
        `;
        const viewSet = new Set(views.map((v: Record<string, unknown>) => `${v.table_schema}.${v.table_name}`));

        // 4. Fetch functions  
        const functions = await db`
          SELECT n.nspname as schema, p.proname as name,
            pg_get_function_arguments(p.oid) as args,
            pg_get_function_result(p.oid) as return_type
          FROM pg_proc p
          JOIN pg_namespace n ON p.pronamespace = n.oid
          WHERE n.nspname = ANY(${includedSchemas})
            AND p.prokind IN ('f', 'p')
            AND NOT p.proisagg
          ORDER BY n.nspname, p.proname
        `;

        // Generate TypeScript
        let ts = `export type Json =\n  | string\n  | number\n  | boolean\n  | null\n  | { [key: string]: Json | undefined }\n  | Json[]\n\nexport type Database = {\n`;

        for (const schema of includedSchemas) {
          ts += `  ${schema}: {\n    Tables: {\n`;

          // Group columns by table
          const tableMap = new Map<string, Array<Record<string, unknown>>>();
          for (const col of columns) {
            if (col.table_schema !== schema) continue;
            const key = col.table_name as string;
            if (viewSet.has(`${schema}.${key}`)) continue; // skip views
            if (!tableMap.has(key)) tableMap.set(key, []);
            tableMap.get(key)!.push(col);
          }

          for (const [tableName, cols] of tableMap) {
            ts += `      ${tableName}: {\n        Row: {\n`;
            for (const col of cols) {
              const tsType = pgTypeToTs(col.udt_name as string, col.data_type as string);
              const nullable = col.is_nullable === 'YES' ? ' | null' : '';
              ts += `          ${col.column_name}: ${tsType}${nullable}\n`;
            }
            ts += `        }\n        Insert: {\n`;
            for (const col of cols) {
              const tsType = pgTypeToTs(col.udt_name as string, col.data_type as string);
              const nullable = col.is_nullable === 'YES' ? ' | null' : '';
              const optional = col.column_default || col.is_identity === 'YES' || col.is_nullable === 'YES' ? '?' : '';
              ts += `          ${col.column_name}${optional}: ${tsType}${nullable}\n`;
            }
            ts += `        }\n        Update: {\n`;
            for (const col of cols) {
              const tsType = pgTypeToTs(col.udt_name as string, col.data_type as string);
              const nullable = col.is_nullable === 'YES' ? ' | null' : '';
              ts += `          ${col.column_name}?: ${tsType}${nullable}\n`;
            }
            ts += `        }\n        Relationships: []\n      }\n`;
          }

          ts += `    }\n    Views: {\n`;

          // Views
          for (const view of views.filter((v: Record<string, unknown>) => v.table_schema === schema)) {
            const viewCols = columns.filter((c: Record<string, unknown>) => c.table_schema === schema && c.table_name === view.table_name);
            ts += `      ${view.table_name}: {\n        Row: {\n`;
            for (const col of viewCols) {
              const tsType = pgTypeToTs(col.udt_name as string, col.data_type as string);
              ts += `          ${col.column_name}: ${tsType} | null\n`;
            }
            ts += `        }\n        Relationships: []\n      }\n`;
          }

          ts += `    }\n    Functions: {\n`;

          // Functions
          for (const fn of functions.filter((f: Record<string, unknown>) => f.schema === schema)) {
            ts += `      ${fn.name}: {\n        Args: Record<string, unknown>\n        Returns: unknown\n      }\n`;
          }

          ts += `    }\n    Enums: {\n`;

          // Enums
          for (const en of enums.filter((e: Record<string, unknown>) => e.schema === schema)) {
            const vals = (en.values as string[]).map(v => `"${v}"`).join(' | ');
            ts += `      ${en.name}: ${vals}\n`;
          }

          ts += `    }\n    CompositeTypes: {\n      [_ in never]: never\n    }\n  }\n`;
        }

        ts += `}\n`;

        return { types: ts };
      } catch (err: unknown) {
        logger.error("[project-config] TypeScript type generation failed", { error: err });
        // Fallback to minimal stub
        return { types: "export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];" };
      }
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
  )

  // --- Tenant Custom Path Rate Limiting ---

  // Set custom rate limit for a specific path
  .put(
    "/:ref/gateway/custom-rate-limits",
    async ({ params, body }) => {
      // 1. Fetch current settings to persist and check limits
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return status(404, { error: "Project not found" });

      const currentLimits = (settings.rate_limits as Record<string, unknown>) || {};
      const customPaths = Object.keys(currentLimits);
      
      // Enforce max 20 custom rate-limit routes per project
      if (customPaths.length >= 20 && !customPaths.includes(body.path)) {
          return status(400, { error: "Maximum of 20 custom rate limit routes allowed per project" });
      }

      // 2. Apply to Kong
      const success = await gatewayService.setCustomRouteRateLimit(params.ref, body.path, {
          second: body.second,
          minute: body.minute,
          hour: body.hour,
      });

      if (!success) {
          return status(500, { error: "Failed to update custom route rate limit in gateway" });
      }

      // 3. Persist in database
      await projectService.updateProjectSettings(params.ref, {
          ...settings,
          rate_limits: {
            ...currentLimits,
            [body.path]: { second: body.second, minute: body.minute, hour: body.hour }
          }
      });

      return { success: true, message: `Custom rate limit set for ${body.path}` };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        path: t.String({ description: "Base path to rate limit. e.g. /rest/v1/payments" }),
        second: t.Optional(t.Number()),
        minute: t.Optional(t.Number()),
        hour: t.Optional(t.Number()),
      }),
      detail: { tags: ["projects"], summary: "Set a custom rate limit for a specific path" },
    }
  )

  // Remove custom rate limit for a specific path
  .delete(
    "/:ref/gateway/custom-rate-limits",
    async ({ params, body }) => {
      // 1. Fetch current settings
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return status(404, { error: "Project not found" });

      // 2. Remove from Kong
      const success = await gatewayService.removeCustomRouteRateLimit(params.ref, body.path);
      if (!success) {
          return status(500, { error: "Failed to remove custom route rate limit from gateway" });
      }

      // 3. Persist removal in DB
      const currentLimits = (settings.rate_limits as Record<string, unknown>) || {};
      if (currentLimits[body.path]) {
          delete currentLimits[body.path];
          await projectService.updateProjectSettings(params.ref, {
              ...settings,
              rate_limits: currentLimits
          });
      }

      return { success: true, message: `Custom rate limit removed for ${body.path}` };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        path: t.String({ description: "Base path to rate limit. e.g. /rest/v1/payments" })
      }),
      detail: { tags: ["projects"], summary: "Remove a custom rate limit for a specific path" },
    }
  );

