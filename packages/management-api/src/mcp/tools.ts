import { z } from "zod";
import { logger } from "../utils/logger";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { projectService } from "../services";
import { organizationService } from "../services/organization.service";
import { StorageService } from "../services/storage.service";
import { sql as metaSql } from "../db";
import { createMcpToken, type McpTokenPayload } from "./token";

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
    server.tool("list_projects", "List all Supabase projects", {}, async () => {
      const projects = await projectService.listProjects();
      return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
    });

    server.tool("create_project", "Create a new Supabase project", {
      name: z.string().describe("Project name"),
      region: z.string().default("local").describe("Region"),
      organization_id: z.string().optional().describe("Organization ID"),
    }, async ({ name, region, organization_id }: { name: string; region: string; organization_id?: string }) => {
      const project = await projectService.createProject({ name, region, organization_id });
      return { content: [{ type: "text", text: `✅ Project created\n${JSON.stringify(project, null, 2)}` }] };
    });

    server.tool("delete_project", "Delete a project (soft delete)", {
      ref: z.string().describe("Project ref"),
    }, async ({ ref }: { ref: string }) => {
      const ok = await projectService.deleteProject(ref);
      return { content: [{ type: "text", text: ok ? `✅ Project ${ref} deleted` : `❌ Delete failed` }] };
    });

    server.tool("list_organizations", "List all organizations", {}, async () => {
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

  server.tool("get_project", "Get project details", refParam, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const project = await projectService.getProject(ref);
    return { content: [{ type: "text", text: project ? JSON.stringify(project, null, 2) : "❌ Project not found" }] };
  });

  server.tool("get_project_health", "Get project health and service status", refParam, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const health = await projectService.getProjectHealth(ref);
    return { content: [{ type: "text", text: health ? JSON.stringify(health, null, 2) : "❌ Project not found" }] };
  });

  server.tool("get_project_settings", "Get project configuration", refParam, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const settings = await projectService.getProjectSettings(ref);
    return { content: [{ type: "text", text: settings ? JSON.stringify(settings, null, 2) : "❌ Not found" }] };
  });

  server.tool("get_api_keys", "Get project API keys (anon_key, service_role_key)", refParam, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const keys = await projectService.getApiKeys(ref);
    return { content: [{ type: "text", text: keys ? JSON.stringify(keys, null, 2) : "❌ Not found" }] };
  });

  server.tool("list_project_tasks", "List provisioning/cleanup tasks for a project", refParam, async (args: Record<string, unknown>) => {
    const ref = resolveRef(args.ref as string | undefined);
    const tasks = await metaSql`SELECT * FROM project_tasks WHERE project_ref = ${ref} ORDER BY created_at DESC LIMIT 50`;
    return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
  });

  // ═══════════════════════════════════════════════
  // Project Actions (admin or non-readonly project)
  // ═══════════════════════════════════════════════

  if (isAdmin || !readOnly) {
    server.tool("pause_project", "Pause a project to release resources", refParam, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const ok = await projectService.pauseProject(ref);
      return { content: [{ type: "text", text: ok ? `✅ ${ref} paused` : "❌ Failed" }] };
    });

    server.tool("restore_project", "Restore a paused project", refParam, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const ok = await projectService.restoreProject(ref);
      return { content: [{ type: "text", text: ok ? `✅ ${ref} restored` : "❌ Failed" }] };
    });

    server.tool("restart_project", "Restart all services for a project", refParam, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const ok = await projectService.restartProject(ref);
      return { content: [{ type: "text", text: ok ? "✅ Restart complete" : "❌ Failed" }] };
    });

    server.tool("update_project_settings", "Update project configuration", {
      ...refParam,
      settings: z.record(z.unknown()).describe("Config fields to update"),
    }, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const result = await projectService.updateProjectSettings(ref, args.settings as Record<string, unknown>);
      return { content: [{ type: "text", text: result ? `✅ Updated\n${JSON.stringify(result, null, 2)}` : "❌ Failed" }] };
    });

    server.tool("rotate_api_keys", "Rotate project API keys", refParam, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const keys = await projectService.rotateApiKeys(ref);
      return { content: [{ type: "text", text: keys ? `✅ Keys rotated\n${JSON.stringify(keys, null, 2)}` : "❌ Failed" }] };
    });
  }

  // ═══════════════════════════════════════════════
  // Database (SQL execution)
  // ═══════════════════════════════════════════════

  server.tool("execute_sql", readOnly
    ? "Execute read-only SQL (SELECT only) on project database"
    : "Execute SQL on project database", {
    ...refParam,
    sql: z.string().describe("SQL query"),
  }, async (args: Record<string, unknown>) => {
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

    // Execute via project's database
    const project = await projectService.getProject(ref);
    if (!project) return { content: [{ type: "text", text: "❌ Project not found" }] };

    try {
      const { SQL } = await import("bun");
      const dbName = `supa_${ref}`;
      const db = new SQL({
        hostname: process.env.PG_HOST || "localhost",
        port: parseInt(process.env.PG_PORT || "5432"),
        database: dbName,
        username: process.env.PG_USER || "postgres",
        password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || "postgres",
      });
      try {
        const rows = await db.unsafe(sqlStr);
        return { content: [{ type: "text", text: `✅ ${Array.isArray(rows) ? rows.length : 0} row(s)\n${JSON.stringify(rows, null, 2)}` }] };
      } finally {
        await db.close();
      }
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `❌ SQL error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  });

  // ═══════════════════════════════════════════════
  // Auth Providers
  // ═══════════════════════════════════════════════

  server.tool("list_auth_providers", "List OAuth providers and their enabled status", refParam, async (args: Record<string, unknown>) => {
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
    }, async (args: Record<string, unknown>) => {
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
    }, async (args: Record<string, unknown>) => {
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
    }, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const ok = await projectService.upsertSecrets(ref, args.secrets as { name: string; value: string }[]);
      return { content: [{ type: "text", text: ok ? `✅ ${(args.secrets as unknown[]).length} secret(s) updated` : "❌ Failed" }] };
    });

    server.tool("delete_secret", "Delete a secret", {
      ...refParam,
      name: z.string().describe("Secret name"),
    }, async (args: Record<string, unknown>) => {
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
    }, async (args: Record<string, unknown>) => {
      const ref = resolveRef(args.ref as string | undefined);
      const ok = await projectService.deployFunction(ref, (args.slug as string), (args.code as string));
      return { content: [{ type: "text", text: ok ? `✅ ${(args.slug as string)} deployed` : "❌ Deploy failed" }] };
    });

    server.tool("delete_edge_function", "Delete an Edge Function", {
      ...refParam,
      slug: z.string().describe("Function name"),
    }, async (args: Record<string, unknown>) => {
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
