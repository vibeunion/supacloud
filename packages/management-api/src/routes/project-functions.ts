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
    },
  )

  // GET /v1/projects/:ref/functions/secrets
  // Alias for secrets endpoint — Supabase Studio and some SDK versions call this path
  .get(
    "/:ref/functions/secrets",
    async ({ params, query }) => {
      const { projectService: svc } = await import("../services");
      const secrets = await svc.getSecrets(params.ref);
      if (!secrets) {
        return status(404, { message: "Project not found" });
      }
      const reveal = query.reveal === "true";
      return secrets.map(
        (s: { name: string; value: string; updated_at?: string }) => ({
          name: s.name,
          value: reveal ? s.value : "********",
          updated_at: s.updated_at ?? new Date().toISOString(),
        }),
      );
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Object({ reveal: t.Optional(t.String()) }),
    },
  )

  // Deploy via multipart/form-data (supabase CLI format)
  // POST /v1/projects/:ref/functions/deploy?slug=hello-world
  .post(
    "/:ref/functions/deploy",
    async ({ params, body, query }) => {
      const slug = (query as Record<string, string>).slug;
      if (!slug) {
        return status(400, {
          message: "slug query parameter is required",
          code: "400",
        });
      }

      // Parse metadata JSON string
      const metadata: {
        entrypoint_path?: string;
        import_map_path?: string;
        verify_jwt?: boolean;
        background_routes?: string[];
        name?: string;
      } = {};
      if (body.metadata) {
        try {
          const raw =
            typeof body.metadata === "string"
              ? body.metadata
              : body.metadata instanceof Blob
                ? await (body.metadata as Blob).text()
                : JSON.stringify(body.metadata);
          Object.assign(metadata, JSON.parse(raw));
        } catch {
          /* ignore metadata parse errors */
        }
      }

      // Collect all uploaded files (the `file` field can be single or multiple)
      const rawFiles = body.file;
      const fileList: File[] = rawFiles
        ? Array.isArray(rawFiles)
          ? rawFiles
          : [rawFiles]
        : [];

      if (fileList.length === 0) {
        return status(400, {
          message: "No source files provided",
          code: "400",
        });
      }

      const entrypoint = metadata.entrypoint_path || "index.ts";

      // Build file map: { relativePath: content }
      const fileMap: Record<string, string> = {};
      for (const f of fileList) {
        const name = (f as File).name || entrypoint;
        fileMap[name] = await (f as File).text();
      }

      // Ensure entrypoint exists in file map
      if (!fileMap[entrypoint] && fileList.length > 0) {
        fileMap[entrypoint] = await fileList[0].text();
      }

      const result = await projectService.deployFunctionBundleDetailed(
        params.ref,
        slug,
        fileMap,
        entrypoint,
        false,
      );
      if (!result.success) {
        return status(500, {
          message: result.error || "Failed to deploy function bundle",
          code: "500",
          details: result,
        });
      }

      // Persist JWT setting from metadata
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      if (typeof metadata.verify_jwt === "boolean") {
        await edgeFunctionService.updateConfig(params.ref, slug, {
          verify_jwt: metadata.verify_jwt,
        });
      }

      if (Array.isArray(metadata.background_routes)) {
        await edgeFunctionService.updateConfig(params.ref, slug, {
          background_routes: metadata.background_routes.filter(
            (route): route is string =>
              typeof route === "string" && route.trim().length > 0,
          ),
        });
      }

      const funcConfig = await edgeFunctionService.getConfig(params.ref, slug);
      const version = Number.parseInt(funcConfig.version || "1", 10) || 1;
      const now = new Date().toISOString();
      return {
        id: slug,
        slug,
        name: metadata.name || slug,
        version: Number.parseInt(result.version || String(version), 10) || version,
        status: "ACTIVE",
        verify_jwt: funcConfig.verify_jwt,
        background_routes: funcConfig.background_routes || [],
        entrypoint_path: entrypoint,
        import_map: result.import_map != null || !!metadata.import_map_path,
        import_map_path: result.import_map ?? metadata.import_map_path ?? null,
        created_at: now,
        updated_at: now,
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Object(
        { slug: t.Optional(t.String()), bundleOnly: t.Optional(t.String()) },
        { additionalProperties: true },
      ),
      body: t.Object({
        metadata: t.Optional(t.Any()),
        file: t.Optional(t.Any()),
      }),
      type: "multipart",
    },
  )

  .post(
    "/:ref/functions",
    async ({ params, body, query }) => {
      // Support both JSON body and query param approaches (official Supabase Management API)
      const slug = body?.slug || (query as Record<string, string>).slug;
      const code = body?.body || body?.code || "";
      const name = body?.name || (query as Record<string, string>).name;
      const verifyJwt =
        body?.verify_jwt ??
        ((query as Record<string, string>).verify_jwt === "false"
          ? false
          : true);
      const backgroundRoutes = Array.isArray(body?.background_routes)
        ? body.background_routes.filter(
            (route): route is string =>
              typeof route === "string" && route.trim().length > 0,
          )
        : undefined;

      if (!slug) {
        return status(400, { message: "slug is required", code: "400" });
      }
      // Allow empty code for metadata-only creation
      if (code) {
        const result = await projectService.deployFunctionDetailed(
          params.ref,
          slug,
          code,
          false,
        );
        if (!result.success) {
          return status(500, {
            message: result.error || "Failed to deploy function",
            code: "500",
            details: result,
          });
        }
      }

      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      await edgeFunctionService.updateConfig(params.ref, slug, {
        verify_jwt: verifyJwt,
        ...(backgroundRoutes ? { background_routes: backgroundRoutes } : {}),
      });
      const funcConfig = await edgeFunctionService.getConfig(params.ref, slug);
      const version = Number.parseInt(funcConfig.version || "1", 10) || 1;

      const now = new Date().toISOString();
      return {
        id: slug,
        slug,
        name: name || slug,
        version,
        verify_jwt: verifyJwt,
        background_routes: funcConfig.background_routes || [],
        status: "ACTIVE",
        created_at: now,
        updated_at: now,
        entrypoint_path:
          (query as Record<string, string>).entrypoint_path || "index.ts",
        import_map: false,
        import_map_path: null,
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Object(
        {
          slug: t.Optional(t.String()),
          name: t.Optional(t.String()),
          verify_jwt: t.Optional(t.String()),
          entrypoint_path: t.Optional(t.String()),
          import_map_path: t.Optional(t.String()),
          background_routes: t.Optional(t.Array(t.String())),
        },
        { additionalProperties: true },
      ),
      body: t.Optional(
        t.Object({
          slug: t.Optional(t.String()),
          name: t.Optional(t.String()),
          body: t.Optional(t.String()),
          code: t.Optional(t.String()),
          verify_jwt: t.Optional(t.Boolean()),
          background_routes: t.Optional(t.Array(t.String())),
        }),
      ),
    },
  )

  // Bulk upsert functions (official Management API)
  .put(
    "/:ref/functions",
    async ({ params, body }) => {
      const results = [];
      for (const fn of body as Array<{
        slug: string;
        body?: string;
        code?: string;
        name?: string;
        verify_jwt?: boolean;
      }>) {
        const code = fn.body || fn.code || "";
        if (!fn.slug || !code) continue;

        const success = await projectService.deployFunction(
          params.ref,
          fn.slug,
          code,
          false,
        );
        if (success && typeof fn.verify_jwt === "boolean") {
          const { edgeFunctionService } =
            await import("../services/edge-function.service");
          await edgeFunctionService.updateConfig(params.ref, fn.slug, {
            verify_jwt: fn.verify_jwt,
          });
        }

        if (success && Array.isArray((fn as { background_routes?: unknown[] }).background_routes)) {
          const { edgeFunctionService } =
            await import("../services/edge-function.service");
          await edgeFunctionService.updateConfig(params.ref, fn.slug, {
            background_routes: ((fn as { background_routes?: unknown[] }).background_routes || []).filter(
              (route): route is string =>
                typeof route === "string" && route.trim().length > 0,
            ),
          });
        }

        const now = new Date().toISOString();
        results.push({
          slug: fn.slug,
          name: fn.name || fn.slug,
          success,
          updated_at: now,
        });
      }
      return results;
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Array(
        t.Object({
          slug: t.String(),
          name: t.Optional(t.String()),
          body: t.Optional(t.String()),
          code: t.Optional(t.String()),
          verify_jwt: t.Optional(t.Boolean()),
          background_routes: t.Optional(t.Array(t.String())),
        }),
      ),
    },
  )

  .get(
    "/:ref/functions/:slug",
    async ({ params }) => {
      const code = await projectService.getFunctionCode(
        params.ref,
        params.slug,
      );
      if (code === null) {
        return status(404, { message: "Function not found", code: "404" });
      }
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      const funcConfig = await edgeFunctionService.getConfig(
        params.ref,
        params.slug,
      );
      const version = Number.parseInt(funcConfig.version || "1", 10) || 1;
      const now = new Date().toISOString();
      return {
        id: params.slug,
        slug: params.slug,
        name: params.slug,
        version,
        status: "ACTIVE",
        verify_jwt: funcConfig.verify_jwt,
        background_routes: funcConfig.background_routes || [],
        entrypoint_path: `${params.slug}/index.ts`,
        import_map: false,
        import_map_path: null,
        created_at: now,
        updated_at: now,
        code,
      };
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
    },
  )

  .get(
    "/:ref/functions/:slug/source",
    async ({ params }) => {
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      const code = await edgeFunctionService.readSource(
        params.ref,
        params.slug,
      );
      if (code === null) {
        return status(404, { message: "Source not found", code: "404" });
      }
      return { code };
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
    },
  )

  .get(
    "/:ref/functions/:slug/versions",
    async ({ params }) => {
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      return edgeFunctionService.listVersions(params.ref, params.slug);
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
    },
  )

  .get(
    "/:ref/functions/:slug/versions/:version",
    async ({ params }) => {
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      const version = await edgeFunctionService.getVersion(
        params.ref,
        params.slug,
        params.version,
      );
      if (!version) {
        return status(404, { message: "Function version not found", code: "404" });
      }
      return version;
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
        version: t.String(),
      }),
    },
  )

  .post(
    "/:ref/functions/:slug/versions/:version/activate",
    async ({ params }) => {
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      const updated = await edgeFunctionService.activateVersion(
        params.ref,
        params.slug,
        params.version,
      );
      if (!updated) {
        return status(404, { message: "Function version not found", code: "404" });
      }
      return {
        success: true,
        version: params.version,
        config: updated,
      };
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
        version: t.String(),
      }),
    },
  )

  // Download function source body (supabase CLI compatibility)
  // Official: GET /v1/projects/:ref/functions/:slug/body → octet-stream
  .get(
    "/:ref/functions/:slug/body",
    async ({ params, set }) => {
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      // Prefer the original source TypeScript over bundled JS
      const src = await edgeFunctionService.readSource(params.ref, params.slug);
      if (src !== null) {
        set.headers["Content-Type"] = "application/octet-stream";
        set.headers["Content-Disposition"] =
          `attachment; filename="${params.slug}.ts"`;
        return src;
      }
      // Fall back to bundled output
      const bundled = await edgeFunctionService.read(params.ref, params.slug);
      if (bundled === null) {
        return status(404, { message: "Function not found", code: "404" });
      }
      set.headers["Content-Type"] = "application/octet-stream";
      set.headers["Content-Disposition"] =
        `attachment; filename="${params.slug}.js"`;
      return bundled;
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
    },
  )

  .post(
    "/:ref/functions/:slug",
    async ({ params, body }) => {
      const code = body.code || body.body || "";
      const success = await projectService.deployFunction(
        params.ref,
        params.slug,
        code,
        body.minify ?? false,
      );
      if (!success) {
        return status(500, {
          message: "Failed to deploy function",
          code: "500",
        });
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
    },
  )

  .patch(
    "/:ref/functions/:slug",
    async ({ params, body }) => {
      const { edgeFunctionService } =
        await import("../services/edge-function.service");

      // Update code if provided
      const code = body.code || body.body;
      if (code) {
        const success = await projectService.deployFunction(
          params.ref,
          params.slug,
          code,
          false,
        );
        if (!success) {
          return status(500, {
            message: "Failed to deploy function",
            code: "500",
          });
        }
      }

      // Update config if verify_jwt provided
      if (typeof body.verify_jwt === "boolean") {
        await edgeFunctionService.updateConfig(params.ref, params.slug, {
          verify_jwt: body.verify_jwt,
        });
      }

      if (Array.isArray(body.background_routes)) {
        await edgeFunctionService.updateConfig(params.ref, params.slug, {
          background_routes: body.background_routes.filter(
            (route): route is string =>
              typeof route === "string" && route.trim().length > 0,
          ),
        });
      }

      // Return updated function info
      const funcConfig = await edgeFunctionService.getConfig(
        params.ref,
        params.slug,
      );
      const version = Number.parseInt(funcConfig.version || "1", 10) || 1;
      const now = new Date().toISOString();
      return {
        id: params.slug,
        slug: params.slug,
        name: body.name || params.slug,
        version,
        status: "ACTIVE",
        verify_jwt: funcConfig.verify_jwt,
        background_routes: funcConfig.background_routes || [],
        created_at: now,
        updated_at: now,
      };
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      body: t.Object({
        name: t.Optional(t.String()),
        body: t.Optional(t.String()),
        code: t.Optional(t.String()),
        verify_jwt: t.Optional(t.Boolean()),
        background_routes: t.Optional(t.Array(t.String())),
      }),
    },
  )

  .post(
    "/:ref/functions/:slug/bundle",
    async ({ params, body }) => {
      const result = await projectService.deployFunctionBundleDetailed(
        params.ref,
        params.slug,
        body.files,
        body.entrypoint ?? "index.ts",
        body.minify ?? false,
      );
      if (!result.success) {
        return status(500, {
          message: result.error || "Failed to deploy function bundle",
          code: "500",
          details: result,
        });
      }
      return {
        success: true,
        bundled: true,
        files: result.files ?? Object.keys(body.files).length,
        version: result.version ?? null,
        import_map: result.import_map ?? null,
      };
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      body: t.Object({
        files: t.Record(t.String(), t.String()),
        entrypoint: t.Optional(t.String()),
        minify: t.Optional(t.Boolean()),
      }),
    },
  )

  .delete(
    "/:ref/functions",
    async ({ params, body }) => {
      const slug = body?.slug;
      if (!slug) {
        return status(400, {
          message: "slug is required in body",
          code: "400",
        });
      }
      const success = await projectService.deleteFunction(params.ref, slug);
      if (!success) {
        return status(500, {
          message: "Failed to delete function",
          code: "500",
        });
      }
      return { success: true };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({ slug: t.String() }),
    },
  )

  .delete(
    "/:ref/functions/:slug",
    async ({ params }) => {
      const success = await projectService.deleteFunction(
        params.ref,
        params.slug,
      );
      if (!success) {
        return status(500, {
          message: "Failed to delete function",
          code: "500",
        });
      }
      return { success: true };
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
    },
  )

  .get(
    "/:ref/functions/:slug/check",
    async ({ params }) => {
      const result = await projectService.checkFunctionRuntime(
        params.ref,
        params.slug,
      );
      if (!result) {
        return status(404, {
          message: "Project not found",
          code: "404",
        });
      }
      return result;
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
    },
  )

  .get(
    "/:ref/functions/:slug/config",
    async ({ params }) => {
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      const config = await edgeFunctionService.getConfig(
        params.ref,
        params.slug,
      );
      return config;
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
    },
  )

  .patch(
    "/:ref/functions/:slug/config",
    async ({ params, body }) => {
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      const updated = await edgeFunctionService.updateConfig(
        params.ref,
        params.slug,
        body,
      );
      return updated;
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      body: t.Object({
        verify_jwt: t.Optional(t.Boolean()),
        background_routes: t.Optional(t.Array(t.String())),
      }),
    },
  )

  .get(
    "/:ref/functions/:slug/logs",
    async ({ params, query }) => {
      const limit = Number(query.limit || 50);
      const offset = Number(query.offset || 0);
      const version =
        typeof query.version === "string" && query.version.trim().length > 0
          ? query.version.trim()
          : undefined;
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      const logs = await edgeFunctionService.getLogs(
        params.ref,
        params.slug,
        limit,
        offset,
        version,
      );
      return { logs, total: logs.length };
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      query: t.Object(
        {
          limit: t.Optional(t.String()),
          offset: t.Optional(t.String()),
          version: t.Optional(t.String()),
        },
        { additionalProperties: true },
      ),
    },
  )

  // Function Secrets — Project-level (Studio compatibility)
  .get(
    "/:ref/functions/secrets",
    async ({ params, query }) => {
      const secrets = await projectService.getSecrets(params.ref);
      if (!secrets) {
        return status(404, { message: "Project not found" });
      }
      const reveal = query.reveal === "true";
      return (secrets as Array<{
        name: string;
        value: string;
        updated_at?: string;
      }>).map((s) => ({
        name: s.name,
        value: reveal ? s.value : "********",
        updated_at: s.updated_at ?? new Date().toISOString(),
      }));
    },
    { params: t.Object({ ref: t.String() }), query: t.Object({ reveal: t.Optional(t.String()) }) },
  )
  .post(
    "/:ref/functions/secrets",
    async ({ params, body }) => {
      const secrets = (body as Array<{ name: string; value: string }>).map(
        (s) => ({
          name: `EDGEFN_${s.name}`,
          value: s.value,
        }),
      );
      const success = await projectService.upsertSecrets(params.ref, secrets);
      if (!success) {
        return status(500, {
          message: "Failed to create function secrets",
          code: "500",
        });
      }
      return {};
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Array(t.Object({ name: t.String(), value: t.String() })),
    },
  )
  .delete(
    "/:ref/functions/secrets",
    async ({ params, body }) => {
      const names = (body as string[]).map((n) => `EDGEFN_${n}`);
      const results = await Promise.all(
        names.map((name) => projectService.deleteSecret(params.ref, name)),
      );
      const failed = results.filter((r) => !r).length;
      if (failed > 0) {
        return status(500, {
          message: `Failed to delete ${failed} secret(s)`,
          code: "500",
        });
      }
      return {};
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Array(t.String()),
    },
  )

  // Function Secrets — Per-function level
  .get(
    "/:ref/functions/:slug/secrets",
    async ({ params }) => {
      const secrets = await projectService.getSecrets(params.ref);
      if (!secrets) return [];
      return (secrets as Array<{ name: string; value: string }>).filter((s) =>
        s.name.startsWith(`EDGEFN_${params.slug.toUpperCase()}_`),
      );
    },
    { params: t.Object({ ref: t.String(), slug: t.String() }) },
  )
  .post(
    "/:ref/functions/:slug/secrets",
    async ({ params, body }) => {
      const secrets = (body as Array<{ name: string; value: string }>).map(
        (s) => ({
          name: `EDGEFN_${params.slug.toUpperCase()}_${s.name}`,
          value: s.value,
        }),
      );
      const success = await projectService.upsertSecrets(params.ref, secrets);
      if (!success) {
        return status(500, {
          message: "Failed to create function secrets",
          code: "500",
        });
      }
      return {};
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      body: t.Array(t.Object({ name: t.String(), value: t.String() })),
    },
  )
  .delete(
    "/:ref/functions/:slug/secrets",
    async ({ params, body }) => {
      const names = (body as string[]).map(
        (n) => `EDGEFN_${params.slug.toUpperCase()}_${n}`,
      );
      const results = await Promise.all(
        names.map((name) => projectService.deleteSecret(params.ref, name)),
      );
      const failed = results.filter((r) => !r).length;
      if (failed > 0) {
        return status(500, {
          message: `Failed to delete ${failed} secret(s)`,
          code: "500",
        });
      }
      return {};
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      body: t.Array(t.String()),
    },
  );
