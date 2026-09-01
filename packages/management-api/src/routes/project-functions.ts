import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { isUserManagedFunctionSecretName } from "../utils/project-secret-visibility";
import {
  activeFunctionVersionNumber,
  EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE,
  EDGE_FUNCTION_SHA256_HEX_PATTERN,
  EdgeFunctionActiveVersionConflictError,
  isCanonicalEdgeFunctionSha256,
  type EdgeFunctionActivationResult,
  type EdgeFunctionActivationId,
  type EdgeFunctionActiveVersion,
  type EdgeFunctionConfigSnapshot,
  type EdgeFunctionDeploymentConfig,
  type EdgeFunctionDeployResult,
  EDGE_FUNCTION_FRAMEWORKS,
  type EdgeFunctionFramework,
} from "../services/edge-function.service";
import { EDGE_FUNCTION_ACTIVATION_ID_PATTERN } from "../services/edge-function-activation-manifest";

const CANONICAL_FUNCTION_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_FUNCTION_VERSION_PATTERN = /^[1-9][0-9]*$/;
// Admit the reserved legacy zero at schema parsing so the handler returns the stable public HTTP 400 contract.
const functionVersionSchema = t.String({ pattern: CANONICAL_FUNCTION_VERSION_PATTERN.source, maxLength: 16 });
const expectedActiveVersionSchema = t.Union([
  t.Literal("absent"),
  t.String({ pattern: CANONICAL_FUNCTION_VERSION_PATTERN.source, maxLength: 16 }),
]);
const expectedActivationIdSchema = t.Union([
  t.Literal("legacy"),
  t.String({
    pattern: EDGE_FUNCTION_ACTIVATION_ID_PATTERN.source,
    minLength: 36,
    maxLength: 36,
  }),
]);

async function requireFunctionManagementAuth(request: Request, ref: string) {
  const authError = await requireProjectOrAdminAuth(request, ref);
  if (authError) return status(authError.status, authError.body);
  return undefined;
}

function normalizeLimitOffset(
  limitValue: unknown,
  offsetValue: unknown,
  defaults = { limit: 50, offset: 0, maxLimit: 500 },
) {
  const rawLimit = limitValue === undefined || limitValue === null || limitValue === ""
    ? NaN
    : typeof limitValue === "number" ? limitValue : Number(limitValue);
  const rawOffset = offsetValue === undefined || offsetValue === null || offsetValue === ""
    ? NaN
    : typeof offsetValue === "number" ? offsetValue : Number(offsetValue);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(defaults.maxLimit, Math.floor(rawLimit)))
    : defaults.limit;
  const offset = Number.isFinite(rawOffset)
    ? Math.max(0, Math.floor(rawOffset))
    : defaults.offset;
  return { limit, offset };
}

function deploymentConfig(
  verifyJwt: boolean | undefined,
  backgroundRoutes: string[] | undefined,
  framework: EdgeFunctionFramework | undefined,
): EdgeFunctionDeploymentConfig {
  return {
    ...(typeof verifyJwt === "boolean" ? { verify_jwt: verifyJwt } : {}),
    ...(backgroundRoutes ? { background_routes: backgroundRoutes } : {}),
    ...(framework ? { framework } : {}),
  };
}

function functionConfigProjection(config: EdgeFunctionConfigSnapshot) {
  return {
    verify_jwt: config.verify_jwt,
    framework: config.framework ?? "fetch",
    background_routes: config.background_routes ?? [],
    ...(config.version === undefined ? {} : { version: config.version }),
    ...(config.import_map === undefined ? {} : { import_map: config.import_map }),
    ...(config.entrypoint === undefined ? {} : { entrypoint: config.entrypoint }),
  };
}

function normalizedBackgroundRoutes(routes: unknown): string[] | undefined {
  return Array.isArray(routes)
    ? routes.filter((route): route is string => typeof route === "string" && route.trim().length > 0)
    : undefined;
}

function functionDeploymentSource(input: { body?: string; code?: string }): string | null {
  const sources = [input.body, input.code].filter(
    (source): source is string => typeof source === "string" && source.length > 0,
  );
  return sources.length === 1 ? sources[0] : null;
}

function expectedActiveVersion(value: unknown): EdgeFunctionActiveVersion | null {
  if (value === "absent") return value;
  if (typeof value !== "string" || !CANONICAL_FUNCTION_VERSION_PATTERN.test(value)) {
    return null;
  }
  return Number.isSafeInteger(Number(value)) ? value : null;
}

function expectedActivationId(value: unknown): EdgeFunctionActivationId | null {
  if (value === "legacy") return value;
  return typeof value === "string" && EDGE_FUNCTION_ACTIVATION_ID_PATTERN.test(value)
    ? value
    : null;
}

