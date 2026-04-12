import { Elysia, t, status } from "elysia";
import { projectService } from "../services";

export const projectSecretsRoutes = new Elysia({ prefix: "/v1/projects" })
  // Get environment variables (Secrets)
  .get(
    "/:ref/secrets",
    async ({ params }) => {
      const secrets = await projectService.getSecrets(params.ref);
      if (!secrets) {
        return status(404, { message: "Project not found", code: "400" });
      }
      // Return name + value + updated_at to match official Supabase Management API
      return secrets.map((s: { name: string; value: string }) => ({
        name: s.name,
        value: s.value,
        updated_at: new Date().toISOString(),
      }));
    },
    {
      params: t.Object({ ref: t.String() }),
    },
  )

  // Set environment variables
  .post(
    "/:ref/secrets",
    async ({ params, body }) => {
      // Block SUPABASE_* prefix (reserved for system-injected variables)
      const reserved = (body as { name: string; value: string }[]).filter((s) =>
        s.name.toUpperCase().startsWith("SUPABASE_"),
      );
      if (reserved.length > 0) {
        return status(400, {
          error: `Secret names starting with SUPABASE_ are reserved: ${reserved.map((s) => s.name).join(", ")}`,
        });
      }

      const success = await projectService.upsertSecrets(
        params.ref,
        body as { name: string; value: string }[],
      );
      if (!success) {
        return status(500, { message: "Failed to update secrets", code: "400" });
      }
      return { success: true };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Array(
        t.Object({
          name: t.String({ maxLength: 256 }),
          value: t.String({ maxLength: 24576 }),
        }),
      ),
    },
  )

  // Bulk delete environment variables
  .delete(
    "/:ref/secrets",
    async ({ params, body }) => {
      if (!body || !Array.isArray(body) || body.length === 0) {
        return status(400, {
          error: "Body must be a non-empty array of secret name strings",
        });
      }
      // Support both string[] (official format) and {name}[] (legacy compat)
      const names = (body as Array<string | { name: string }>).map((item) =>
        typeof item === "string" ? item : item.name,
      );
      const results = await Promise.all(
        names.map((name) => projectService.deleteSecret(params.ref, name)),
      );
      const failed = results.filter((r) => !r).length;
      if (failed > 0) {
        return status(500, { message: `Failed to delete ${failed} secret(s)`, code: "500" });
      }
      return { success: true };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Array(t.Union([t.String(), t.Object({ name: t.String() })])),
    },
  )

  // Delete environment variable
  .delete(
    "/:ref/secrets/:name",
    async ({ params }) => {
      const success = await projectService.deleteSecret(
        params.ref,
        params.name,
      );
      if (!success) {
        return status(500, { message: "Failed to delete secret", code: "400" });
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
        name: t.String(),
      }),
    },
  );
