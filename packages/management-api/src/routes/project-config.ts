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
      return [
        { name: "anon", api_key: keys.anon_key },
        { name: "service_role", api_key: keys.service_role_key }
      ];
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

      const hooksConfig = (authConfig.hooks as Record<string, any>) || {};

      const studioCompatibleConfig: Record<string, unknown> = {
        enable_signup: authConfig.enable_signup ?? true,
        enable_confirmations: authConfig.enable_confirmations ?? false,
        enable_manual_linking: authConfig.enable_manual_linking ?? false,
        jwt_expiry: authConfig.jwt_expiry ?? 3600,
        mailer_autoconfirm: authConfig.mailer_autoconfirm ?? false,
        sms_autoconfirm: authConfig.sms_autoconfirm ?? false,
        uri_allow_list: authConfig.uri_allow_list ?? '',
        site_url: authConfig.site_url ?? '',
        password_min_length: authConfig.password_min_length ?? 8,
        security_refresh_token_rotation_enabled: authConfig.security_refresh_token_rotation_enabled ?? true,
        security_refresh_token_rotation_reuse_interval: authConfig.security_refresh_token_rotation_reuse_interval ?? 10,
        mfa_enabled: authConfig.mfa_enabled ?? true,
        webauthn_enabled: authConfig.webauthn_enabled ?? true,
        max_enrolled_factors: authConfig.max_enrolled_factors ?? 10,
        security_update_password_require_reauthentication: authConfig.security_update_password_require_reauthentication ?? true,
        external_anonymous_users_enabled: authConfig.external_anonymous_users_enabled ?? true,
        external_email_enabled: authConfig.external_email_enabled ?? true,
        external_phone_enabled: authConfig.external_phone_enabled ?? true,
        ...authConfig,
      };

      delete studioCompatibleConfig.external;
      delete studioCompatibleConfig.hooks;

      for (const [key, val] of Object.entries(externalConfig)) {
        const providerConfig = val as Record<string, unknown>;
        studioCompatibleConfig[`external_${key}`] = {
          enabled: !!providerConfig?.client_id,
          client_id: providerConfig?.client_id || '',
          secret: providerConfig?.client_secret ? '********' : '',
        };
      }

      studioCompatibleConfig.external_providers = Object.keys(externalConfig)
        .filter(key => (externalConfig[key] as Record<string, unknown>)?.client_id)
        .join(",");

      studioCompatibleConfig.hook_custom_access_token_enabled = !!hooksConfig.custom_access_token_hook?.enabled;
      studioCompatibleConfig.hook_custom_access_token_uri = hooksConfig.custom_access_token_hook?.uri || null;
      studioCompatibleConfig.hook_mfa_verification_enabled = !!hooksConfig.mfa_verification_hook?.enabled;
      studioCompatibleConfig.hook_mfa_verification_uri = hooksConfig.mfa_verification_hook?.uri || null;
      studioCompatibleConfig.hook_password_verification_enabled = !!hooksConfig.password_verification_hook?.enabled;
      studioCompatibleConfig.hook_password_verification_uri = hooksConfig.password_verification_hook?.uri || null;
      studioCompatibleConfig.hook_send_email_enabled = !!hooksConfig.send_email_hook?.enabled;
      studioCompatibleConfig.hook_send_email_uri = hooksConfig.send_email_hook?.uri || null;
      studioCompatibleConfig.hook_send_sms_enabled = !!hooksConfig.send_sms_hook?.enabled;
      studioCompatibleConfig.hook_send_sms_uri = hooksConfig.send_sms_hook?.uri || null;

      const smtpConfig = (authConfig.smtp as Record<string, unknown>) || {};
      studioCompatibleConfig.smtp_admin_email = smtpConfig.admin_email || '';
      studioCompatibleConfig.smtp_host = smtpConfig.host || '';
      studioCompatibleConfig.smtp_port = smtpConfig.port || 587;
      studioCompatibleConfig.smtp_user = smtpConfig.user || '';
      studioCompatibleConfig.smtp_pass = smtpConfig.pass ? '********' : '';

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

      // Parse external_* keys back into nested external config
      const externalUpdates: Record<string, unknown> = {};
      const otherUpdates: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(newAuth)) {
        if (key.startsWith('external_') && key !== 'external_anonymous_users_enabled' && key !== 'external_email_enabled' && key !== 'external_phone_enabled' && key !== 'external_providers') {
          const provider = key.replace('external_', '');
          const providerVal = val as Record<string, unknown>;
          externalUpdates[provider] = {
            ...((currentAuth.external as Record<string, unknown>)?.[provider] as Record<string, unknown> || {}),
            ...(providerVal.client_id !== undefined ? { client_id: providerVal.client_id } : {}),
            ...(providerVal.secret && providerVal.secret !== '********' ? { client_secret: providerVal.secret } : {}),
          };
        } else if (key !== 'external_providers') {
          otherUpdates[key] = val;
        }
      }

      const mergedExternal = {
        ...((currentAuth.external as Record<string, unknown>) || {}),
        ...externalUpdates,
      };

      const mergedAuth = {
        ...currentAuth,
        ...otherUpdates,
        ...(Object.keys(externalUpdates).length > 0 ? { external: mergedExternal } : {}),
      };

      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: mergedAuth,
      });

      // Propagate config to running services
      try {
        const { tenantRuntimeService } = await import("../services/tenant-runtime.service");
        await tenantRuntimeService.restartRuntime(params.ref);
      } catch (err) {
        logger.warn("[project-config] Failed to propagate auth config to runtime", { error: err });
      }

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
  .get(
    "/:ref/config/database",
    async ({ params }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return status(404, { error: "Project not found" });
      try {
        const { sql: metaSql } = await import("../db");
        const { getProjectDb } = await import("../db");
        const [project] = await metaSql`SELECT db_name FROM projects WHERE ref=${params.ref}`;
        if (project?.db_name) {
          const db = getProjectDb(project.db_name);
          const rows = await db`
            SELECT name, setting, unit, short_desc
            FROM pg_settings
            WHERE name IN ('max_connections', 'shared_buffers', 'effective_cache_size', 'work_mem',
                           'maintenance_work_mem', 'statement_timeout', 'idle_in_transaction_session_timeout',
                           'wal_buffers', 'random_page_cost', 'max_parallel_workers_per_gather')
          `;
          const result: Record<string, unknown> = {};
          for (const row of rows) {
            let val: unknown = row.setting;
            if (['statement_timeout', 'idle_in_transaction_session_timeout'].includes(row.name)) {
              val = parseInt(row.setting, 10) || 0;
            }
            result[row.name] = val;
          }
          return result;
        }
      } catch {}
      return (settings as Record<string, unknown>).database || {};
    },
    { params: t.Object({ ref: t.String() }) }
  )
  .patch(
    "/:ref/config/database",
    async ({ params, body }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return status(404, { error: "Project not found" });
      const current = ((settings as Record<string, unknown>).database as Record<string, unknown>) || {};
      const updated = await projectService.updateProjectSettings(params.ref, {
        ...settings,
        database: { ...current, ...(typeof body === "object" ? body : {}) },
      });

      try {
        const { tenantRuntimeService } = await import("../services/tenant-runtime.service");
        await tenantRuntimeService.restartRuntime(params.ref);
      } catch (err) {
        logger.warn("[project-config] Failed to propagate database config to runtime", { error: err });
      }

      return (updated as Record<string, unknown>)?.database || {};
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
    }
  )
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

  // Get Postgres DB config — required by CLI `supabase link` (V1GetPostgresConfig)
  .get(
    "/:ref/config/postgres",
    async ({ params }) => {
      const { getProjectDb } = await import("../db");
      const { sql: metaSql } = await import("../db");
      
      const [project] = await metaSql`SELECT db_name FROM projects WHERE ref=${params.ref}`;
      if (!project) return status(404, { error: "Project not found" });

      try {
        const db = getProjectDb(project.db_name);
        const settings = await db`
          SELECT name, setting, unit, short_desc 
          FROM pg_settings 
          WHERE name IN (
            'max_connections', 'shared_buffers', 'effective_cache_size', 
            'maintenance_work_mem', 'work_mem', 'statement_timeout',
            'idle_in_transaction_session_timeout', 'wal_level',
            'max_wal_senders', 'max_replication_slots'
          )
        `;

        const settingsMap: Record<string, string> = {};
        for (const s of settings) {
          settingsMap[s.name as string] = s.setting as string;
        }

        return {
          max_connections: Number(settingsMap.max_connections || 100),
          shared_buffers: settingsMap.shared_buffers || "128MB",
          effective_cache_size: settingsMap.effective_cache_size || "4GB",
          maintenance_work_mem: settingsMap.maintenance_work_mem || "64MB",
          work_mem: settingsMap.work_mem || "4MB",
          statement_timeout: settingsMap.statement_timeout || "0",
          idle_in_transaction_session_timeout: settingsMap.idle_in_transaction_session_timeout || "0",
          wal_level: settingsMap.wal_level || "replica",
        };
      } catch {
        return {
          max_connections: 100,
          shared_buffers: "128MB",
          effective_cache_size: "4GB",
        };
      }
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Get Pooler config — required by CLI `supabase link` (GetPoolerConfig)
  .get(
    "/:ref/config/pooler",
    async ({ params }) => {
      const { config: appConfig } = await import("../config");
      const { sql: metaSql } = await import("../db");
      
      const [project] = await metaSql`SELECT db_name FROM projects WHERE ref=${params.ref}`;
      if (!project) return status(404, { error: "Project not found" });

      const pgHost = appConfig.baseDomain || "localhost";
      const pgPort = appConfig.pgPort || 5432;
      const poolerHost = appConfig.poolerHost || pgHost;
      const poolerPort = appConfig.poolerPort || 6543;

      return {
        pool_mode: "transaction",
        default_pool_size: 15,
        max_client_conn: 200,
        connection_string: `postgresql://postgres.${params.ref}:[YOUR-PASSWORD]@${poolerHost}:${poolerPort}/postgres?pgbouncer=true`,
        direct_connection_string: `postgresql://postgres.${params.ref}:[YOUR-PASSWORD]@${pgHost}:${pgPort}/postgres`,
      };
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Get Network Restrictions — required by CLI `supabase link` (V1GetNetworkRestrictions)
  .get(
    "/:ref/network-restrictions",
    async ({ params }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return status(404, { error: "Project not found" });

      return {
        config: {
          dbAllowedCidrs: (settings as Record<string, unknown>).network_restrictions || ["0.0.0.0/0"],
        },
        old_config: {},
        status: "applied",
        entitlement: "custom",
      };
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Get Storage policies — required by Studio Storage > Policies page (P0-15)
  .get(
    "/:ref/storage/policies",
    async ({ params }) => {
      const { getProjectDb } = await import("../db");
      const { sql: metaSql } = await import("../db");
      
      const [project] = await metaSql`SELECT db_name FROM projects WHERE ref=${params.ref}`;
      if (!project) return status(404, { error: "Project not found" });

      try {
        const db = getProjectDb(project.db_name);
        const policies = await db`
          SELECT pol.polname as name, pol.polpermissive as permissive,
            CASE pol.polcmd
              WHEN 'r' THEN 'SELECT'
              WHEN 'a' THEN 'INSERT'
              WHEN 'w' THEN 'UPDATE'
              WHEN 'd' THEN 'DELETE'
              ELSE 'ALL'
            END as command,
            pg_get_expr(pol.polqual, pol.polrelid) as definition,
            pg_get_expr(pol.polwithcheck, pol.polrelid) as check,
            cls.relname as table_name,
            nsp.nspname as schema_name,
            ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles)) as roles
          FROM pg_policy pol
          JOIN pg_class cls ON pol.polrelid = cls.oid
          JOIN pg_namespace nsp ON cls.relnamespace = nsp.oid
          WHERE nsp.nspname = 'storage'
          ORDER BY cls.relname, pol.polname
        `;
        return policies;
      } catch (err) {
        logger.warn("[project-config] Failed to list storage policies", { error: err });
        return [];
      }
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

        // 5. Fetch foreign key relationships
        const fkeys = await db`
          SELECT
            ns.nspname AS source_schema,
            cls.relname AS source_table,
            attr.attname AS source_column,
            ns2.nspname AS target_schema,
            cls2.relname AS target_table,
            attr2.attname AS target_column
          FROM pg_constraint con
          JOIN pg_class cls ON con.conrelid = cls.oid
          JOIN pg_namespace ns ON cls.relnamespace = ns.oid
          JOIN pg_class cls2 ON con.confrelid = cls2.oid
          JOIN pg_namespace ns2 ON cls2.relnamespace = ns2.oid
          JOIN pg_attribute attr ON attr.attrelid = con.conrelid AND attr.attnum = ANY(con.conkey)
          JOIN pg_attribute attr2 ON attr2.attrelid = con.confrelid AND attr2.attnum = ANY(con.confkey)
          WHERE con.contype = 'f'
            AND ns.nspname = ANY(${includedSchemas})
          ORDER BY ns.nspname, cls.relname, attr.attname
        `;

        const relMap = new Map<string, Array<{ source_column: string; target_schema: string; target_table: string; target_column: string }>>();
        for (const fk of fkeys) {
          const key = `${fk.source_schema}.${fk.source_table}`;
          if (!relMap.has(key)) relMap.set(key, []);
          relMap.get(key)!.push({
            source_column: fk.source_column,
            target_schema: fk.target_schema,
            target_table: fk.target_table,
            target_column: fk.target_column
          });
        }

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
            ts += `        }\n        Relationships: [\n`;
            const rels = relMap.get(`${schema}.${tableName}`) || [];
            for (const rel of rels) {
              ts += `          { source_column: "${rel.source_column}"; target_schema: "${rel.target_schema}"; target_table: "${rel.target_table}"; target_column: "${rel.target_column}" },\n`;
            }
            ts += `        ]\n      }\n`;
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
            ts += `        }\n        Insert: {\n`;
            for (const col of viewCols) {
              const tsType = pgTypeToTs(col.udt_name as string, col.data_type as string);
              ts += `          ${col.column_name}?: ${tsType} | null\n`;
            }
            ts += `        }\n        Update: {\n`;
            for (const col of viewCols) {
              const tsType = pgTypeToTs(col.udt_name as string, col.data_type as string);
              ts += `          ${col.column_name}?: ${tsType} | null\n`;
            }
            ts += `        }\n        Relationships: []\n      }\n`;
          }

          ts += `    }\n    Functions: {\n`;

          // Functions
          for (const fn of functions.filter((f: Record<string, unknown>) => f.schema === schema)) {
            ts += `      ${fn.name}: {\n        Args: Record<string, unknown>\n        Returns: unknown\n      }\n`;
          }

          ts += `    }\n    Enums: {\n`;

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

