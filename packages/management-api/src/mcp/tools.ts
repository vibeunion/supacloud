import { z } from "zod";
import { logger } from "../utils/logger";
import { config } from "../config";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { projectService } from "../services";
import { organizationService } from "../services/organization.service";
import { StorageService } from "../services/storage.service";
import { sql as metaSql, getProjectDb } from "../db";
import { createMcpToken, type McpTokenPayload } from "./token";

// MCP tool annotations — clients use these to decide whether to prompt user
const READONLY_HINT: ToolAnnotations  = { readOnlyHint: true };
const DESTRUCTIVE_HINT: ToolAnnotations = { destructiveHint: true };

export function registerMcpTools(server: McpServer, token: McpTokenPayload): void {
  const isAdmin = token.role === "admin";
  const scopedRef = token.ref;         // undefined for admin
  const readOnly = token.readonly ?? false;

  // Helper: resolve ref from tool args or token scope
  const resolveRef = (argsRef?: string): string => {
    if (scopedRef) return scopedRef;
    if (argsRef) return argsRef;
    throw new Error("Project ref is required");
  };

  const refParam: Record<string, z.ZodType> = scopedRef
    ? {}
    : { ref: z.string().describe("Project ref") };

  // ═══════════════════════════════════════════════
  // Project Management (admin only)
  // ═══════════════════════════════════════════════

  if (isAdmin) {
    server.tool("list_projects", "List all Supabase projects", {}, READONLY_HINT, async () => {
      const projects = await projectService.listProjects();
      return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
    });

    server.tool("create_project", "Create a new Supabase project", {
      name: z.string().describe("Project name"),
      region: z.string().default("local").describe("Region"),
      organization_id: z.string().optional().describe("Organization ID"),
    }, DESTRUCTIVE_HINT, async ({ name, region, organization_id }: { name: string; region: string; organization_id?: string }) => {
      const project = await projectService.createProject({ name, region, organization_id });
      return { content: [{ type: "text", text: `✅ Project created\n${JSON.stringify(project, null, 2)}` }] };
    });

    server.tool("delete_project", "Delete a project (soft delete)", {
      ref: z.string().describe("Project ref"),
    }, DESTRUCTIVE_HINT, async ({ ref }: { ref: string }) => {
      const ok = await projectService.deleteProject(ref);
      return { content: [{ type: "text", text: ok ? `✅ Project ${ref} deleted` : `❌ Delete failed` }] };
    });

    server.tool("list_organizations", "List all organizations", {}, READONLY_HINT, async () => {
      const orgs = await organizationService.listOrganizations();
      return { content: [{ type: "text", text: JSON.stringify(orgs, null, 2) }] };
    });

    // Token management
    server.tool("create_mcp_token", "Create an MCP access token for a project (scoped, read-only optional)", {
      ref: z.string().describe("Project ref to scope the token to"),
      name: z.string().default("default").describe("Human-readable label"),
      readonly: z.boolean().default(true).describe("Read-only mode"),
      expires_days: z.number().default(365).describe("Expiry in days"),
    }, async ({ ref, name, readonly, expires_days }: { ref: string; name: string; readonly: boolean; expires_days: number }) => {
      const tkn = await createMcpToken({ role: "project", ref, readonly, name, expiresInDays: expires_days });
      return { content: [{ type: "text", text: `✅ Project MCP token created\n\nToken: ${tkn}\nRef: ${ref}\nRead-only: ${readonly}\nExpires: ${expires_days} days\n\nConfigure in AI IDE:\n${JSON.stringify({ mcpServers: { [ref]: { url: "<API_URL>/mcp", headers: { Authorization: `Bearer ${tkn}` } } } }, null, 2)}` }] };
    });
  }

  // ═══════════════════════════════════════════════
  // Project Info (all roles)
  // ═══════════════════════════════════════════════

  server.tool("get_project", "Get project details", refParam, READONLY_HINT, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const project = await projectService.getProject(ref);
    return { content: [{ type: "text", text: project ? JSON.stringify(project, null, 2) : "❌ Project not found" }] };
  });

  server.tool("get_project_health", "Get project health and service status", refParam, READONLY_HINT, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const health = await projectService.getProjectHealth(ref);
    return { content: [{ type: "text", text: health ? JSON.stringify(health, null, 2) : "❌ Project not found" }] };
  });

  server.tool("get_project_settings", "Get project configuration", refParam, READONLY_HINT, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const settings = await projectService.getProjectSettings(ref);
    return { content: [{ type: "text", text: settings ? JSON.stringify(settings, null, 2) : "❌ Not found" }] };
  });

  server.tool("get_api_keys", "Get project API keys (anon_key, service_role_key)", refParam, READONLY_HINT, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const keys = await projectService.getApiKeys(ref);
    return { content: [{ type: "text", text: keys ? JSON.stringify(keys, null, 2) : "❌ Not found" }] };
  });

  server.tool("list_project_tasks", "List provisioning/cleanup tasks for a project", refParam, READONLY_HINT, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const tasks = await metaSql`SELECT * FROM project_tasks WHERE project_ref = ${ref} ORDER BY created_at DESC LIMIT 50`;
    return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
  });

  server.tool("create_project_task", "Dispatch a background long-running queue task (e.g. AI generation, MQTT push) into the project's native task worker base", {
    ...refParam,
    task_type: z.string().describe("Task type (e.g. ai_generation, mqtt_event)"),
    payload: z.record(z.any()).default({}).describe("JSON payload for the task dispatcher"),
  }, DESTRUCTIVE_HINT, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    try {
      const result = await metaSql`
        INSERT INTO project_tasks (project_ref, task_type, payload, status)
        VALUES (${ref}, ${args.task_type as string}, ${JSON.stringify(args.payload)}, 'pending')
        RETURNING id
      `;
      return { content: [{ type: "text", text: `✅ Event dispatched to Queue Worker! Task ID: ${result[0].id}` }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `❌ Error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  });

  // ═══════════════════════════════════════════════
  // Project Actions (admin or non-readonly project)
  // ═══════════════════════════════════════════════

  if (isAdmin || !readOnly) {
    server.tool("pause_project", "Pause a project to release resources", refParam, DESTRUCTIVE_HINT, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const ok = await projectService.pauseProject(ref);
      return { content: [{ type: "text", text: ok ? `✅ ${ref} paused` : "❌ Failed" }] };
    });

    server.tool("restore_project", "Restore a paused project", refParam, DESTRUCTIVE_HINT, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const ok = await projectService.restoreProject(ref);
      return { content: [{ type: "text", text: ok ? `✅ ${ref} restored` : "❌ Failed" }] };
    });

    server.tool("restart_project", "Restart all services for a project", refParam, DESTRUCTIVE_HINT, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const ok = await projectService.restartProject(ref);
      return { content: [{ type: "text", text: ok ? "✅ Restart complete" : "❌ Failed" }] };
    });

    server.tool("update_project_settings", "Update project configuration", {
      ...refParam,
      settings: z.record(z.unknown()).describe("Config fields to update"),
    }, DESTRUCTIVE_HINT, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const result = await projectService.updateProjectSettings(ref, args.settings as Record<string, unknown>);
      return { content: [{ type: "text", text: result ? `✅ Updated\n${JSON.stringify(result, null, 2)}` : "❌ Failed" }] };
    });

    server.tool("rotate_api_keys", "Rotate project API keys", refParam, DESTRUCTIVE_HINT, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const keys = await projectService.rotateApiKeys(ref);
      return { content: [{ type: "text", text: keys ? `✅ Keys rotated\n${JSON.stringify(keys, null, 2)}` : "❌ Failed" }] };
    });
  }

  // ═══════════════════════════════════════════════
  // Database (SQL execution)
  // ═══════════════════════════════════════════════

  // execute_sql: destructive when not readonly (can run DDL/DML), read-only otherwise
  server.tool("execute_sql", readOnly
    ? "Execute read-only SQL (SELECT only) on project database"
    : "Execute SQL on project database (⚠️ can modify data)", {
    ...refParam,
    sql: z.string().describe("SQL query"),
  }, readOnly ? READONLY_HINT : DESTRUCTIVE_HINT, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const sqlStr = args.sql as string;

    if (readOnly) {
      const upper = sqlStr.trim().toUpperCase();
      const forbidden = ["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "TRUNCATE"];
      for (const kw of forbidden) {
        if (upper.includes(kw)) {
          return { content: [{ type: "text", text: `❌ Write blocked in read-only mode: ${kw}` }] };
        }
      }
    }

    // Execute via project's database (uses pooled connection from postgres.js)
    try {
      const db = await getDb(ref);
      const rows = await db.unsafe(sqlStr);
      return { content: [{ type: "text", text: `✅ ${Array.isArray(rows) ? rows.length : 0} row(s)\n${JSON.stringify(rows, null, 2)}` }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `❌ SQL error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  });

  // Helper: get project database connection
  const getDb = async (ref: string) => {
    const project = (await metaSql`SELECT db_name FROM projects WHERE ref=${ref}`)[0];
    if (!project) throw new Error("Project not found");
    return getProjectDb(project.db_name as string);
  };

  // ═══════════════════════════════════════════════
  // Schema Introspection
  // ═══════════════════════════════════════════════

  server.tool("list_tables", "List all tables in the project database with row count estimates", {
    ...refParam,
    schema: z.string().default("public").describe("Schema name (default: public)"),
  }, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    try {
      const db = await getDb(ref);
      const tables = await db.unsafe(`
        SELECT
          t.schemaname,
          t.tablename,
          COALESCE(s.n_live_tup, 0) AS estimated_rows,
          obj_description((t.schemaname || '.' || t.tablename)::regclass) AS comment
        FROM pg_tables t
        LEFT JOIN pg_stat_user_tables s ON s.schemaname = t.schemaname AND s.relname = t.tablename
        WHERE t.schemaname = '${args.schema || "public"}'
        ORDER BY t.tablename
      `);
      return { content: [{ type: "text", text: JSON.stringify(tables, null, 2) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `❌ Error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  });

  server.tool("describe_table", "Get detailed table structure (columns, types, constraints, indexes)", {
    ...refParam,
    table: z.string().describe("Table name"),
    schema: z.string().default("public").describe("Schema name (default: public)"),
  }, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const schema = (args.schema as string) || "public";
    const table = args.table as string;
    try {
      const db = await getDb(ref);

      // Columns
      const columns = await db.unsafe(`
        SELECT
          c.column_name, c.data_type, c.udt_name, c.is_nullable,
          c.column_default, c.character_maximum_length,
          col_description(('"${schema}"."${table}"')::regclass, c.ordinal_position) AS comment
        FROM information_schema.columns c
        WHERE c.table_schema = '${schema}' AND c.table_name = '${table}'
        ORDER BY c.ordinal_position
      `);

      // Primary keys & unique constraints
      const constraints = await db.unsafe(`
        SELECT tc.constraint_name, tc.constraint_type, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = '${schema}' AND tc.table_name = '${table}'
        ORDER BY tc.constraint_type, kcu.ordinal_position
      `);

      // Foreign keys
      const fkeys = await db.unsafe(`
        SELECT
          kcu.column_name AS from_column,
          ccu.table_schema AS to_schema,
          ccu.table_name AS to_table,
          ccu.column_name AS to_column
        FROM information_schema.referential_constraints rc
        JOIN information_schema.key_column_usage kcu
          ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.constraint_schema
        JOIN information_schema.constraint_column_usage ccu
          ON rc.unique_constraint_name = ccu.constraint_name AND rc.unique_constraint_schema = ccu.constraint_schema
        WHERE kcu.table_schema = '${schema}' AND kcu.table_name = '${table}'
      `);

      // Indexes
      const indexes = await db.unsafe(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = '${schema}' AND tablename = '${table}'
      `);

      return { content: [{ type: "text", text: JSON.stringify({ columns, constraints, foreign_keys: fkeys, indexes }, null, 2) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `❌ Error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  });

  server.tool("get_schema_overview", "Get full schema overview (all tables, columns, relationships) for AI context", {
    ...refParam,
    schemas: z.string().default("public").describe("Comma-separated schema names (default: public)"),
  }, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const schemas = ((args.schemas as string) || "public").split(",").map(s => `'${s.trim()}'`).join(",");
    try {
      const db = await getDb(ref);

      const overview = await db.unsafe(`
        SELECT
          c.table_schema, c.table_name, c.column_name, c.data_type, c.udt_name,
          c.is_nullable, c.column_default,
          (SELECT tc.constraint_type FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
           WHERE kcu.table_schema = c.table_schema AND kcu.table_name = c.table_name
             AND kcu.column_name = c.column_name AND tc.constraint_type = 'PRIMARY KEY'
           LIMIT 1) AS is_pk
        FROM information_schema.columns c
        WHERE c.table_schema IN (${schemas})
        ORDER BY c.table_schema, c.table_name, c.ordinal_position
      `);

      // Group by table for readability
      const grouped: Record<string, unknown[]> = {};
      for (const row of overview) {
        const key = `${(row as Record<string, string>).table_schema}.${(row as Record<string, string>).table_name}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(row);
      }

      return { content: [{ type: "text", text: JSON.stringify(grouped, null, 2) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `❌ Error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  });

  server.tool("list_rls_policies", "List Row Level Security policies for a table", {
    ...refParam,
    table: z.string().describe("Table name"),
    schema: z.string().default("public").describe("Schema name (default: public)"),
  }, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const schema = (args.schema as string) || "public";
    const table = args.table as string;
    try {
      const db = await getDb(ref);
      const policies = await db.unsafe(`
        SELECT policyname, permissive, roles, cmd, qual, with_check
        FROM pg_policies
        WHERE schemaname = '${schema}' AND tablename = '${table}'
        ORDER BY policyname
      `);

      // Also check if RLS is enabled
      const rlsStatus = await db.unsafe(`
        SELECT relrowsecurity, relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = '${schema}' AND c.relname = '${table}'
      `);

      return { content: [{ type: "text", text: JSON.stringify({
        rls_enabled: (rlsStatus[0] as Record<string, boolean>)?.relrowsecurity || false,
        rls_forced: (rlsStatus[0] as Record<string, boolean>)?.relforcerowsecurity || false,
        policies,
      }, null, 2) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `❌ Error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  });

  // ═══════════════════════════════════════════════
  // AI SQL Assistant (platform LLM)
  // ═══════════════════════════════════════════════

  if (config.llmApiKey) {
    server.tool("ai_generate_sql", "Generate SQL from natural language using project schema context", {
      ...refParam,
      prompt: z.string().describe("Natural language description of the query you want"),
      schema: z.string().default("public").describe("Schema to use for context"),
    }, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const prompt = args.prompt as string;
      const schema = (args.schema as string) || "public";

      try {
        // 1. Get schema context
        const db = await getDb(ref);
        const tables = await db.unsafe(`
          SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
          FROM information_schema.columns c
          WHERE c.table_schema = '${schema}'
          ORDER BY c.table_name, c.ordinal_position
        `);

        // Build compact schema description
        const schemaCtx: Record<string, string[]> = {};
        for (const col of tables) {
          const t = (col as Record<string, string>).table_name;
          const c = `${(col as Record<string, string>).column_name} ${(col as Record<string, string>).data_type}${(col as Record<string, string>).is_nullable === "NO" ? " NOT NULL" : ""}`;
          if (!schemaCtx[t]) schemaCtx[t] = [];
          schemaCtx[t].push(c);
        }
        const schemaText = Object.entries(schemaCtx).map(([t, cols]) => `${t}(${cols.join(", ")})`).join("\n");

        // 2. Call LLM
        const llmRes = await fetch(config.llmEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.llmApiKey}`,
          },
          body: JSON.stringify({
            model: config.llmModel,
            messages: [
              { role: "system", content: `You are a PostgreSQL SQL expert. Given the database schema below, generate ONLY the SQL query. No explanation, just SQL.\n\nSchema:\n${schemaText}` },
              { role: "user", content: prompt },
            ],
            temperature: 0,
            max_tokens: 2048,
          }),
        });

        if (!llmRes.ok) {
          const errText = await llmRes.text();
          return { content: [{ type: "text", text: `❌ LLM error: ${errText}` }] };
        }

        const llmData = await llmRes.json() as { choices: Array<{ message: { content: string } }> };
        const sql = llmData.choices?.[0]?.message?.content?.trim() || "No response";

        return { content: [{ type: "text", text: `\`\`\`sql\n${sql}\n\`\`\`` }] };
      } catch (e: unknown) {
        return { content: [{ type: "text", text: `❌ Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    });

    server.tool("ai_explain_query", "Explain a SQL query's execution plan with optimization suggestions", {
      ...refParam,
      sql: z.string().describe("SQL query to analyze"),
    }, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const sqlStr = args.sql as string;

      try {
        const db = await getDb(ref);
        const plan = await db.unsafe(`EXPLAIN (ANALYZE false, FORMAT TEXT) ${sqlStr}`);
        const planText = (plan as Array<Record<string, string>>).map(r => r["QUERY PLAN"]).join("\n");

        // Call LLM for explanation
        const llmRes = await fetch(config.llmEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.llmApiKey}`,
          },
          body: JSON.stringify({
            model: config.llmModel,
            messages: [
              { role: "system", content: "You are a PostgreSQL performance expert. Explain the query plan and suggest optimizations. Be concise." },
              { role: "user", content: `Query:\n${sqlStr}\n\nExecution Plan:\n${planText}` },
            ],
            temperature: 0,
            max_tokens: 2048,
          }),
        });

        const llmData = await llmRes.json() as { choices: Array<{ message: { content: string } }> };
        const explanation = llmData.choices?.[0]?.message?.content?.trim() || "No response";

        return { content: [{ type: "text", text: `**Execution Plan:**\n\`\`\`\n${planText}\n\`\`\`\n\n**Analysis:**\n${explanation}` }] };
      } catch (e: unknown) {
        return { content: [{ type: "text", text: `❌ Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    });
  }

  // ═══════════════════════════════════════════════
  // Auth Providers
  // ═══════════════════════════════════════════════

  server.tool("list_auth_providers", "List OAuth providers and their enabled status", refParam, READONLY_HINT, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const settings = await projectService.getProjectSettings(ref);
    if (!settings) return { content: [{ type: "text", text: "❌ Not found" }] };
    const external = (settings.auth as Record<string, unknown>)?.external || {};
    const result: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(external)) {
      result[k] = !!(v as Record<string, unknown>)?.client_id;
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  if (isAdmin || !readOnly) {
    server.tool("configure_auth_provider", "Configure an OAuth provider", {
      ...refParam,
      provider: z.string().describe("Provider (github, google, apple, wechat, etc.)"),
      client_id: z.string().describe("OAuth Client ID"),
      client_secret: z.string().describe("OAuth Client Secret"),
      redirect_uri: z.string().optional().describe("Redirect URI"),
    }, DESTRUCTIVE_HINT, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const settings = await projectService.getProjectSettings(ref);
      if (!settings) return { content: [{ type: "text", text: "❌ Not found" }] };
      const auth = (settings.auth as Record<string, unknown>) || {};
      const external = (auth.external || {}) as Record<string, unknown>;
      external[(args.provider as string)] = {
        client_id: args.client_id as string,
        client_secret: args.client_secret as string,
        redirect_uri: args.redirect_uri as string | undefined,
      };
      await projectService.updateProjectSettings(ref, { ...settings, auth: { ...auth, external } });
      return { content: [{ type: "text", text: `✅ Provider ${(args.provider as string)} configured` }] };
    });

    server.tool("disable_auth_provider", "Disable an OAuth provider", {
      ...refParam,
      provider: z.string().describe("Provider name"),
    }, DESTRUCTIVE_HINT, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const settings = await projectService.getProjectSettings(ref);
      if (!settings) return { content: [{ type: "text", text: "❌ Not found" }] };
      const auth = (settings.auth as Record<string, unknown>) || {};
      const external = { ...((auth.external || {}) as Record<string, unknown>) };
      delete external[(args.provider as string)];
      await projectService.updateProjectSettings(ref, { ...settings, auth: { ...auth, external } });
      return { content: [{ type: "text", text: `✅ Provider ${(args.provider as string)} disabled` }] };
    });
  }

  // ═══════════════════════════════════════════════
  // Storage
  // ═══════════════════════════════════════════════

  server.tool("get_storage_status", "Get storage backend status", {}, async () => {
    const status = await StorageService.getStatus();
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  });

  server.tool("list_storage_buckets", "List storage buckets for a project", refParam, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const buckets = await StorageService.listBuckets(ref);
    return { content: [{ type: "text", text: JSON.stringify(buckets, null, 2) }] };
  });

  server.tool("list_storage_files", "List files in a bucket", {
    ...refParam,
    bucket: z.string().describe("Bucket name"),
  }, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const files = await StorageService.listFiles(ref, args.bucket as string);
    return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
  });

  // ═══════════════════════════════════════════════
  // Secrets (admin or non-readonly)
  // ═══════════════════════════════════════════════

  server.tool("list_secrets", "List project secrets (env vars)", refParam, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const secrets = await projectService.getSecrets(ref);
    return { content: [{ type: "text", text: JSON.stringify(secrets, null, 2) }] };
  });

  if (isAdmin || !readOnly) {
    server.tool("upsert_secrets", "Create or update secrets", {
      ...refParam,
      secrets: z.array(z.object({ name: z.string(), value: z.string() })).describe("Secrets to set"),
    }, DESTRUCTIVE_HINT, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const ok = await projectService.upsertSecrets(ref, args.secrets as { name: string; value: string }[]);
      return { content: [{ type: "text", text: ok ? `✅ ${(args.secrets as unknown[]).length} secret(s) updated` : "❌ Failed" }] };
    });

    server.tool("delete_secret", "Delete a secret", {
      ...refParam,
      name: z.string().describe("Secret name"),
    }, DESTRUCTIVE_HINT, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const ok = await projectService.deleteSecret(ref, args.name as string);
      return { content: [{ type: "text", text: ok ? `✅ Deleted ${args.name as string}` : "❌ Failed" }] };
    });
  }

  // ═══════════════════════════════════════════════
  // Edge Functions
  // ═══════════════════════════════════════════════

  server.tool("list_edge_functions", "List Edge Functions", refParam, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const fns = await projectService.listFunctions(ref);
    return { content: [{ type: "text", text: JSON.stringify(fns, null, 2) }] };
  });

  if (isAdmin || !readOnly) {
    server.tool("deploy_edge_function", "Deploy an Edge Function", {
      ...refParam,
      slug: z.string().describe("Function name"),
      code: z.string().describe("TypeScript source code"),
    }, DESTRUCTIVE_HINT, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const ok = await projectService.deployFunction(ref, (args.slug as string), (args.code as string));
      return { content: [{ type: "text", text: ok ? `✅ ${(args.slug as string)} deployed` : "❌ Deploy failed" }] };
    });

    server.tool("delete_edge_function", "Delete an Edge Function", {
      ...refParam,
      slug: z.string().describe("Function name"),
    }, DESTRUCTIVE_HINT, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const ok = await projectService.deleteFunction(ref, (args.slug as string));
      return { content: [{ type: "text", text: ok ? `✅ ${(args.slug as string)} deleted` : "❌ Failed" }] };
    });
  }

  // ═══════════════════════════════════════════════
  // Backups
  // ═══════════════════════════════════════════════

  server.tool("list_backups", "List database backups", refParam, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const backups = await projectService.listBackups(ref);
    return { content: [{ type: "text", text: JSON.stringify(backups, null, 2) }] };
  });
}
