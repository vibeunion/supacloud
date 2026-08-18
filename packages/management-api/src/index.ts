import { Elysia, status } from "elysia";
import type { AnyElysia } from "elysia";
import { logger } from "./utils/logger";
import { runBootstrapOrExit } from "./runtime/bootstrap-fatal";

process.on("uncaughtException", (err: Error) => {
  logger.error("FATAL UNCAUGHT EXCEPTION:", {
    message: err.message,
    stack: err.stack,
  });
});

process.on("unhandledRejection", (reason: unknown) => {
  logger.error("FATAL UNHANDLED REJECTION:", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

import { swagger } from "@elysiajs/swagger";

import { config } from "./config";
import { checkAuth, isInvitationAcceptanceRequest } from "./middleware/auth";
import { bffProofBodyCapture } from "./middleware/bff-proof-body";
import { checkRateLimit } from "./middleware/rate-limit";
import { logAuditEvent, shouldAuditRequest } from "./services/audit.service";
import { closeDb } from "./db";
import { authRuntimeRoutes, storageCompatRoutes } from "./routes";
import { migrateLegacyVersionArtifacts } from "./services/edge-function.service";
import { resolveProjectApiKey } from "./utils/project-auth";
import { translateRealtimeProxyCredentials } from "./utils/realtime-proxy-auth";
import { recordRequestPeerAddress } from "./utils/client-ip";
import { resolveWebConsoleDir } from "./utils/web-console-path";
import { grafanaProxyRoutes, handleGrafanaRequest } from "./routes/grafana";
import { closeTaskWebSocket, messageTaskWebSocket, openTaskWebSocket } from "./routes/ws";
import { isS3DataPlaneRequest } from "./utils/storage-s3-paths";
import { studioAuthRoutes } from "./routes/studio-auth";
import { caddyAskRoutes } from "./routes/caddy-ask";
import { validationErrorResponse } from "./utils/http-validation";
import { withLogicalBackupMutationTimeoutController } from "./utils/logical-backup-request-timeout";

function getWebConsoleDir(): string {
  return resolveWebConsoleDir();
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

let _embeddedAssets: Record<
  string,
  { content: string; encoding: string; mimeType: string }
> | null = null;
async function getEmbeddedAssets() {
  if (!_embeddedAssets) {
    try {
      const mod = (await import("./assets.gen")) as Record<string, unknown>;
      _embeddedAssets = (mod.EMBEDDED_ASSETS as typeof _embeddedAssets) ?? {};
    } catch {
      logger.debug(
        "Failed to load embedded assets (assets.gen.ts not found), using empty fallback.",
      );
      _embeddedAssets = {};
    }
  }
  return _embeddedAssets;
}

const STUDIO_COMPAT_NOT_FOUND = { message: "Route not found", code: "404" };

function isStudioCompatibilityRequest(request: Request): boolean {
  if (request.headers.get("x-supacloud-ui-host") === "studio") {
    return true;
  }

  const host = (request.headers.get("host") || "").toLowerCase();
  return host.startsWith("studio.") || host.startsWith("studio-");
}

async function rejectStudioCompatibilityRequest(request: Request, set: any) {
  if (!isStudioCompatibilityRequest(request)) {
    set.status = 404;
    return STUDIO_COMPAT_NOT_FOUND;
  }

  const rateLimit = checkRateLimit(request);
  set.headers ??= {};
  for (const [key, value] of Object.entries(rateLimit.headers)) {
    set.headers[key] = value;
  }
  if (!rateLimit.allowed) {
    set.status = rateLimit.status;
    return rateLimit.body;
  }

  const authError = await checkAuth(request);
  if (authError) {
    set.status = authError.status;
    return { message: authError.body.error, code: String(authError.status) };
  }

  return undefined;
}

async function listStudioCompatibilityProjects() {
  const { projectService } = await import("./services");
  const projects = await projectService.listProjects();

  return projects.map((project: any) => ({
    id: project.id,
    ref: project.ref,
    name: project.name,
    status: project.status?.toUpperCase() || "ACTIVE_HEALTHY",
    region: project.region || "local",
    organization_id: "default",
    cloud_provider: project.cloud_provider || "localhost",
    inserted_at: project.created_at,
    updated_at: project.updated_at ?? null,
    database: {
      host: project.database?.host || "localhost",
      name: project.database?.name || `supa_${project.ref}`,
      user: project.database?.user || `role_${project.ref}`,
      port: project.database?.port || 5432,
      pool_size: project.database?.pool_size || 20,
    },
    api: {
      url: project.api?.url || "",
    },
    studio: {
      url: project.studio?.url || "",
    },
    services: project.services || [],
    rest: project.rest || {},
    realtime: project.realtime || false,
  }));
}

async function getStudioCompatibilityProject(ref: string) {
  const { projectService } = await import("./services");
  let project: Record<string, any> | null = await projectService.getProject(ref) as Record<string, any> | null;

  if (!project && ref === "default") {
    const projects = await projectService.listProjects();
    project = (projects[0] as Record<string, any> | undefined) ?? null;
  }

  if (!project) return null;

  return {
    id: project.id,
    ref: project.ref,
    name: project.name,
    status: project.status?.toUpperCase() || "ACTIVE_HEALTHY",
    region: project.region || "local",
    organization_id: "default",
    cloud_provider: project.cloud_provider || "localhost",
    inserted_at: project.created_at,
    connectionString: project.connectionString || "",
    created_at: project.created_at,
    updated_at: project.updated_at ?? null,
    database: {
      host: project.database?.host || "localhost",
      name: project.database?.name || `supa_${project.ref}`,
      user: project.database?.user || `role_${project.ref}`,
      port: project.database?.port || 5432,
      pool_size: project.database?.pool_size || 20,
    },
    api: {
      url: project.api?.url || "",
    },
    studio: {
      url: project.studio?.url || "",
    },
    services: project.services || [],
    rest: project.rest || {},
    realtime: project.realtime || false,
  };
}

async function buildStudioCompatibilityProfile() {
  const projects = await listStudioCompatibilityProjects();

  return {
    id: 1,
    primary_email: "admin@supacloud.local",
    username: "admin",
    first_name: "Admin",
    last_name: "User",
    organizations: [{
      id: 1,
      name: "SupaCloud",
      slug: "supacloud",
      projects,
    }],
  };
}

const args = process.argv.slice(2);

// --- Gateway-style try_files static asset serving ---
// No pre-warmed Set. Direct disk checks per request (Bun.file is near-zero-cost).
// index.html is cached in memory with mtime-based invalidation.
let _cachedIndexHtml: string | null = null;
let _indexHtmlMtime: number = 0;

/** Check if a static asset exists on disk (O(1) syscall) */
function staticFileExists(relativePath: string): boolean {
  try {
    const f = Bun.file(`${getWebConsoleDir()}${relativePath}`);
    return f.size > 0;
  } catch {
    return false;
  }
}

/** Determine if a path is an immutable hashed asset (should never SPA-fallback) */
function isImmutableAsset(path: string): boolean {
  return path.startsWith("/_app/") || path.startsWith("/assets/");
}

/** Determine if a path looks like a static file request (has a file extension) */
function hasFileExtension(path: string): boolean {
  const lastSegment = path.split("/").pop() || "";
  return lastSegment.includes(".");
}

/** Get index.html with mtime-based cache invalidation */
async function getIndexHtml(): Promise<string | null> {
  try {
    const file = Bun.file(`${getWebConsoleDir()}/index.html`);
    const mtime = file.lastModified;
    if (!_cachedIndexHtml || mtime !== _indexHtmlMtime) {
      _cachedIndexHtml = await file.text();
      _indexHtmlMtime = mtime;
      logger.info("[StaticAssets] index.html (re)loaded from disk");
    }
    return _cachedIndexHtml;
  } catch {
    return null;
  }
}

async function waitForGatewayBeforeServe(): Promise<void> {
  const { gatewayService } = await import("./services/gateway.service");
  const maxAttempts = Number(process.env.GATEWAY_READY_MAX_ATTEMPTS || 60);
  const intervalMs = Number(process.env.GATEWAY_READY_INTERVAL_MS || 1000);
  const result = await gatewayService.ensureGatewayReady({ maxAttempts, intervalMs });
  if (!result.ready) {
    throw new Error(result.error || "Caddy Admin API did not become ready");
  }
}

async function reconcileGatewayBeforeServe(): Promise<void> {
  const { reconcileCanonicalGatewayRoutes } = await import("./services/gateway.service");
  const state = await reconcileCanonicalGatewayRoutes();
  logger.info("[Bootstrap] Canonical gateway reconciliation completed", {
    tenants: state.tenants.updated,
    frontends: state.frontends.configured,
  });
}

const app = new Elysia({ strictPath: false })
  .onError({ as: "global" }, ({ code, error, set }) => {
    if (code === "VALIDATION") {
      return validationErrorResponse(set);
    }
    const { isAppError, toAppError } = require("./utils/errors") as typeof import("./utils/errors");

    if (isAppError(error)) {
      set.status = error.statusCode;
      return error.toJSON();
    }

    logger.error(`Error [${code}]:`, error);

    if (code === "NOT_FOUND") {
      set.status = 404;
      return { message: "Not found", code: "NOT_FOUND" };
    }

    const appError = toAppError(error);
    set.status = appError.statusCode;
    if (appError.statusCode === 503) {
      set.headers["Retry-After"] = "5";
    }
    return appError.toJSON();
  })
  // Swagger docs
  .use(
    swagger({
      documentation: {
        info: {
          title: "SupaCloud Management API",
          version: "1.0.0",
          description: "API for managing SupaCloud multi-tenant projects",
        },
        tags: [
          { name: "projects", description: "Project management endpoints" },
          {
            name: "organizations",
            description: "Organization management endpoints",
          },
          { name: "user", description: "User profile endpoints" },
          {
            name: "backups",
            description: "Database backup and restore endpoints",
          },
          {
            name: "monitor",
            description: "Database monitoring and health endpoints",
          },
          {
            name: "maintenance",
            description: "High availability and cluster maintenance",
          },
          {
            name: "extensions",
            description: "PostgreSQL extension management (Market)",
          },
          {
            name: "security",
            description: "Firewall and SSL security management",
          },
          {
            name: "storage",
            description: "JuiceFS storage and S3 migration management",
          },
          {
            name: "scaling",
            description: "Auto-scaling and vertical upgrade management",
          },
          { name: "tasks", description: "Background task monitoring" },
          {
            name: "auth",
            description: "Authentication and OAuth provider management",
          },
          {
            name: "frontend",
            description: "Frontend hosting and deployment management",
          },
          {
            name: "webhook",
            description: "GitHub webhook and CI/CD integration",
          },
          {
            name: "sdk-proxy",
            description: "Supabase SDK compatibility proxy endpoints",
          },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    }),
  )

  // Rate limit headers + API version (Studio compatibility)
  .onAfterHandle(({ set }) => {
    set.headers ??= {};
    set.headers["x-ratelimit-limit"] ??= "1000";
    set.headers["x-ratelimit-remaining"] ??= "999";
    set.headers["x-ratelimit-reset"] ??= String(
      Math.ceil(Date.now() / 60000) * 60,
    );
    set.headers["x-supabase-api-version"] = "2024-01-01";
  })

  // Health check (no auth required)
  .get("/health", () => ({ status: "ok", timestamp: new Date().toISOString() }))
  .use(studioAuthRoutes)

  .get("/platform/projects", async ({ request, set }) => {
    const rejected = await rejectStudioCompatibilityRequest(request, set);
    if (rejected) return rejected;

    return listStudioCompatibilityProjects();
  })
  .get("/platform/projects/:ref", async ({ request, params, set }) => {
    const rejected = await rejectStudioCompatibilityRequest(request, set);
    if (rejected) return rejected;

    const project = await getStudioCompatibilityProject(params.ref);
    if (!project) {
      set.status = 404;
      return { message: "Project not found", code: "404" };
    }

    return project;
  })
  .get("/platform/organizations", async ({ request, set }) => {
    const rejected = await rejectStudioCompatibilityRequest(request, set);
    if (rejected) return rejected;

    return [{ id: 1, name: "SupaCloud", slug: "supacloud" }];
  })
  .get("/platform/profile", async ({ request, set }) => {
    const rejected = await rejectStudioCompatibilityRequest(request, set);
    if (rejected) return rejected;

    return buildStudioCompatibilityProfile();
  })
  .get("/api/platform/projects", async ({ request, set }) => {
    const rejected = await rejectStudioCompatibilityRequest(request, set);
    if (rejected) return rejected;

    return listStudioCompatibilityProjects();
  })
  .get("/api/platform/projects/:ref", async ({ request, params, set }) => {
    const rejected = await rejectStudioCompatibilityRequest(request, set);
    if (rejected) return rejected;

    const project = await getStudioCompatibilityProject(params.ref);
    if (!project) {
      set.status = 404;
      return { message: "Project not found", code: "404" };
    }

    return project;
  })
  .get("/api/platform/organizations", async ({ request, set }) => {
    const rejected = await rejectStudioCompatibilityRequest(request, set);
    if (rejected) return rejected;

    return [{ id: 1, name: "SupaCloud", slug: "supacloud" }];
  })
  .get("/api/platform/profile", async ({ request, set }) => {
    const rejected = await rejectStudioCompatibilityRequest(request, set);
    if (rejected) return rejected;

    return buildStudioCompatibilityProfile();
  })

  // Compatibility path for manual/lego HTTP-01 challenge files. The default
  // Caddy flow uses Automatic HTTPS with the on-demand permission endpoint.
  .get("/.well-known/acme-challenge/:token", async ({ params, set }) => {
    const token = String(params.token || "");
    if (!/^[A-Za-z0-9_-]+$/.test(token)) {
      set.status = 400;
      return "invalid token";
    }
    const file = Bun.file(`${config.acmeHttpWebroot}/${token}`);
    try {
      if (file.size <= 0) {
        set.status = 404;
        return "not found";
      }
      set.headers["content-type"] = "text/plain; charset=utf-8";
      return await file.text();
    } catch {
      set.status = 404;
      return "not found";
    }
  })

  .use(caddyAskRoutes)

  // WebSocket routes perform their own cookie/project-token authentication.
  .use((await import("./routes/ws")).wsRoutes)

  // Main API Routes
  .use(storageCompatRoutes)
  .group("/storage/v1", (app) => app.use(storageCompatRoutes))
  .use((await import("./routes/sdk-proxy")).sdkProxyRoutes)
  .use(await registerAllRoutes())
  .use(grafanaProxyRoutes)

  // Dashboard & SPA Assets (catch-all for everything else)
  .use(registerStaticAssets())

  // Monitoring and diagnostic endpoints
  .get("/monitor/health", async () => {
    const { HealthChecker } = await import("./infra/health");
    return await HealthChecker.runFullCheck();
  });

/**
 * Gateway-inspired try_files static asset serving.
 *
 * Strategy (mirrors `try_files $uri $uri/ /index.html`):
 *   1. If exact file exists on disk, serve it (with content-negotiation for br/gzip)
 *   2. If path is an immutable asset (/_app/, /assets/) but missing, return 404 (NEVER fallback to HTML)
 *   3. If path has no file extension (SPA route like /project/xxx/tables), serve index.html
 *   4. Last resort: embedded assets fallback
 */
export function registerStaticAssets() {
  // Log directory presence once at startup (no full directory scan)
  try {
    const webConsoleDir = getWebConsoleDir();
    const idx = Bun.file(`${webConsoleDir}/index.html`);
    if (idx.size > 0) {
      logger.info(
        `[StaticAssets] Serving from ${webConsoleDir} (try_files mode)`,
      );
    }
  } catch {
    logger.warn(
      `[StaticAssets] ${getWebConsoleDir()} not found, will use embedded fallback`,
    );
  }

  return new Elysia({ name: "static-assets" }).get("*", async (context) => {
    const { request, set } = context;
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;

    // Grafana proxy must win over the SPA catch-all. Elysia resolves `get("*")`
    // before plugin `.all("/grafana/*")` routes, so delegate Grafana GET requests
    // here without registering a global onRequest hook (which would force body
    // parsing on every request and break SDK proxy streaming bodies).
    if (url.pathname === "/grafana" || url.pathname.startsWith("/grafana/")) {
      return handleGrafanaRequest(request);
    }

    // Do NOT catch API routes
    if (path.startsWith("/api/") || path.startsWith("/v1/")) {
      set.status = 404;
      return { message: "Route not found", code: "404" };
    }

    // --- Step 1: try_files $uri, check exact file on disk ---
    try {
      const acceptEncoding = request.headers.get("accept-encoding") || "";
      let diskFile: string | null = null;
      let encoding: "br" | "gzip" | null = null;

      // Content-negotiation: prefer brotli > gzip > raw
      if (acceptEncoding.includes("br") && staticFileExists(path + ".br")) {
        diskFile = path + ".br";
        encoding = "br";
      } else if (
        acceptEncoding.includes("gzip") &&
        staticFileExists(path + ".gz")
      ) {
        diskFile = path + ".gz";
        encoding = "gzip";
      } else if (staticFileExists(path)) {
        diskFile = path;
      }

      if (diskFile) {
        const file = Bun.file(`${getWebConsoleDir()}${diskFile}`);

        // ETag / 304 Not Modified support
        const etag = `W/"${file.lastModified}-${file.size}"`;
        set.headers["ETag"] = etag;
        if (request.headers.get("if-none-match") === etag) {
          set.status = 304;
          return "";
        }

        const extMatch = path.match(/\.[0-9a-z]+$/i);
        const ext = extMatch ? extMatch[0].toLowerCase() : "";
        set.headers["Content-Type"] =
          MIME_TYPES[ext] || "application/octet-stream";

        // Cache policy: HTML always no-cache; immutable hashed assets get permanent cache.
        // immutable hashed assets get permanent cache; everything else gets short cache.
        if (ext === ".html") {
          set.headers["Cache-Control"] = "no-cache";
        } else if (isImmutableAsset(path) || path.match(/\.[0-9a-f]{8,}\./)) {
          set.headers["Cache-Control"] = "public, max-age=31536000, immutable";
        } else {
          set.headers["Cache-Control"] = "public, max-age=3600";
        }

        if (encoding) {
          set.headers["Content-Encoding"] = encoding;
          set.headers["Vary"] = "Accept-Encoding";
        }

        return file;
      }
    } catch (e: unknown) {
      logger.error("[StaticAssets] FS error:", {
        path,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // --- Step 2: immutable asset miss, strict 404 (gateway behavior) ---
    // /_app/immutable/... files are content-hashed; if they don't exist, it's a stale reference.
    // Returning index.html here would cause "Expected JS but got text/html" browser errors.
    const isRootIndexFallback = url.pathname === "/" && path === "/index.html";
    if ((isImmutableAsset(path) || hasFileExtension(path)) && !isRootIndexFallback) {
      set.status = 404;
      return "";
    }

    // --- Step 3: SPA fallback, serve index.html (only for navigation routes) ---
    const indexHtml = await getIndexHtml();
    if (indexHtml) {
      return new Response(indexHtml, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    // --- Step 4: embedded assets fallback (dev mode / no build dir) ---
    try {
      const ASSETS = await getEmbeddedAssets();
      if (ASSETS) {
        let asset = ASSETS[path];
        if (!asset && !hasFileExtension(path)) {
          asset = ASSETS["/index.html"];
        }

        if (asset) {
          set.headers["Content-Type"] = asset.mimeType as string;
          return Buffer.from(asset.content, "base64");
        }
      }

      set.status = 404;
      return "Asset Not Found.";
    } catch {
      set.status = 404;
      return process.env.NODE_ENV !== "production"
        ? "DEV mode: run 'bun run build:all' to build SPA assets."
        : "App Assets Not Built.";
    }
  });
}

/**
 * Register all route modules
 */
const DISABLED_MUTATION_RECONCILIATION_PATH = /^\/v1\/projects\/[^/]+\/mutations\/[^/]+\/reconcile\/?$/;

function isDisabledMutationReconciliation(request: Request): boolean {
  return request.method.toUpperCase() === "POST"
    && DISABLED_MUTATION_RECONCILIATION_PATH.test(new URL(request.url).pathname);
}

export async function registerAllRoutes(): Promise<AnyElysia> {
  const {
    projectRoutes,
    projectDashboardRoutes: registeredProjectDashboardRoutes,
    projectSecretsRoutes,
    projectControlSecretsRoutes,
    projectFunctionsRoutes,
    organizationRoutes,
    userRoutes,
    backupRoutes,
    monitorRoutes,
    maintenanceRoutes,
    extensionRoutes,
    databaseExtensionRoutes,
    systemExtensionRoutes,
    securityRoutes,
    storageRoutes,
    projectStorageRoutes,
    scalingRoutes,
    taskRoutes,
    databaseRoutes,
    databaseJitRoutes,
    authRoutes,
    wechatAuthRoutes,
    chinaAuthRoutes,
    userManagementRoutes,
    authHooksRoutes,
    authSsoRoutes,
    authOAuthServerRoutes,
    authCustomProviderRoutes,
    authMfaRoutes,
    frontendRoutes,
    webhookRoutes,
    deployRoutes,
    chatRoutes,
    platformSettingsRoutes,
    projectLogsRoutes,
    systemRoutes,
    diagnosticsRoutes,
    pgredisRoutes,
    taskEventRoutes,
    logDrainRoutes,
    scheduledFunctionRoutes,
    projectMutationRoutes,
    branchRoutes,
    pgMetaRoutes,
    storageS3Routes,
    autoBranchingRoutes,
    projectRbacRoutes,
    projectWebhookRoutes,
    projectAuditRoutes,
    projectCapabilityRoutes,
    projectAuthHookRuntimeRoutes,
    projectOrganizationRoutes,
    projectCollaboratorRoutes,
    pipelineRoutes,
    databaseWrapperRoutes,
  } = await import("./routes");

  return (
    new Elysia({ name: "api-routes" })
      .onRequest(({ request }) => {
        if (isDisabledMutationReconciliation(request)) {
          return status(403, { error: "Mutation reconciliation is not permitted" });
        }
      })
      .use(bffProofBodyCapture)
      // Auth guard runs before every route in this group
      .onBeforeHandle(async ({ request, set }) => {
        const rateLimit = checkRateLimit(request);
        for (const [key, value] of Object.entries(rateLimit.headers)) {
          set.headers[key] = value;
        }
        if (!rateLimit.allowed) {
          set.status = rateLimit.status;
          if (shouldAuditRequest(request)) {
            await logAuditEvent({ request, status: rateLimit.status, action: "rate_limit_denied" });
          }
          return rateLimit.body;
        }

        if (!isS3DataPlaneRequest(request) && !isInvitationAcceptanceRequest(request)) {
          const result = await checkAuth(request);
          if (result) {
            set.status = result.status;
            if (shouldAuditRequest(request)) {
              await logAuditEvent({ request, status: result.status, action: "auth_denied" });
            }
            return { message: result.body.error, code: String(result.status) };
          }
        }
      })
      .onAfterHandle(async ({ request, set }) => {
        if (shouldAuditRequest(request)) {
          await logAuditEvent({ request, status: Number(set.status || 200) });
        }
      })
      .onError({ as: "global" }, async ({ request, code, error, set }) => {
        if (code === "VALIDATION") {
          if (shouldAuditRequest(request)) {
            await logAuditEvent({ request, status: 400, action: "error:VALIDATION" });
          }
          return validationErrorResponse(set);
        }
        if (shouldAuditRequest(request)) {
          await logAuditEvent({ request, status: Number(set.status || 500), action: `error:${code}` });
        }
        const { isAppError, toAppError } = require("./utils/errors") as typeof import("./utils/errors");
        if (isAppError(error)) {
          set.status = error.statusCode;
          return error.toJSON();
        }
        logger.error(`[API] Unhandled error [${code}]:`, error);
        if (code === "NOT_FOUND") {
          set.status = 404;
          return { message: "Not found", code: "NOT_FOUND" };
        }
        const appError = toAppError(error);
        set.status = appError.statusCode;
        return appError.toJSON();
      })
      .use(projectRoutes)
      .use(registeredProjectDashboardRoutes)
      .use(projectSecretsRoutes)
      .use(projectControlSecretsRoutes)
      .use(projectFunctionsRoutes)
      .use(organizationRoutes)
      .use(userRoutes)
      .use(backupRoutes)
      .use(monitorRoutes)
      .use(maintenanceRoutes)
      .use(extensionRoutes)
      .use(databaseExtensionRoutes)
      .use(systemExtensionRoutes)
      .use(securityRoutes)
      // Register the S3-compatible surface before the generic storage API.
      // Otherwise `/v1/storage/:ref/buckets...` style routes can capture
      // `/v1/storage/:ref/s3/...` requests first.
      .use(storageS3Routes)
      .use(storageRoutes)
      .use(projectStorageRoutes)
      .use(scalingRoutes)
      .use(taskRoutes)
      .use(databaseRoutes)
      .use(databaseJitRoutes)
      .use(authRoutes)
      .use(authRuntimeRoutes)
      .use(wechatAuthRoutes)
      .use(chinaAuthRoutes)
      .use(userManagementRoutes)
      .use(authHooksRoutes)
      .use(authSsoRoutes)
      .use(authOAuthServerRoutes)
      .use(authCustomProviderRoutes)
      .use(authMfaRoutes)
      .use(frontendRoutes)
      .use(webhookRoutes)
      .use(deployRoutes)
      .use(chatRoutes)
      .use(platformSettingsRoutes)
      .use(projectLogsRoutes)
      .use(systemRoutes)
      .use(diagnosticsRoutes)
      .use(pgredisRoutes)
      .use(taskEventRoutes)
      .use(logDrainRoutes)
      .use(scheduledFunctionRoutes)
      .use(projectMutationRoutes)
      .use(branchRoutes)
      .use(pgMetaRoutes)
      .use(autoBranchingRoutes)
      .use(projectRbacRoutes)
      .use(projectWebhookRoutes)
      .use(projectAuditRoutes)
      .use(projectCapabilityRoutes)
      .use(projectAuthHookRuntimeRoutes)
      .use(projectOrganizationRoutes)
      .use(projectCollaboratorRoutes)
      .use(pipelineRoutes)
      .use(databaseWrapperRoutes)
  ) as AnyElysia;
}

function readArgValue(...names: string[]) {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0 && index + 1 < args.length) {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) return value;
    }
  }
  return undefined;
}

/**
 * Auto-detect and stop orphan systemd services for deleted/missing projects.
 * Runs on startup to prevent resource waste from failed cleanup sagas.
 */
async function cleanupOrphanServices() {
  const { $ } = await import("bun");
  const { sql: metaSql } = await import("./db");

  // Get all active project refs from database
  const activeProjects =
    await metaSql`SELECT ref FROM projects WHERE status != 'deleted'`;
  const activeRefs = new Set(
    activeProjects.map((p: Record<string, unknown>) => p.ref),
  );

  // List running supacloud-gotrue and supacloud-pgrst services
  const result =
    await $`systemctl list-units 'supacloud-gotrue@*' 'supacloud-pgrst@*' --all --plain --no-pager`
      .nothrow()
      .quiet();
  const output = result.text();

  const serviceRegex = /supacloud-(gotrue|pgrst)@([^.]+)\.service/g;
  let match;
  let orphanCount = 0;

  while ((match = serviceRegex.exec(output)) !== null) {
    const ref = match[2];
    if (!activeRefs.has(ref)) {
      const unitName = `supacloud-${match[1]}@${ref}.service`;
      logger.info(`[OrphanCleanup] Stopping orphan service: ${unitName}`);
      await $`systemctl stop ${unitName}`.nothrow().quiet();
      await $`systemctl disable ${unitName}`.nothrow().quiet();
      orphanCount++;
    }
  }

  if (orphanCount > 0) {
    await $`systemctl daemon-reload`.nothrow().quiet();
    logger.info(`[OrphanCleanup] Stopped ${orphanCount} orphan service(s).`);
  } else {
    logger.info("[OrphanCleanup] No orphan services detected.");
  }
}

async function recoverDatabaseReplacementsBeforeServe(): Promise<void> {
  const { branchService } = await import("./services/branch.service");
  let lastResult = { checked: 0, recovered: 0, pending: 0 };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResult = await branchService.recoverInterruptedReplacements();
    if (lastResult.pending === 0) break;
    logger.warn("[Bootstrap] Database replacement recovery still pending", {
      attempt,
      ...lastResult,
    });
    if (attempt < 3) await Bun.sleep(attempt * 500);
  }
  if (lastResult.checked > 0) {
    logger.info("[Bootstrap] Database replacement recovery sweep completed", lastResult);
  }
}

/**
 * Core logic: Based on command line arguments, decide whether to execute a single task or start the API server.
 */
async function bootstrap() {
  if (args.includes("--init-db")) {
    const { initDatabase } = await import("./db/init");
    try {
      await initDatabase();
      logger.info("Database initialized successfully!");
      process.exit(0);
    } catch (err: unknown) {
      logger.error("Failed to initialize database:", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  } else if (args.includes("install") || args.includes("--install")) {
    const { runInstall } = await import("./install");
    const forceYes = args.includes("--yes") || args.includes("-y");
    try {
      await runInstall({ forceYes });
      process.exit(0);
    } catch (err: unknown) {
      logger.error("Installation aborted:", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  } else if (args.includes("upgrade") || args.includes("--upgrade")) {
    const { runUpgrade } = await import("./upgrade");
    const forceYes = args.includes("--yes") || args.includes("-y");
    const targetVersion = readArgValue("--target-version", "--release", "--version");
    const edgeRuntimeVersion = readArgValue("--edge-runtime-version");
    const assetBundleDir = readArgValue("--asset-bundle-dir");
    try {
      if (args.includes("--edge-runtime-version") && !edgeRuntimeVersion) {
        throw new Error("--edge-runtime-version requires an exact stable version");
      }
      if (args.includes("--asset-bundle-dir") && !assetBundleDir) {
        throw new Error("--asset-bundle-dir requires an absolute protected directory");
      }
      await runUpgrade({ forceYes, targetVersion, edgeRuntimeVersion, assetBundleDir });
      process.exit(0);
    } catch (err: unknown) {
      logger.error("Upgrade aborted:", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  } else if (args.includes("doctor") || args.includes("--doctor")) {
    const { runDoctor } = await import("./doctor");
    const skipSmokeTest = args.includes("--skip-smoke-test");
    const forceYes = args.includes("--yes") || args.includes("-y");
    try {
      await runDoctor({ skipSmokeTest, forceYes });
      process.exit(0);
    } catch (err: unknown) {
      logger.error("Doctor scan failed:", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  } else if (args.includes("start") || args.includes("up")) {
    const { handleStart } = await import("./cli/lifecycle");
    await handleStart();
    process.exit(0);
  } else if (args.includes("stop") || args.includes("down")) {
    const { handleStop } = await import("./cli/lifecycle");
    await handleStop();
    process.exit(0);
  } else if (args.includes("status") || args.includes("check")) {
    const { handleStatus } = await import("./cli/lifecycle");
    await handleStatus();
    process.exit(0);
  } else if (args[0] === "logs") {
    const { handleLogs } = await import("./cli/lifecycle");
    const serviceTarget =
      args[1] && !args[1].startsWith("-") ? args[1] : undefined;
    await handleLogs(serviceTarget);
    process.exit(0);
  } else if (args[0] === "project") {
    const {
      handleProjectCreate,
      handleProjectList,
      handleProjectGet,
      handleProjectDelete,
      handleProjectPause,
      handleProjectRestore,
      handleProjectRestart,
      handleProjectKeys,
      handleProjectRotateKeys,
      handleProjectRotateOpaqueKeys,
      printProjectHelp,
    } = await import("./cli/project");
    const subCommand = args[1];
    if (args.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
      printProjectHelp();
      process.exit(0);
    }
    switch (subCommand) {
      case "create":
        await handleProjectCreate(args.slice(2));
        break;
      case "list":
      case "ls":
        await handleProjectList();
        break;
      case "get":
        if (!args[2]) {
          logger.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectGet(args[2]);
        break;
      case "delete":
      case "rm":
        if (!args[2]) {
          logger.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectDelete(args[2], args.slice(3));
        break;
      case "pause":
        if (!args[2]) {
          logger.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectPause(args[2]);
        break;
      case "restore":
        if (!args[2]) {
          logger.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectRestore(args[2]);
        break;
      case "restart":
        if (!args[2]) {
          logger.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectRestart(args[2]);
        break;
      case "keys":
        if (!args[2]) {
          logger.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectKeys(args[2]);
        break;
      case "rotate-keys":
        if (!args[2]) {
          logger.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectRotateKeys(args[2], args.slice(3));
        break;
      case "rotate-opaque-keys":
        if (!args[2]) {
          logger.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectRotateOpaqueKeys(args[2], args.slice(3));
        break;
      case "--help":
      case "-h":
      default:
        printProjectHelp();
        process.exit(0);
    }
    process.exit(0);
  } else if (args.includes("--version") || args.includes("-v")) {
    const pkg = await import("../package.json");
    logger.info(`SupaCloud Version: ${pkg.version}`);
    process.exit(0);
  } else if (args.includes("--help") || args.includes("-h")) {
    process.exit(0);
  } else if (args.length === 0 || args.includes("--server")) {
    const { validateRealtimeSecretConfiguration } = await import("./services/realtime.service");
    validateRealtimeSecretConfiguration();
    const { sql: controlPlaneSql } = await import("./db");
    const { assertPlatformMigrationCompleted } = await import("./db/audit-chain-migration");
    const {
      ensurePlatformV2SchemaInTransaction,
      migrateLegacyProjectWebhooks,
      migrateLegacyProviderLinkingConfig,
      migrateWebhookSecretsToControlStore,
    } = await import("./db/platform-v2");
    await ensurePlatformV2SchemaInTransaction(controlPlaneSql);
    await assertPlatformMigrationCompleted(controlPlaneSql);
    await migrateLegacyProjectWebhooks(controlPlaneSql);
    await migrateWebhookSecretsToControlStore(controlPlaneSql);
    await migrateLegacyProviderLinkingConfig(controlPlaneSql);

    const { jitDatabaseAccessService } = await import("./services/jit-database-access.service");
    const jitGatewayState = await jitDatabaseAccessService.startGateway();
    if (jitGatewayState.errors.length > 0) {
      logger.error("[JitDatabaseGateway] Some persisted bindings were not restored", {
        started: jitGatewayState.started,
        errors: jitGatewayState.errors,
      });
    }

    try {
      const { moved } = await migrateLegacyVersionArtifacts();
      if (moved > 0) {
        logger.info(`[EdgeFunction] Migrated ${moved} legacy version artifact(s) into .versions/`);
      }
    } catch (err: unknown) {
      logger.error("Failed to migrate legacy edge-function version artifacts", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }

    await recoverDatabaseReplacementsBeforeServe();

    await waitForGatewayBeforeServe();

    const { recoverFrontendReleasesBeforeServe } =
      await import("./workers/frontend-release-recovery.worker");
    await recoverFrontendReleasesBeforeServe();

    await reconcileGatewayBeforeServe();

    Bun.serve({
      port: config.port,
      maxRequestBodySize: config.maxRequestBodySize,
      idleTimeout: 255,
      websocket: {
        open(ws) {
          const data = ws.data as unknown as {
            kind?: "tasks" | "realtimeProxy";
            upstreamUrl: string;
            requestHeaders: Record<string, string>;
            upstream?: WebSocket;
            __buffer?: string[];
          };
          if (data.kind === "tasks") {
            void openTaskWebSocket(ws as never);
            return;
          }
          const { upstreamUrl, requestHeaders } = data;
          const upstream = new (WebSocket as any)(upstreamUrl, {
            headers: requestHeaders,
          });

          data.upstream = upstream;

          upstream.addEventListener("open", () => {
            const buffer = data.__buffer;
            if (buffer) {
              for (const msg of buffer) {
                upstream.send(msg);
              }
              data.__buffer = [];
            }
          });

          upstream.addEventListener("message", (event: any) => {
            try {
              ws.send(event.data as string | ArrayBufferLike);
            } catch {
              // downstream closed, will be cleaned up in close handler
            }
          });

          upstream.addEventListener("close", (event: any) => {
            try {
              ws.close(event.code, event.reason);
            } catch {
              /* already closed */
            }
          });

          upstream.addEventListener("error", () => {
            try {
              ws.close(1011, "Upstream connection error");
            } catch {
              /* already closed */
            }
          });
        },
        message(ws, message) {
          const data = ws.data as unknown as {
            kind?: "tasks" | "realtimeProxy";
            upstream?: WebSocket;
            __buffer?: string[];
          };
          if (data.kind === "tasks") {
            void messageTaskWebSocket(ws as never, message);
            return;
          }
          const upstream = data.upstream;
          if (!upstream) return;

          if (upstream.readyState === WebSocket.OPEN) {
            if (typeof message === "string") {
              upstream.send(message);
            } else {
              upstream.send(message as unknown as ArrayBuffer);
            }
          } else if (upstream.readyState === WebSocket.CONNECTING) {
            if (!data.__buffer) {
              data.__buffer = [];
            }
            data.__buffer.push(message as string);
          }
        },
        close(ws, code, reason) {
          const data = ws.data as unknown as { kind?: "tasks" | "realtimeProxy" };
          if (data.kind === "tasks") {
            closeTaskWebSocket(ws as never);
            return;
          }
          const upstream = (ws.data as unknown as { upstream?: WebSocket })
            ?.upstream;
          if (upstream && upstream.readyState !== WebSocket.CLOSED) {
            try {
              upstream.close(code, reason);
            } catch {
              /* already closed */
            }
          }
        },
      },
      async fetch(request: Request, server: any) {
        recordRequestPeerAddress(request, server.requestIP(request)?.address);
        const url = new URL(request.url);

        // ── Realtime WebSocket proxy ──────────────────────────────
        // Intercept WebSocket upgrade requests for /realtime/v1 before Elysia
        if (
          url.pathname === "/ws/tasks" &&
          request.headers.get("upgrade")?.toLowerCase() === "websocket"
        ) {
          const upgraded = server.upgrade(request, {
            data: { kind: "tasks", request },
          });
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        if (
          url.pathname.startsWith("/realtime/v1") &&
          request.headers.get("upgrade")?.toLowerCase() === "websocket"
        ) {
          const apikey = request.headers.get("apikey") || url.searchParams.get("apikey") || "";
          if (!apikey) {
            return new Response("Missing apikey", { status: 401 });
          }

          const resolvedApiKey = await resolveProjectApiKey(apikey);
          const projectRef = resolvedApiKey?.ref || "";

          if (!resolvedApiKey || !projectRef) {
            return new Response("Invalid apikey", { status: 401 });
          }

          const requestedRef =
            request.headers.get("x-project-ref") ||
            request.headers.get("x-supabase-project") ||
            url.searchParams.get("ref") ||
            "";
          if (requestedRef && requestedRef !== projectRef) {
            return new Response("Project reference does not match apikey", { status: 403 });
          }

          // Convert the configured HTTP Realtime URL to a WS URL
          const wsBase = config.realtimeAdminUrl
            .replace(/^http:/, "ws:")
            .replace(/^https:/, "wss:");
          // Supabase Realtime container expects /websocket, not /realtime/v1/websocket
          const wsPath = url.pathname.replace(/^\/realtime\/v1/, "/socket");
          const translatedCredentials = translateRealtimeProxyCredentials({
            url,
            requestHeaders: request.headers,
            candidateKey: apikey,
            resolved: resolvedApiKey,
          });
          const upstreamUrl = `${wsBase}${wsPath}${translatedCredentials.search}`;
          // Forward relevant request headers and align websocket proxy headers with HTTP sdk-proxy.
          const requestHeaders = translatedCredentials.forwardHeaders;
          // Supabase Realtime identifies tenants by extracting the first subdomain
          // from the Host header and matching it against registered external_id
          // (which is the project ref). Custom domains like "sapi.aorist.net" would
          // extract "sapi" instead of the project ref, breaking tenant resolution.
          // Therefore, the Host header to Elixir must always use the ref-based format.
          const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
          const tenantHost = isCI
            ? "realtime-dev.supabase-realtime"
            : `${projectRef}.api.${config.baseDomain}`;
          requestHeaders["host"] = tenantHost;
          requestHeaders["x-forwarded-host"] = url.host;
          requestHeaders["x-project-ref"] = projectRef;
          requestHeaders["x-forwarded-proto"] = url.protocol.replace(":", "");
          requestHeaders["x-forwarded-for"] =
            request.headers.get("x-forwarded-for") || "127.0.0.1";

          const upgraded = server.upgrade(request, {
            data: { kind: "realtimeProxy", upstreamUrl, requestHeaders, projectRef },
          });
          if (upgraded) return undefined; // Bun will handle the WebSocket
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        // Everything else goes through Elysia
        return withLogicalBackupMutationTimeoutController(
          request,
          server,
          () => app.fetch(request),
        );
      },
    });
    const { taskWorker } = await import("./services/task.worker");
    taskWorker.start();

    const { startQueueWorker } = await import("./workers/queue.worker");
    startQueueWorker();

    const { backgroundFunctionWorker } = await import("./services/background-function-worker");
    backgroundFunctionWorker.start();

    const { startStorageReconcileWorker } =
      await import("./workers/storage-reconcile.worker");
    startStorageReconcileWorker();

    const { startRuntimeReconcileWorker } =
      await import("./workers/runtime-reconcile.worker");
    startRuntimeReconcileWorker();

    const { startBranchReplacementRecoveryWorker } =
      await import("./workers/branch-replacement-recovery.worker");
    startBranchReplacementRecoveryWorker();

    const { startFrontendReleaseRecoveryWorker } =
      await import("./workers/frontend-release-recovery.worker");
    startFrontendReleaseRecoveryWorker();

    const { scheduledFunctionWorker } = await import("./workers/scheduled-function.worker");
    scheduledFunctionWorker.start();

    const { startLogDrainForwarder } = await import("./workers/log-drain-forwarder.worker");
    startLogDrainForwarder();

    const { startLocalLogCollector } = await import("./workers/local-log-collector.worker");
    startLocalLogCollector();

    const { startGatewayHealthWorker } = await import("./workers/gateway-health.worker");
    startGatewayHealthWorker();

    const { startWebhookDeliveryWorker } = await import("./workers/webhook-delivery.worker");
    startWebhookDeliveryWorker();

    const { postgresMajorUpgradeService } = await import("./services/postgres-major-upgrade.service");
    postgresMajorUpgradeService.startWorker();

    if (config.edgeRuntimeMode === "embedded") {
      const { edgeRuntimeManager } =
        await import("./plugins/edge-runtime-manager");
      edgeRuntimeManager
        .start()
        .catch((err: unknown) =>
          logger.error("[EdgeRuntime] Failed to start", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    } else {
      logger.info("[EdgeRuntime] External runtime mode enabled; skipping embedded child process startup.");
    }

    // Auto-detect and stop orphan services for deleted projects
    cleanupOrphanServices().catch((err) =>
      logger.warn(
        "[Bootstrap] Orphan service cleanup failed (non-fatal):",
        err,
      ),
    );

    logger.info(`
    ============================================================
             SupaCloud Management API
    ------------------------------------------------------------
      Server running at: http://localhost:${config.port}
      Swagger docs at:   http://localhost:${config.port}/swagger
    ============================================================
    `);
  } else {
    logger.error(`Unknown command or argument: ${args.join(" ")}`);
    process.exit(1);
  }
}

export function startManagementApi(): void {
  void runBootstrapOrExit(bootstrap);

  const shutdown = async (signal: string) => {
    logger.info(`\nReceived ${signal}. Gracefully shutting down...`);
    try {
      const { taskWorker } = await import("./services/task.worker");
      taskWorker.stop();
      if (config.edgeRuntimeMode === "embedded") {
        const { edgeRuntimeManager } =
          await import("./plugins/edge-runtime-manager");
        edgeRuntimeManager.stop();
      }
      const { stopQueueWorker } = await import("./workers/queue.worker");
      stopQueueWorker();
      const { stopStorageReconcileWorker } =
        await import("./workers/storage-reconcile.worker");
      stopStorageReconcileWorker();
      const { stopRuntimeReconcileWorker } =
        await import("./workers/runtime-reconcile.worker");
      stopRuntimeReconcileWorker();
      const { stopBranchReplacementRecoveryWorker } =
        await import("./workers/branch-replacement-recovery.worker");
      stopBranchReplacementRecoveryWorker();
      const { stopFrontendReleaseRecoveryWorker } =
        await import("./workers/frontend-release-recovery.worker");
      stopFrontendReleaseRecoveryWorker();
      const { scheduledFunctionWorker } =
        await import("./workers/scheduled-function.worker");
      scheduledFunctionWorker.stop();
      const { stopLogDrainForwarder } =
        await import("./workers/log-drain-forwarder.worker");
      stopLogDrainForwarder();
      const { stopLocalLogCollector } =
        await import("./workers/local-log-collector.worker");
      stopLocalLogCollector();
      const { stopGatewayHealthWorker } =
        await import("./workers/gateway-health.worker");
      stopGatewayHealthWorker();
      const { stopWebhookDeliveryWorker } =
        await import("./workers/webhook-delivery.worker");
      stopWebhookDeliveryWorker();
      const { postgresMajorUpgradeService } = await import("./services/postgres-major-upgrade.service");
      postgresMajorUpgradeService.stopWorker();
      const { jitDatabaseAccessService } = await import("./services/jit-database-access.service");
      jitDatabaseAccessService.stopGateway();
    } catch (e: unknown) {
      logger.debug("[index] suppressed error", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    try {
      await closeDb();
      logger.info("Database connections released.");
    } catch (e: unknown) {
      logger.debug("[index] suppressed error", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) {
  startManagementApi();
}

export { app };