function functionVersion(value: unknown): string | null {
  if (typeof value !== "string" || !POSITIVE_FUNCTION_VERSION_PATTERN.test(value)) return null;
  return Number.isSafeInteger(Number(value)) ? value : null;
}

async function functionResponseVersion(
  ref: string,
  slug: string,
  reportedVersion?: string,
): Promise<number | null> {
  if (reportedVersion !== undefined) return activeFunctionVersionNumber(reportedVersion);
  const { edgeFunctionService } = await import("../services/edge-function.service");
  const activeVersion = await edgeFunctionService.getActiveVersion(ref, slug);
  return activeFunctionVersionNumber(activeVersion);
}

function invalidExpectedActiveVersion() {
  return status(400, {
    message: "expected_active_version must be a canonical non-negative safe integer or 'absent'",
    code: "VALIDATION_ERROR",
  });
}

function invalidExpectedActivationId() {
  return status(400, {
    message: "expected_activation_id must be a canonical UUID or 'legacy'",
    code: "VALIDATION_ERROR",
  });
}

function invalidFunctionVersion() {
  return status(400, {
    message: "version must be a canonical positive safe integer",
    code: "VALIDATION_ERROR",
  });
}

type FunctionCodeDeploymentOptions =
  | { minify: boolean }
  | { prebundled: true; expectedSha256: string };

function functionCodeDeploymentOptions(body: {
  prebundled?: boolean;
  expected_sha256?: string;
  minify?: boolean;
}): FunctionCodeDeploymentOptions | null {
  if (body.prebundled === true) {
    if (body.minify !== undefined || !body.expected_sha256
      || !isCanonicalEdgeFunctionSha256(body.expected_sha256)) return null;
    return { prebundled: true, expectedSha256: body.expected_sha256 };
  }
  if (body.expected_sha256 !== undefined) return null;
  return { minify: body.minify ?? false };
}

function invalidPrebundledDeployment() {
  return status(400, {
    message: "prebundled deploy requires expected_sha256 and does not accept minify",
    code: "VALIDATION_ERROR",
  });
}

function deploymentFailure(deployment: EdgeFunctionDeployResult) {
  if (deployment.success) return null;
  if (deployment.error_code === EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE) {
    return status(409, {
      message: deployment.error || "Function active version conflict",
      code: deployment.error_code,
      expected_active_version: deployment.expected_active_version,
      active_version: deployment.active_version,
      expected_activation_id: deployment.expected_activation_id,
      activation_id: deployment.activation_id,
    });
  }
  return status(500, {
    message: deployment.error || "Failed to deploy function",
    code: "500",
    details: deployment,
  });
}

function activationConflict(error: unknown) {
  if (!(error instanceof EdgeFunctionActiveVersionConflictError)) return null;
  return status(409, {
    message: error.message,
    code: error.code,
    expected_active_version: error.expectedActiveVersion,
    active_version: error.activeVersion,
    expected_activation_id: error.expectedActivationId,
    activation_id: error.activationId,
  });
}

