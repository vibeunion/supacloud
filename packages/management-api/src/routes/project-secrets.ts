import { Elysia, t, status } from "elysia";
import { projectService } from "../services";

export const projectSecretsRoutes = new Elysia({ prefix: "/v1/projects" })
  // Get environment variables (Secrets)
  .get(
    "/:ref/secrets",
    async ({ params }) => {
      const secrets = await projectService.getSecrets(params.ref);
      if (!secrets) {
        return status(404, { error: "Project not found" });
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
    async ({ params, body }) => {
      const success = await projectService.upsertSecrets(params.ref, body as { name: string; value: string }[]);
      if (!success) {
        return status(500, { error: "Failed to update secrets" });
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
    async ({ params }) => {
      const success = await projectService.deleteSecret(params.ref, params.name);
      if (!success) {
        return status(500, { error: "Failed to delete secret" });
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
        name: t.String(),
      }),
    }
  );
