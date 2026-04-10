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

  // Get function code (bundled runtime version)
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

  // Get function source code (original, for debugging)
  .get(
    "/:ref/functions/:slug/source",
    async ({ params }) => {
      const { edgeFunctionService } = await import("../services/edge-function.service");
      const code = await edgeFunctionService.readSource(params.ref, params.slug);
      if (code === null) {
        return status(404, { error: "Source not found" });
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

  // Deploy single-file function code (server-side bundling)
  .post(
    "/:ref/functions/:slug",
    async ({ params, body }) => {
      const success = await projectService.deployFunction(
        params.ref, params.slug, body.code, body.minify ?? false
      );
      if (!success) {
        return status(500, { error: "Failed to deploy function" });
      }
      return { success: true, bundled: true };
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
      }),
      body: t.Object({
        code: t.String(),
        minify: t.Optional(t.Boolean()),
      }),
    }
  )

  // Deploy multi-file function bundle (directory upload with server-side bundling)
  .post(
    "/:ref/functions/:slug/bundle",
    async ({ params, body }) => {
      const success = await projectService.deployFunctionBundle(
        params.ref,
        params.slug,
        body.files,
        body.entrypoint ?? "index.ts",
        body.minify ?? false,
      );
      if (!success) {
        return status(500, { error: "Failed to deploy function bundle" });
      }
      return {
        success: true,
        bundled: true,
        files: Object.keys(body.files).length,
      };
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
      }),
      body: t.Object({
        files: t.Record(t.String(), t.String()),
        entrypoint: t.Optional(t.String()),
        minify: t.Optional(t.Boolean()),
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
  )

  // Get function config (verify_jwt, etc.)
  .get(
    "/:ref/functions/:slug/config",
    async ({ params }) => {
      const { edgeFunctionService } = await import("../services/edge-function.service");
      const config = await edgeFunctionService.getConfig(params.ref, params.slug);
      return config;
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
      }),
    }
  )

  // Update function config (verify_jwt, etc.)
  .patch(
    "/:ref/functions/:slug/config",
    async ({ params, body }) => {
      const { edgeFunctionService } = await import("../services/edge-function.service");
      const updated = await edgeFunctionService.updateConfig(params.ref, params.slug, body);
      return updated;
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
      }),
      body: t.Object({
        verify_jwt: t.Optional(t.Boolean()),
      }),
    }
  );