export const projectFunctionsRoutes = new Elysia({ prefix: "/v1/projects" })
  .get(
    "/:ref/functions",
    async ({ params, request }) => {
      const authError = await requireFunctionManagementAuth(request, params.ref);
      if (authError) return authError;
      return projectService.listFunctions(params.ref);
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["frontend"], summary: "List edge functions" },
    },
  )

  // Deploy via multipart/form-data (supabase CLI format)
  // POST /v1/projects/:ref/functions/deploy?slug=hello-world
  .post(
    "/:ref/functions/deploy",
    async ({ params, body, query, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
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
        framework?: EdgeFunctionFramework;
        name?: string;
        expected_active_version?: string;
        expected_activation_id?: string;
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
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          return status(400, { message: "metadata must be valid JSON", code: "VALIDATION_ERROR" });
        }
      }

      const expectedVersion = expectedActiveVersion(metadata.expected_active_version);
      if (expectedVersion === null) return invalidExpectedActiveVersion();
      const expectedId = expectedActivationId(metadata.expected_activation_id);
      if (expectedId === null) return invalidExpectedActivationId();

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

      const backgroundRoutes = normalizedBackgroundRoutes(metadata.background_routes);
      const framework = metadata.framework === undefined
        ? undefined
        : EDGE_FUNCTION_FRAMEWORKS.includes(metadata.framework)
          ? metadata.framework
          : null;
      if (framework === null) return status(400, { message: "unsupported function framework", code: "VALIDATION_ERROR" });
      const deployment = await projectService.deployFunctionRelease({
        ref: params.ref,
        slug,
        expectedActiveVersion: expectedVersion,
        expectedActivationId: expectedId,
        files: fileMap,
        entrypoint,
        config: deploymentConfig(metadata.verify_jwt, backgroundRoutes, framework),
      });
      const failure = deploymentFailure(deployment);
      if (failure) return failure;

      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      const funcConfig = deployment.config ?? await edgeFunctionService.getConfig(params.ref, slug);
      const version = await functionResponseVersion(
        params.ref,
        slug,
        deployment.version ?? deployment.active_version ?? funcConfig.version,
      );
      const now = new Date().toISOString();
      return {
        project_ref: params.ref,
        id: slug,
        slug,
        name: metadata.name || slug,
        version,
        previous_active_version: deployment.previous_active_version,
        active_version: deployment.active_version,
        expected_activation_id: expectedId,
        activation_id: deployment.activation_id ?? funcConfig.activation_id,
        status: version === null ? "INACTIVE" : "ACTIVE",
        verify_jwt: funcConfig.verify_jwt,
        background_routes: funcConfig.background_routes || [],
        framework: funcConfig.framework ?? "fetch",
        entrypoint_path: entrypoint,
        import_map: deployment.import_map != null || !!metadata.import_map_path,
        import_map_path: deployment.import_map ?? metadata.import_map_path ?? null,
        bundle_hash: deployment.bundle_hash ?? null,
        bundle_size_bytes: deployment.bundle_size_bytes ?? null,
        import_count: deployment.import_count ?? null,
        external_packages: deployment.external_packages ?? [],
        preheat: deployment.preheat ?? null,
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
      detail: { tags: ["frontend"], summary: "Deploy function via multipart upload" },
    },
  )

  .post(
    "/:ref/functions",
    async ({ params, body, query, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      // Support both JSON body and query param approaches (official Supabase Management API)
      const slug = body?.slug || (query as Record<string, string>).slug;
      const code = body?.body || body?.code || "";
      const name = body?.name || (query as Record<string, string>).name;
      const queryVerifyJwt = (query as Record<string, string>).verify_jwt;
      const verifyJwt = body?.verify_jwt ?? (
        queryVerifyJwt === undefined ? undefined : queryVerifyJwt !== "false"
      );
      const backgroundRoutes = normalizedBackgroundRoutes(body?.background_routes);
      const framework = body?.framework === undefined
        ? undefined
        : EDGE_FUNCTION_FRAMEWORKS.includes(body.framework)
          ? body.framework
          : null;
      if (framework === null) return status(400, { message: "unsupported function framework", code: "VALIDATION_ERROR" });
      const expectedId = expectedActivationId(
        body?.expected_activation_id
          ?? (query as Record<string, string>).expected_activation_id,
      );

      if (!slug) {
        return status(400, { message: "slug is required", code: "400" });
      }
      if (expectedId === null) return invalidExpectedActivationId();
      let deployResult:
        | Awaited<ReturnType<typeof projectService.deployFunctionRelease>>
        | null = null;
      // Allow empty code for metadata-only creation
      if (code) {
        const expectedVersion = expectedActiveVersion(body?.expected_active_version);
        if (expectedVersion === null) {
          return status(400, {
            message: "expected_active_version is required when deploying code",
            code: "VALIDATION_ERROR",
          });
        }
        deployResult = await projectService.deployFunctionRelease({
          ref: params.ref,
          slug,
          expectedActiveVersion: expectedVersion,
          expectedActivationId: expectedId,
          code,
          config: deploymentConfig(verifyJwt, backgroundRoutes, framework),
        });
        const failure = deploymentFailure(deployResult);
        if (failure) return failure;
      }

      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      const configPatch = deploymentConfig(verifyJwt, backgroundRoutes, framework);
      let funcConfig = deployResult?.config;
      if (!funcConfig) {
        try {
          funcConfig = await edgeFunctionService.updateConfig(
            params.ref,
            slug,
            configPatch,
            expectedId,
          );
        } catch (error) {
          const conflict = activationConflict(error);
          if (conflict) return conflict;
          throw error;
        }
      }
      const version = await functionResponseVersion(
        params.ref,
        slug,
        deployResult?.version ?? deployResult?.active_version ?? funcConfig.version,
      );

      const now = new Date().toISOString();
      return {
        project_ref: params.ref,
        id: slug,
        slug,
        name: name || slug,
        version,
        previous_active_version: deployResult?.previous_active_version,
        active_version: deployResult?.active_version,
        expected_activation_id: expectedId,
        activation_id: deployResult?.activation_id ?? funcConfig.activation_id,
        verify_jwt: funcConfig.verify_jwt,
        background_routes: funcConfig.background_routes || [],
        framework: funcConfig.framework ?? "fetch",
        status: version === null ? "INACTIVE" : "ACTIVE",
        created_at: now,
        updated_at: now,
        entrypoint_path:
          (query as Record<string, string>).entrypoint_path || "index.ts",
        import_map: false,
        import_map_path: null,
        bundle_hash: deployResult?.bundle_hash ?? null,
        bundle_size_bytes: deployResult?.bundle_size_bytes ?? null,
        import_count: deployResult?.import_count ?? null,
        external_packages: deployResult?.external_packages ?? [],
        preheat: deployResult?.preheat ?? null,
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
          framework: t.Optional(t.Union(EDGE_FUNCTION_FRAMEWORKS.map((value) => t.Literal(value)))),
          expected_activation_id: t.Optional(expectedActivationIdSchema),
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
          framework: t.Optional(t.Union(EDGE_FUNCTION_FRAMEWORKS.map((value) => t.Literal(value)))),
          expected_active_version: t.Optional(expectedActiveVersionSchema),
          expected_activation_id: t.Optional(expectedActivationIdSchema),
        }),
      ),
      detail: { tags: ["frontend"], summary: "Create or deploy an edge function" },
    },
  )

  // Bulk upsert functions (official Management API)
  .put(
    "/:ref/functions",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const functions = body as Array<{
        slug: string;
        body?: string;
        code?: string;
        name?: string;
        verify_jwt?: boolean;
        background_routes?: string[];
        framework?: EdgeFunctionFramework;
        expected_active_version: EdgeFunctionActiveVersion;
        expected_activation_id: EdgeFunctionActivationId;
      }>;
      if (functions.some((fn) => expectedActiveVersion(fn.expected_active_version) === null)) {
        return invalidExpectedActiveVersion();
      }
      if (functions.some((fn) => expectedActivationId(fn.expected_activation_id) === null)) {
        return invalidExpectedActivationId();
      }
      if (functions.some((fn) => functionDeploymentSource(fn) === null)) {
        return status(400, {
          message: "Each function must provide exactly one non-empty body or code field",
          code: "400",
        });
      }
      const results = [];
      for (const fn of functions) {
        const code = functionDeploymentSource(fn)!;

        const deployResult = await projectService.deployFunctionRelease({
          ref: params.ref,
          slug: fn.slug,
          expectedActiveVersion: expectedActiveVersion(fn.expected_active_version)!,
          expectedActivationId: expectedActivationId(fn.expected_activation_id)!,
          code,
          config: deploymentConfig(
            fn.verify_jwt,
            normalizedBackgroundRoutes(fn.background_routes),
            fn.framework,
          ),
        });

        const now = new Date().toISOString();
        results.push({
          slug: fn.slug,
          name: fn.name || fn.slug,
          success: deployResult.success,
          error_code: deployResult.error_code,
          previous_active_version: deployResult.previous_active_version,
          active_version: deployResult.active_version,
          expected_active_version: deployResult.expected_active_version,
          expected_activation_id: fn.expected_activation_id,
          activation_id: deployResult.activation_id ?? deployResult.config?.activation_id,
          verify_jwt: deployResult.config?.verify_jwt,
          background_routes: deployResult.config?.background_routes || [],
          updated_at: now,
        });
      }
      if (results.some((deployment) => (
        deployment.error_code === EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE
      ))) {
        return status(409, { functions: results });
      }
      return results.some((deployment) => !deployment.success)
        ? status(500, { functions: results })
        : results;
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
          expected_active_version: expectedActiveVersionSchema,
          expected_activation_id: expectedActivationIdSchema,
        }),
      ),
      detail: { tags: ["frontend"], summary: "Bulk upsert edge functions" },
    },
  )

  .get(
    "/:ref/functions/:slug",
    async ({ params, request }) => {
      const authError = await requireFunctionManagementAuth(request, params.ref);
      if (authError) return authError;
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
      const version = await functionResponseVersion(params.ref, params.slug, funcConfig.version);
      const now = new Date().toISOString();
      return {
        id: params.slug,
        slug: params.slug,
        name: params.slug,
        version,
        status: version === null ? "INACTIVE" : "ACTIVE",
        verify_jwt: funcConfig.verify_jwt,
        background_routes: funcConfig.background_routes || [],
        activation_id: funcConfig.activation_id,
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
      detail: { tags: ["frontend"], summary: "Get edge function details" },
    },
  )

  .post(
    "/:ref/functions/:slug/invoke",
    async ({ params, request, body }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      try {
        const { config } = await import("../config");
        const project = await projectService.getProject(params.ref);
        if (!project) {
          return status(404, { message: "Project not found", code: "404" });
        }
        const edgeUrl = `${config.edgeRuntimeUrl}/functions/v1/${params.slug}`;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-project-ref": params.ref,
          "x-region": project.region || "local",
        };
        const authHeader = request.headers.get("Authorization");
        if (authHeader) headers["Authorization"] = authHeader;
        const apiKey = request.headers.get("apikey");
        if (apiKey) headers["apikey"] = apiKey;
        const resp = await fetch(edgeUrl, {
          method: "POST",
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        const respBody = await resp.text();
        return new Response(respBody, {
          status: resp.status,
          headers: { "Content-Type": resp.headers.get("Content-Type") || "application/json" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return status(502, { message: `Edge Runtime unreachable: ${msg}`, code: "502" });
      }
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      body: t.Optional(t.Any()),
      detail: { tags: ["frontend"], summary: "Invoke an edge function" },
    },
  )

  .get(
    "/:ref/functions/:slug/source",
    async ({ params, request }) => {
      const authError = await requireFunctionManagementAuth(request, params.ref);
      if (authError) return authError;
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
      detail: { tags: ["frontend"], summary: "Get function source code" },
    },
  )

  .get(
    "/:ref/functions/:slug/versions",
    async ({ params, request }) => {
      const authError = await requireFunctionManagementAuth(request, params.ref);
      if (authError) return authError;
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      return edgeFunctionService.listVersions(params.ref, params.slug);
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      detail: { tags: ["frontend"], summary: "List function versions" },
    },
  )

  .get(
    "/:ref/functions/:slug/versions/:version",
    async ({ params, request }) => {
      const authError = await requireFunctionManagementAuth(request, params.ref);
      if (authError) return authError;
      const targetVersion = functionVersion(params.version);
      if (targetVersion === null) return invalidFunctionVersion();
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      const version = await edgeFunctionService.getVersion(
        params.ref,
        params.slug,
        targetVersion,
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
      detail: { tags: ["frontend"], summary: "Get a specific function version" },
    },
  )

  .post(
    "/:ref/functions/:slug/versions/:version/activate",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      const expectedVersion = expectedActiveVersion(body.expected_active_version);
      if (expectedVersion === null) return invalidExpectedActiveVersion();
      const expectedId = expectedActivationId(body.expected_activation_id);
      if (expectedId === null) return invalidExpectedActivationId();
      const targetVersion = functionVersion(params.version);
      if (targetVersion === null) return invalidFunctionVersion();
      try {
        const activation = await edgeFunctionService.activateVersion(
          params.ref,
          params.slug,
          targetVersion,
          expectedVersion,
          expectedId,
        );
        if (!activation) {
          return status(404, { message: "Function version not found", code: "404" });
        }
        return {
          success: true,
          project_ref: params.ref,
          slug: params.slug,
          previous_active_version: activation.previous_active_version,
          active_version: activation.active_version,
          expected_activation_id: expectedId,
          activation_id: activation.activation_id,
          version: targetVersion,
          config: activation.config,
        };
      } catch (error) {
        const conflict = activationConflict(error);
        if (conflict) return conflict;
        throw error;
      }
    },
    {
      params: t.Object({
        ref: t.String(),
        slug: t.String(),
        version: functionVersionSchema,
      }),
      body: t.Object({
        expected_active_version: expectedActiveVersionSchema,
        expected_activation_id: expectedActivationIdSchema,
      }),
      detail: { tags: ["frontend"], summary: "Activate a function version" },
    },
  )

  // Download function source body (supabase CLI compatibility)
  // Official: GET /v1/projects/:ref/functions/:slug/body → octet-stream
  .get(
    "/:ref/functions/:slug/body",
    async ({ params, request, set }) => {
      const authError = await requireFunctionManagementAuth(request, params.ref);
      if (authError) return authError;
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
      detail: { tags: ["frontend"], summary: "Download function source body" },
    },
  )

  .post(
    "/:ref/functions/:slug",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const code = body.code || body.body || "";
      const expectedVersion = expectedActiveVersion(body.expected_active_version);
      if (expectedVersion === null) return invalidExpectedActiveVersion();
      const expectedId = expectedActivationId(body.expected_activation_id);
      if (expectedId === null) return invalidExpectedActivationId();
      const codeDeploymentOptions = functionCodeDeploymentOptions(body);
      if (codeDeploymentOptions === null) return invalidPrebundledDeployment();
      const deployment = await projectService.deployFunctionRelease({
        ref: params.ref,
        slug: params.slug,
        expectedActiveVersion: expectedVersion,
        expectedActivationId: expectedId,
        code,
        ...codeDeploymentOptions,
        config: deploymentConfig(
          body.verify_jwt,
          normalizedBackgroundRoutes(body.background_routes),
          body.framework,
        ),
      });
      const failure = deploymentFailure(deployment);
      if (failure) return failure;
      return {
        success: true,
        project_ref: params.ref,
        slug: params.slug,
        bundled: deployment.bundled ?? true,
        version: deployment.version ?? null,
        previous_active_version: deployment.previous_active_version,
        active_version: deployment.active_version,
        expected_activation_id: expectedId,
        activation_id: deployment.activation_id ?? deployment.config?.activation_id,
        bundle_hash: deployment.bundle_hash ?? null,
        bundle_size_bytes: deployment.bundle_size_bytes ?? null,
        import_count: deployment.import_count ?? null,
        external_packages: deployment.external_packages ?? [],
        preheat: deployment.preheat ?? null,
        verify_jwt: deployment.config?.verify_jwt ?? true,
        background_routes: deployment.config?.background_routes || [],
        framework: deployment.config?.framework ?? "fetch",
        config: deployment.config,
      };
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      body: t.Object({
        code: t.Optional(t.String()),
        body: t.Optional(t.String()),
        minify: t.Optional(t.Boolean()),
        prebundled: t.Optional(t.Boolean()),
        expected_sha256: t.Optional(t.String({
          pattern: EDGE_FUNCTION_SHA256_HEX_PATTERN,
          minLength: 64,
          maxLength: 64,
        })),
        verify_jwt: t.Optional(t.Boolean()),
        background_routes: t.Optional(t.Array(t.String())),
        framework: t.Optional(t.Union(EDGE_FUNCTION_FRAMEWORKS.map((value) => t.Literal(value)))),
        expected_active_version: expectedActiveVersionSchema,
        expected_activation_id: expectedActivationIdSchema,
      }),
      detail: { tags: ["frontend"], summary: "Deploy function code by slug" },
    },
  )

  .patch(
    "/:ref/functions/:slug",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const { edgeFunctionService } =
        await import("../services/edge-function.service");

      // Update code if provided
      const code = body.code || body.body;
      let deployResult:
        | Awaited<ReturnType<typeof projectService.deployFunctionRelease>>
        | null = null;
      const framework = body.framework === undefined
        ? undefined
        : EDGE_FUNCTION_FRAMEWORKS.includes(body.framework)
          ? body.framework
          : null;
      if (framework === null) return status(400, { message: "unsupported function framework", code: "VALIDATION_ERROR" });
      const configPatch = deploymentConfig(
        body.verify_jwt,
        normalizedBackgroundRoutes(body.background_routes),
        framework,
      );
      const expectedId = expectedActivationId(body.expected_activation_id);
      if (expectedId === null) return invalidExpectedActivationId();
      if (code) {
        const expectedVersion = expectedActiveVersion(body.expected_active_version);
        if (expectedVersion === null) {
          return status(400, {
            message: "expected_active_version is required when deploying code",
            code: "VALIDATION_ERROR",
          });
        }
        deployResult = await projectService.deployFunctionRelease({
          ref: params.ref,
          slug: params.slug,
          expectedActiveVersion: expectedVersion,
          expectedActivationId: expectedId,
          code,
          config: configPatch,
        });
        const failure = deploymentFailure(deployResult);
        if (failure) return failure;
      }

      let funcConfig = deployResult?.config;
      if (!funcConfig) {
        try {
          funcConfig = await edgeFunctionService.updateConfig(
            params.ref,
            params.slug,
            configPatch,
            expectedId,
          );
        } catch (error) {
          const conflict = activationConflict(error);
          if (conflict) return conflict;
          throw error;
        }
      }
      const version = await functionResponseVersion(
        params.ref,
        params.slug,
        deployResult?.version ?? deployResult?.active_version ?? funcConfig.version,
      );
      const now = new Date().toISOString();
      return {
        project_ref: params.ref,
        id: params.slug,
        slug: params.slug,
        name: body.name || params.slug,
        version,
        previous_active_version: deployResult?.previous_active_version,
        active_version: deployResult?.active_version,
        expected_activation_id: expectedId,
        activation_id: deployResult?.activation_id ?? funcConfig.activation_id,
        status: version === null ? "INACTIVE" : "ACTIVE",
        verify_jwt: funcConfig.verify_jwt,
        background_routes: funcConfig.background_routes || [],
        framework: funcConfig.framework ?? "fetch",
        bundle_hash: deployResult?.bundle_hash ?? null,
        bundle_size_bytes: deployResult?.bundle_size_bytes ?? null,
        import_count: deployResult?.import_count ?? null,
        external_packages: deployResult?.external_packages ?? [],
        preheat: deployResult?.preheat ?? null,
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
        framework: t.Optional(t.Union(EDGE_FUNCTION_FRAMEWORKS.map((value) => t.Literal(value)))),
        expected_active_version: t.Optional(expectedActiveVersionSchema),
        expected_activation_id: expectedActivationIdSchema,
      }),
      detail: { tags: ["frontend"], summary: "Update function code or config" },
    },
  )

  .post(
    "/:ref/functions/:slug/bundle",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const expectedVersion = expectedActiveVersion(body.expected_active_version);
      if (expectedVersion === null) return invalidExpectedActiveVersion();
      const expectedId = expectedActivationId(body.expected_activation_id);
      if (expectedId === null) return invalidExpectedActivationId();
      const deployment = await projectService.deployFunctionRelease({
        ref: params.ref,
        slug: params.slug,
        expectedActiveVersion: expectedVersion,
        expectedActivationId: expectedId,
        files: body.files,
        entrypoint: body.entrypoint ?? "index.ts",
        minify: body.minify ?? false,
        config: deploymentConfig(
          body.verify_jwt,
          normalizedBackgroundRoutes(body.background_routes),
          body.framework,
        ),
      });
      const failure = deploymentFailure(deployment);
      if (failure) return failure;
      return {
        success: true,
        project_ref: params.ref,
        slug: params.slug,
        bundled: true,
        files: deployment.files ?? Object.keys(body.files).length,
        version: deployment.version ?? null,
        previous_active_version: deployment.previous_active_version,
        active_version: deployment.active_version,
        expected_activation_id: expectedId,
        activation_id: deployment.activation_id ?? deployment.config?.activation_id,
        import_map: deployment.import_map ?? null,
        bundle_hash: deployment.bundle_hash ?? null,
        bundle_size_bytes: deployment.bundle_size_bytes ?? null,
        import_count: deployment.import_count ?? null,
        external_packages: deployment.external_packages ?? [],
        preheat: deployment.preheat ?? null,
        verify_jwt: deployment.config?.verify_jwt ?? true,
        background_routes: deployment.config?.background_routes || [],
        framework: deployment.config?.framework ?? "fetch",
        config: deployment.config,
      };
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      body: t.Object({
        files: t.Record(t.String(), t.String()),
        entrypoint: t.Optional(t.String()),
        minify: t.Optional(t.Boolean()),
        verify_jwt: t.Optional(t.Boolean()),
        background_routes: t.Optional(t.Array(t.String())),
        framework: t.Optional(t.Union(EDGE_FUNCTION_FRAMEWORKS.map((value) => t.Literal(value)))),
        expected_active_version: expectedActiveVersionSchema,
        expected_activation_id: expectedActivationIdSchema,
      }),
      detail: { tags: ["frontend"], summary: "Deploy function bundle" },
    },
  )

  .delete(
    "/:ref/functions",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const slug = body?.slug;
      if (!slug) {
        return status(400, {
          message: "slug is required in body",
          code: "400",
        });
      }
      const expectedId = expectedActivationId(body.expected_activation_id);
      if (expectedId === null) return invalidExpectedActivationId();
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(500, { message: "Failed to delete function", code: "500" });
      }
      const { edgeFunctionService } = await import("../services/edge-function.service");
      let removal: EdgeFunctionActivationResult;
      try {
        removal = await edgeFunctionService.remove(params.ref, slug, expectedId);
      } catch (error) {
        const conflict = activationConflict(error);
        if (conflict) return conflict;
        throw error;
      }
      return {
        success: true,
        project_ref: params.ref,
        slug,
        expected_activation_id: expectedId,
        activation_id: removal.activation_id,
        previous_active_version: removal.previous_active_version,
        active_version: removal.active_version,
        config: removal.config,
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        slug: t.String(),
        expected_activation_id: expectedActivationIdSchema,
      }),
      detail: { tags: ["frontend"], summary: "Delete function by slug in body" },
    },
  )

  .delete(
    "/:ref/functions/:slug",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const expectedId = expectedActivationId(body.expected_activation_id);
      if (expectedId === null) return invalidExpectedActivationId();
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(500, { message: "Failed to delete function", code: "500" });
      }
      const { edgeFunctionService } = await import("../services/edge-function.service");
      let removal: EdgeFunctionActivationResult;
      try {
        removal = await edgeFunctionService.remove(params.ref, params.slug, expectedId);
      } catch (error) {
        const conflict = activationConflict(error);
        if (conflict) return conflict;
        throw error;
      }
      return {
        success: true,
        project_ref: params.ref,
        slug: params.slug,
        expected_activation_id: expectedId,
        activation_id: removal.activation_id,
        previous_active_version: removal.previous_active_version,
        active_version: removal.active_version,
        config: removal.config,
      };
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      body: t.Object({ expected_activation_id: expectedActivationIdSchema }),
      detail: { tags: ["frontend"], summary: "Delete an edge function" },
    },
  )

  .get(
    "/:ref/functions/:slug/check",
    async ({ params, request }) => {
      const authError = await requireFunctionManagementAuth(request, params.ref);
      if (authError) return authError;
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
      detail: { tags: ["frontend"], summary: "Check function runtime status" },
    },
  )

  .get(
    "/:ref/functions/:slug/config",
    async ({ params, request }) => {
      const authError = await requireFunctionManagementAuth(request, params.ref);
      if (authError) return authError;
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      const state = await edgeFunctionService.getState(
        params.ref,
        params.slug,
      );
      return {
        project_ref: params.ref,
        slug: params.slug,
        active_version: state.active_version,
        ...functionConfigProjection(state.config),
        activation_id: state.config.activation_id,
      };
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      detail: { tags: ["frontend"], summary: "Get function configuration" },
    },
  )

  .patch(
    "/:ref/functions/:slug/config",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const { edgeFunctionService } =
        await import("../services/edge-function.service");
      const expectedId = expectedActivationId(body.expected_activation_id);
      if (expectedId === null) return invalidExpectedActivationId();
      try {
        const updated = await edgeFunctionService.updateConfig(
          params.ref,
          params.slug,
          deploymentConfig(body.verify_jwt, body.background_routes, body.framework),
          expectedId,
        );
        return {
          success: true,
          project_ref: params.ref,
          slug: params.slug,
          expected_activation_id: expectedId,
          ...functionConfigProjection(updated),
          activation_id: updated.activation_id,
        };
      } catch (error) {
        const conflict = activationConflict(error);
        if (conflict) return conflict;
        throw error;
      }
    },
    {
      params: t.Object({ ref: t.String(), slug: t.String() }),
      body: t.Object({
        verify_jwt: t.Optional(t.Boolean()),
        background_routes: t.Optional(t.Array(t.String())),
        framework: t.Optional(t.Union(EDGE_FUNCTION_FRAMEWORKS.map((value) => t.Literal(value)))),
        expected_activation_id: expectedActivationIdSchema,
      }),
      detail: { tags: ["frontend"], summary: "Update function configuration" },
    },
  )

  .get(
    "/:ref/functions/:slug/logs",
    async ({ params, query, request }) => {
      const authError = await requireFunctionManagementAuth(request, params.ref);
      if (authError) return authError;
      const { limit, offset } = normalizeLimitOffset(query.limit, query.offset);
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
      detail: { tags: ["frontend"], summary: "Get function logs" },
    },
  )

  // Function Secrets — Project-level (Studio compatibility)
  .get(
    "/:ref/functions/secrets",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const secrets = await projectService.getSecrets(params.ref);
      if (!secrets) {
        return status(404, { message: "Project not found" });
      }
      return (secrets as Array<{
        name: string;
        value: string;
        updated_at?: string;
      }>)
        .filter((secret) => isUserManagedFunctionSecretName(secret.name))
        .map((secret) => ({
          name: secret.name,
          value: "********",
          updated_at: secret.updated_at ?? new Date().toISOString(),
        }));
    },
    { params: t.Object({ ref: t.String() }), detail: { tags: ["frontend"], summary: "List function secrets (project-level)" } },
  )
  .post(
    "/:ref/functions/secrets",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
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
      detail: { tags: ["frontend"], summary: "Create function secrets" },
    },
  )
  .delete(
    "/:ref/functions/secrets",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
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
      detail: { tags: ["frontend"], summary: "Delete function secrets" },
    },
  )

  // Function Secrets — Per-function level
  .get(
    "/:ref/functions/:slug/secrets",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const secrets = await projectService.getSecrets(params.ref);
      if (!secrets) return status(404, { message: "Project not found", code: "404" });
      return (secrets as Array<{ name: string; value: string; updated_at?: string }>)
        .filter((s) => s.name.startsWith(`EDGEFN_${params.slug.toUpperCase()}_`))
        .map((s) => ({
          name: s.name,
          value: "********",
          updated_at: s.updated_at ?? new Date().toISOString(),
        }));
    },
    { params: t.Object({ ref: t.String(), slug: t.String() }), detail: { tags: ["frontend"], summary: "List per-function secrets" } },
  )
  .post(
    "/:ref/functions/:slug/secrets",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
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
      detail: { tags: ["frontend"], summary: "Create per-function secrets" },
    },
  )
  .delete(
    "/:ref/functions/:slug/secrets",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
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
      detail: { tags: ["frontend"], summary: "Delete per-function secrets" },
    },
  );
