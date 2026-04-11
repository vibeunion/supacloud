/**
 * Database Webhooks & Auth Hooks Management API
 * 
 * P0-1: Database Webhooks CRUD
 * P0-2: Auth Hooks configuration
 * 
 * These operate on the supabase_functions.hooks table and auth hook configs
 * to provide Studio compatibility for Database > Webhooks and Auth > Hooks pages.
 */
import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { db } from "../db";
import { getProjectDb } from "../db";
import { sql as metaSql } from "../db";
import { logger } from "../utils/logger";

export const authHooksRoutes = new Elysia({ prefix: "/v1/projects" })

  // ════════════════════════════════════════════════════════
  // DATABASE WEBHOOKS — supabase_functions.hooks table
  // ════════════════════════════════════════════════════════

  // List all database webhooks
  .get(
    "/:ref/database/webhooks",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { error: "Project not found" });

      try {
        const dbName = `supa_${params.ref}`;
        const result = await db.executeQuery(dbName, `
          SELECT id, hook_table_id, hook_name, created_at, request_id, is_rls_enabled
          FROM supabase_functions.hooks
          ORDER BY created_at DESC
        `);
        return (result as { rows?: unknown[] }).rows || [];
      } catch (err) {
        logger.warn("[auth-hooks] Failed to list webhooks", { error: err });
        return [];
      }
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Create a database webhook
  .post(
    "/:ref/database/webhooks",
    async ({ params, body, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { error: "Project not found" });

      try {
        const dbName = `supa_${params.ref}`;
        const result = await db.executeQuery(dbName, `
          INSERT INTO supabase_functions.hooks (hook_table_id, hook_name, is_rls_enabled)
          VALUES (${Number(body.hook_table_id)}, '${body.hook_name.replace(/'/g, "''")}', ${body.is_rls_enabled ?? false})
          RETURNING *
        `);
        return ((result as { rows?: unknown[] }).rows || [])[0] || {};
      } catch (err: unknown) {
        return status(500, { error: "Failed to create webhook", message: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        hook_table_id: t.Number(),
        hook_name: t.String(),
        is_rls_enabled: t.Optional(t.Boolean())
      })
    }
  )

  // Get a specific database webhook
  .get(
    "/:ref/database/webhooks/:id",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { error: "Project not found" });

      try {
        const dbName = `supa_${params.ref}`;
        const result = await db.executeQuery(dbName, `
          SELECT * FROM supabase_functions.hooks WHERE id = ${Number(params.id)}
        `);
        const rows = (result as { rows?: unknown[] }).rows || [];
        if (rows.length === 0) return status(404, { error: "Webhook not found" });
        return rows[0];
      } catch (err: unknown) {
        return status(500, { error: "Failed to get webhook", message: err instanceof Error ? err.message : String(err) });
      }
    },
    { params: t.Object({ ref: t.String(), id: t.String() }) }
  )

  // Update a database webhook
  .patch(
    "/:ref/database/webhooks/:id",
    async ({ params, body, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { error: "Project not found" });

      try {
        const dbName = `supa_${params.ref}`;
        const setClauses: string[] = [];
        if (body.hook_name !== undefined) setClauses.push(`hook_name = '${body.hook_name.replace(/'/g, "''")}'`);
        if (body.is_rls_enabled !== undefined) setClauses.push(`is_rls_enabled = ${body.is_rls_enabled}`);
        if (body.hook_table_id !== undefined) setClauses.push(`hook_table_id = ${Number(body.hook_table_id)}`);

        if (setClauses.length === 0) return status(400, { error: "No fields to update" });

        const result = await db.executeQuery(dbName, `
          UPDATE supabase_functions.hooks SET ${setClauses.join(', ')} WHERE id = ${Number(params.id)} RETURNING *
        `);
        const rows = (result as { rows?: unknown[] }).rows || [];
        if (rows.length === 0) return status(404, { error: "Webhook not found" });
        return rows[0];
      } catch (err: unknown) {
        return status(500, { error: "Failed to update webhook", message: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      params: t.Object({ ref: t.String(), id: t.String() }),
      body: t.Object({
        hook_name: t.Optional(t.String()),
        hook_table_id: t.Optional(t.Number()),
        is_rls_enabled: t.Optional(t.Boolean())
      })
    }
  )

  // Delete a database webhook
  .delete(
    "/:ref/database/webhooks/:id",
    async ({ params, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { error: "Project not found" });

      try {
        const dbName = `supa_${params.ref}`;
        await db.executeQuery(dbName, `DELETE FROM supabase_functions.hooks WHERE id = ${Number(params.id)}`);
        return { success: true };
      } catch (err: unknown) {
        return status(500, { error: "Failed to delete webhook", message: err instanceof Error ? err.message : String(err) });
      }
    },
    { params: t.Object({ ref: t.String(), id: t.String() }) }
  )

  // ════════════════════════════════════════════════════════
  // AUTH HOOKS — GoTrue hook configuration
  // custom_access_token_hook, mfa_verification_hook,
  // password_verification_hook, send_sms_hook, send_email_hook
  // ════════════════════════════════════════════════════════

  // List all auth hooks config
  .get(
    "/:ref/auth/hooks",
    async ({ params }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return status(404, { error: "Project not found" });

      const authConfig = (settings.auth as Record<string, unknown>) || {};
      const hooks = (authConfig.hooks as Record<string, unknown>) || {};

      return {
        custom_access_token_hook: hooks.custom_access_token_hook || { enabled: false },
        mfa_verification_hook: hooks.mfa_verification_hook || { enabled: false },
        password_verification_hook: hooks.password_verification_hook || { enabled: false },
        send_sms_hook: hooks.send_sms_hook || { enabled: false },
        send_email_hook: hooks.send_email_hook || { enabled: false },
      };
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Update auth hooks config
  .patch(
    "/:ref/auth/hooks",
    async ({ params, body }) => {
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return status(404, { error: "Project not found" });

      const authConfig = (settings.auth as Record<string, unknown>) || {};
      const currentHooks = (authConfig.hooks as Record<string, unknown>) || {};

      const updatedHooks = {
        ...currentHooks,
        ...(typeof body === "object" ? body : {}),
      };

      await projectService.updateProjectSettings(params.ref, {
        ...settings,
        auth: {
          ...authConfig,
          hooks: updatedHooks,
        },
      });

      return updatedHooks;
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
    }
  );
