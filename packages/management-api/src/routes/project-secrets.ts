import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { getAuthContext } from "../middleware/auth";
import { runtimeEnvService } from "../services/runtime-env.service";

export const projectSecretsRoutes = new Elysia({ prefix: "/v1/projects" })
  .get(
    "/:ref/internal/runtime-env",
    async ({ params, request }) => {
      const auth = await getAuthContext(request);
      if ("status" in auth) return status(auth.status, auth.body);
      if (auth.role !== "master") return status(403, { message: "Master token required", code: "403" });

      const env = await runtimeEnvService.buildProjectRuntimeEnv(params.ref);
      if (!env) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return env;
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get project runtime environment" },
    },
  )

  .get(
    "/:ref/secrets",
    async ({ params, query, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const reveal = query.reveal === "true";

      const secrets = await projectService.getSecrets(params.ref);
      if (!secrets) {
        return status(404, { message: "Project not found", code: "404" });
      }
      return secrets.map((s: { name: string; value: string }) => ({
        name: s.name,
        value: reveal ? s.value : "********",
      }));
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Object({ reveal: t.Optional(t.String()) }),
      detail: { tags: ["projects"], summary: "List project secrets" },
    },
  )

  .post(
    "/:ref/secrets",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const reserved = (body as { name: string; value: string }[]).filter((s) =>
        s.name.toUpperCase().startsWith("SUPABASE_"),
      );
      if (reserved.length > 0) {
        return status(400, {
          message: `Secret names starting with SUPABASE_ are reserved: ${reserved.map((s) => s.name).join(", ")}`,
          code: "400",
        });
      }

      const success = await projectService.upsertSecrets(
        params.ref,
        body as { name: string; value: string }[],
      );
      if (!success) {
        return status(500, { message: "Failed to update secrets", code: "500" });
      }
      return {};
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Array(
        t.Object({
          name: t.String({ maxLength: 256 }),
          value: t.String({ maxLength: 24576 }),
        }),
      ),
      detail: { tags: ["projects"], summary: "Create or update project secrets" },
    },
  )

  .delete(
    "/:ref/secrets",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      if (!body || !Array.isArray(body) || body.length === 0) {
        return status(400, {
          message: "Body must be a non-empty array of secret name strings",
          code: "400",
        });
      }
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
      return {};
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Array(t.Union([t.String(), t.Object({ name: t.String() })])),
      detail: { tags: ["projects"], summary: "Bulk delete project secrets" },
    },
  )

  .delete(
    "/:ref/secrets/:name",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const success = await projectService.deleteSecret(params.ref, params.name);
      if (!success) {
        return status(500, { message: "Failed to delete secret", code: "500" });
      }
      return {};
    },
    {
      params: t.Object({ ref: t.String(), name: t.String() }),
      detail: { tags: ["projects"], summary: "Delete a project secret by name" },
    },
  );
