import { Elysia, t, status } from "elysia";
import { projectService } from "../services";

export const projectFunctionsRoutes = new Elysia({ prefix: "/v1/projects" })
  // Get function list
  .get(
    "/:ref/functions",
    async ({ params }) => {
      const functions = await projectService.listFunctions(params.ref);
      return functions;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  // Get function code
  .get(
    "/:ref/functions/:slug",
    async ({ params }) => {
      const code = await projectService.getFunctionCode(params.ref, params.slug);
      if (code === null) {
        return status(404, { error: "Function not found" });
      }
      return { code };
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
      }),
    }
  )

  // Deploy function code
  .post(
    "/:ref/functions/:slug",
    async ({ params, body }) => {
      const success = await projectService.deployFunction(params.ref, params.slug, body.code);
      if (!success) {
        return status(500, { error: "Failed to deploy function" });
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
      }),
      body: t.Object({
        code: t.String(),
      }),
    }
  )

  // Delete function code
  .delete(
    "/:ref/functions/:slug",
    async ({ params }) => {
      const success = await projectService.deleteFunction(params.ref, params.slug);
      if (!success) {
        return status(500, { error: "Failed to delete function" });
      }
      return { success: true };
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
      }),
    }
  );
