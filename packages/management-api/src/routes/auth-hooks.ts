import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { resolveDbName, getProjectDb } from "../db";
import { logger } from "../utils/logger";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { getAuthRuntimeManagedError } from "../services/auth-runtime.service";

export const authHooksRoutes = new Elysia({ prefix: "/v1/projects" })

  .get(
    "/:ref/database/webhooks",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found", code: "404" });

      try {
        const dbName = await resolveDbName(params.ref);
        const db = getProjectDb(dbName);
        const rows = await db`
          SELECT id, hook_table_id, hook_name, hook_schema, hook_table, request_url, request_headers, events, created_at, updated_at, is_rls_enabled
          FROM supabase_functions.hooks
          ORDER BY created_at DESC
        `;
        return rows;
      } catch (err) {
        logger.warn("[auth-hooks] Failed to list webhooks", { error: err });
        return [];
      }
    },
    { params: t.Object({ ref: t.String() }), detail: { tags: ["auth"], summary: "List database webhooks" } }
  )

  .post(
    "/:ref/database/webhooks",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found", code: "404" });

      try {
        const dbName = await resolveDbName(params.ref);
        const db = getProjectDb(dbName);
        const hookTableId = (body as Record<string, unknown>).hook_table_id || (body as Record<string, unknown>).table_id;
        const hookName = (body as Record<string, unknown>).hook_name as string;
        const hookSchema = (body as Record<string, unknown>).hook_schema || (body as Record<string, unknown>).schema_name || 'public';
        const hookTable = (body as Record<string, unknown>).hook_table || (body as Record<string, unknown>).table_name || '';
        const requestUrl = (body as Record<string, unknown>).request_url || (body as Record<string, unknown>).hook_url || '';
        const requestHeaders = (body as Record<string, unknown>).request_headers || {};
        const events = (body as Record<string, unknown>).events || [];
        const isRlsEnabled = (body as Record<string, unknown>).is_rls_enabled ?? (body as Record<string, unknown>).is_enabled ?? false;
        const rows = await db`
          INSERT INTO supabase_functions.hooks (hook_table_id, hook_name, hook_schema, hook_table, request_url, request_headers, events, is_rls_enabled)
          VALUES (${hookTableId}, ${hookName}, ${hookSchema}, ${hookTable}, ${requestUrl}, ${JSON.stringify(requestHeaders)}, ${events}, ${isRlsEnabled})
          RETURNING *
        `;
        return rows[0] || {};
      } catch (err: unknown) {
        return status(500, { message: "Failed to create webhook", code: "500", details: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        hook_table_id: t.Optional(t.Number()),
        table_id: t.Optional(t.Number()),
        hook_name: t.String(),
        hook_schema: t.Optional(t.String()),
        schema_name: t.Optional(t.String()),
        hook_table: t.Optional(t.String()),
        table_name: t.Optional(t.String()),
        request_url: t.Optional(t.String()),
        hook_url: t.Optional(t.String()),
        request_headers: t.Optional(t.Record(t.String(), t.String())),
        events: t.Optional(t.Array(t.String())),
        is_rls_enabled: t.Optional(t.Boolean()),
        is_enabled: t.Optional(t.Boolean()),
      }),
      detail: { tags: ["auth"], summary: "Create database webhook" },
    }
  )

  .get(
    "/:ref/database/webhooks/:id",
    async ({ params }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found", code: "404" });

      try {
        const dbName = await resolveDbName(params.ref);
        const db = getProjectDb(dbName);
        const rows = await db`SELECT * FROM supabase_functions.hooks WHERE id = ${Number(params.id)}`;
        if (rows.length === 0) return status(404, { message: "Webhook not found", code: "404" });
        return rows[0];
      } catch (err: unknown) {
        return status(500, { message: "Failed to get webhook", code: "500", details: err instanceof Error ? err.message : String(err) });
      }
    },
    { params: t.Object({ ref: t.String(), id: t.String() }), detail: { tags: ["auth"], summary: "Get database webhook" } }
  )

  .patch(
    "/:ref/database/webhooks/:id",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found", code: "404" });

      try {
        const dbName = await resolveDbName(params.ref);
        const db = getProjectDb(dbName);
        const current = await db`SELECT * FROM supabase_functions.hooks WHERE id = ${Number(params.id)}`;
        if (current.length === 0) return status(404, { message: "Webhook not found", code: "404" });

        const existing = current[0] as Record<string, unknown>;
        const updated = await db`
          UPDATE supabase_functions.hooks SET
            hook_name = ${body.hook_name ?? existing.hook_name},
            hook_schema = ${body.hook_schema ?? existing.hook_schema},
            hook_table = ${body.hook_table ?? existing.hook_table},
            request_url = ${body.request_url ?? existing.request_url},
            request_headers = ${body.request_headers ? JSON.stringify(body.request_headers) : existing.request_headers},
            events = ${body.events ?? existing.events},
            is_rls_enabled = ${body.is_rls_enabled ?? existing.is_rls_enabled},
            updated_at = NOW()
          WHERE id = ${Number(params.id)}
          RETURNING *
        `;
        return updated[0];
      } catch (err: unknown) {
        return status(500, { message: "Failed to update webhook", code: "500", details: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      params: t.Object({ ref: t.String(), id: t.String() }),
      body: t.Object({
        hook_name: t.Optional(t.String()),
        hook_table_id: t.Optional(t.Number()),
        hook_schema: t.Optional(t.String()),
        hook_table: t.Optional(t.String()),
        request_url: t.Optional(t.String()),
        request_headers: t.Optional(t.Record(t.String(), t.String())),
        events: t.Optional(t.Array(t.String())),
        is_rls_enabled: t.Optional(t.Boolean()),
      }),
      detail: { tags: ["auth"], summary: "Update database webhook" },
    }
  )

  .delete(
    "/:ref/database/webhooks/:id",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const project = await projectService.getProject(params.ref);
      if (!project) return status(404, { message: "Project not found", code: "404" });

      try {
        const dbName = await resolveDbName(params.ref);
        const db = getProjectDb(dbName);
        const [deleted] = await db`DELETE FROM supabase_functions.hooks WHERE id = ${Number(params.id)} RETURNING *`;
        if (!deleted) return status(404, { message: "Webhook not found", code: "404" });
        return deleted;
      } catch (err: unknown) {
        return status(500, { message: "Failed to delete webhook", code: "500" });
      }
    },
    { params: t.Object({ ref: t.String(), id: t.String() }), detail: { tags: ["auth"], summary: "Delete database webhook" } }
  )

  .get(
    "/:ref/auth/hooks",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const managedError = getAuthRuntimeManagedError(params.ref, "configuration");
      if (managedError) return status(409, managedError);
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return status(404, { message: "Project not found", code: "404" });

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
    { params: t.Object({ ref: t.String() }), detail: { tags: ["auth"], summary: "List auth hooks" } }
  )

  .patch(
    "/:ref/auth/hooks",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const managedError = getAuthRuntimeManagedError(params.ref, "configuration");
      if (managedError) return status(409, managedError);
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return status(404, { message: "Project not found", code: "404" });

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
      detail: { tags: ["auth"], summary: "Update auth hooks" },
    }
  );
