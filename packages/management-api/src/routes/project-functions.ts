import { Elysia, t, status } from "elysia";
import { projectService } from "../services";

export const projectFunctionsRoutes = new Elysia({ prefix: "/v1/projects" })
  .get(
    "/:ref/functions",
    async ({ params }) => {
      const functions = await projectService.listFunctions(params.ref);
      return functions;
    },
    {
      params: t.Object({ ref: t.String() }),
    }
  )

  .post(
    "/:ref/functions",
    async ({ params, body }) => {
      const slug = body.slug;
      const code = body.body || body.code || '';
      if (!slug || !code) {
        return status(400, { error: "slug and body/code are required" });
      }

      const success = await projectService.deployFunction(
        params.ref, slug, code, false
      );
      if (!success) {
        return status(500, { error: "Failed to deploy function" });
      }

      if (typeof body.verify_jwt === 'boolean') {
        const { edgeFunctionService } = await import("../services/edge-function.service");
        await edgeFunctionService.updateConfig(params.ref, slug, { verify_jwt: body.verify_jwt });
      }

      const now = new Date().toISOString();
      return { id: slug, slug, name: body.name || slug, version: 1, verify_jwt: body.verify_jwt ?? true, status: "ACTIVE", created_at: now, updated_at: now };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        slug: t.String(),
        name: t.Optional(t.String()),
        body: t.Optional(t.String()),
        code: t.Optional(t.String()),
        verify_jwt: t.Optional(t.Boolean()),
      }),
    }
  )

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
      params: t.Object({ ref: t.String(), slug: t.String() }),
    }
  )

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
      params: t.Object({ ref: t.String(), slug: t.String() }),
    }
  )

  .post(
    "/:ref/functions/:slug",
    async ({ params, body }) => {
      const code = body.code || body.body || '';
      const success = await projectService.deployFunction(
        params.ref, params.slug, code, body.minify ?? false
      );
      if (!success) {
        return status(500, { error: "Failed to deploy function" });
      }
      return { success: true, bundled: true };
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      body: t.Object({
        code: t.Optional(t.String()),
        body: t.Optional(t.String()),
        minify: t.Optional(t.Boolean()),
      }),
    }
  )

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
      params: t.Object({ ref: t.String(), slug: t.String() }),
      body: t.Object({
        files: t.Record(t.String(), t.String()),
        entrypoint: t.Optional(t.String()),
        minify: t.Optional(t.Boolean()),
      }),
    }
  )

  .delete(
    "/:ref/functions",
    async ({ params, body }) => {
      const slug = body?.slug;
      if (!slug) {
        return status(400, { error: "slug is required in body" });
      }
      const success = await projectService.deleteFunction(params.ref, slug);
      if (!success) {
        return status(500, { error: "Failed to delete function" });
      }
      return { success: true };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({ slug: t.String() }),
    }
  )

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
      params: t.Object({ ref: t.String(), slug: t.String() }),
    }
  )

  .get(
    "/:ref/functions/:slug/config",
    async ({ params }) => {
      const { edgeFunctionService } = await import("../services/edge-function.service");
      const config = await edgeFunctionService.getConfig(params.ref, params.slug);
      return config;
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
    }
  )

  .patch(
    "/:ref/functions/:slug/config",
    async ({ params, body }) => {
      const { edgeFunctionService } = await import("../services/edge-function.service");
      const updated = await edgeFunctionService.updateConfig(params.ref, params.slug, body);
      return updated;
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      body: t.Object({
        verify_jwt: t.Optional(t.Boolean()),
      }),
    }
  );
