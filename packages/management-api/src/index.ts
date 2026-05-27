import { Elysia, t } from "elysia";
import { logger } from "./utils/logger";
import { isStaticServeCommand } from "./config";

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
import { cors } from "@elysiajs/cors";

import { config } from "./config";
import { checkAuth } from "./middleware/auth";
import { checkRateLimit } from "./middleware/rate-limit";
import { logAuditEvent, shouldAuditRequest } from "./services/audit.service";
import { closeDb, sql } from "./db";
import { authRoutes, deployRoutes, storageCompatRoutes } from "./routes";
import { migrateLegacyVersionArtifacts } from "./services/edge-function.service";
import { resolveRealtimeTenantHost } from "./utils/sdk-parity";
import { resolveProjectRefFromApiKey } from "./utils/project-auth";
import { isFrontendDomain } from "./utils/frontend-domains";

const WEB_CONSOLE_CURRENT_DIR = "/opt/supacloud/web-console/current";
const WEB_CONSOLE_LEGACY_DIR = "/opt/supacloud/packages/web-console/build";

function getWebConsoleDir(): string {
  if (process.env.WEB_CONSOLE_DIR) return process.env.WEB_CONSOLE_DIR;
  try {
    if (Bun.file(`${WEB_CONSOLE_CURRENT_DIR}/index.html`).size > 0) {
      return WEB_CONSOLE_CURRENT_DIR;
    }
  } catch {
    // Fall back to the legacy source-tree build path for pre-binary installs.
  }
  return WEB_CONSOLE_LEGACY_DIR;
}

const configuredCorsOrigins = config.corsOrigins
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOrigin = configuredCorsOrigins.length > 0
  ? ({ headers }: { headers: Headers }) => {
      const origin = headers.get("origin");
      return origin ? configuredCorsOrigins.includes(origin) : false;
    }
  : config.nodeEnv === "production"
    ? false
    : true;

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

const args = process.argv.slice(2);

if (isStaticServeCommand()) {
  const { runStaticServeCli } = await import("./utils/bun-static-serve");
  runStaticServeCli(args.slice(1));
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  process.exit(0);
}

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

// Initialize Master Routes in Kong dynamically to avoid circular / initialization reference errors
try {
  const { gatewayService } = await import("./services/gateway.service");
  await gatewayService.setupMasterRoutes();
} catch (e) {
  logger.error(
    "Failed to setup master routes",
    e instanceof Error ? e.message : String(e),
  );
}

const app = new Elysia({ strictPath: false })
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
  // CORS
  .use(
    cors({
      origin: corsOrigin,
      credentials: configuredCorsOrigins.length > 0,
      exposeHeaders: [
        "x-total-count",
        "link",
        "content-range",
        "x-supabase-api-version",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
      ],
      maxAge: 86400,
    }),
  )

  // Rate limit headers + API version (Studio compatibility)
  .onAfterHandle(({ set }) => {
    set.headers ??= {};
    set.headers["x-ratelimit-limit"] = "1000";
    set.headers["x-ratelimit-remaining"] = "999";
    set.headers["x-ratelimit-reset"] = String(
      Math.ceil(Date.now() / 60000) * 60,
    );
    set.headers["x-supabase-api-version"] = "2024-01-01";
  })

  // Health check (no auth required)
  .get("/health", () => ({ status: "ok", timestamp: new Date().toISOString() }))

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

  // ─── Studio Login (no auth required) ──────────────────────────────────
  .post("/auth/login", async ({ body, set }) => {
    const { username, password } = body as {
      username: string;
      password: string;
    };
    if (
      username === config.studioUsername &&
      password === config.studioPassword
    ) {
      // Generate a simple HMAC-based session token (valid for 24h)
      const payload = JSON.stringify({
        user: username,
        exp: Date.now() + 86400000,
      });
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(config.masterToken),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(payload),
      );
      const token =
        btoa(payload) +
        "." +
        Array.from(new Uint8Array(sig))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      return { success: true, token };
    }
    set.status = 401;
    return { success: false, message: "Invalid username or password", code: "401" };
  }, {
    body: t.Object({
      username: t.String(),
      password: t.String(),
    }),
    detail: { tags: ["auth"], summary: "Studio login" },
  })
  .post("/auth/verify", async ({ body }) => {
    const { token } = body as { token: string };
    try {
      const [payloadB64, sigHex] = token.split(".");
      const payload = JSON.parse(atob(payloadB64));
      if (payload.exp < Date.now()) return { valid: false, error: "expired" };
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(config.masterToken),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(JSON.stringify(payload)),
      );
      const expected = Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      // Use timing-safe comparison to prevent timing attacks
      const sigBuf = Buffer.from(sigHex, "hex");
      const expBuf = Buffer.from(expected, "hex");
      const valid =
        sigBuf.length === expBuf.length &&
        crypto.timingSafeEqual(sigBuf, expBuf);
      return { valid };
    } catch (err: unknown) {
      logger.warn("[Auth] Failed to verify session token signature", {
        error: err,
      });
      return { valid: false };
    }
  }, {
    body: t.Object({
      token: t.String(),
    }),
    detail: { tags: ["auth"], summary: "Verify session token" },
  })

  .get("/v1/gateway/caddy/ask", async ({ query }) => {
    const domain = String((query as Record<string, unknown>).domain || (query as Record<string, unknown>).host || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/:\d+$/, "");
    if (!domain) {
      return new Response("missing domain", { status: 400 });
    }
    if (domain === config.baseDomain || domain.endsWith(`.${config.baseDomain}`)) {
      return new Response("ok");
    }
    const rows = await sql`
      SELECT ref FROM projects
      WHERE status != 'deleted'
        AND deleted_at IS NULL
        AND config::text ILIKE ${`%${domain}%`}
      LIMIT 1
    `;
    if (rows.length > 0) return new Response("ok");
    if (await isFrontendDomain(domain)) return new Response("ok");
    return new Response("domain not allowed", { status: 403 });
  }, {
    detail: { tags: ["gateway"], summary: "Authorize Caddy On-Demand TLS domain" },
  })

  // WebSocket routes (no HTTP auth guard; WS uses query token)
  .use((await import("./routes/ws")).wsRoutes)

  // Main API Routes
  .use(storageCompatRoutes)
  .group("/storage/v1", (app) => app.use(storageCompatRoutes))
  .use((await import("./routes/sdk-proxy")).sdkProxyRoutes)
  .use(await registerAllRoutes())

  // Dashboard & SPA Assets (catch-all for everything else)
  .use(registerStaticAssets())

  // Monitoring and diagnostic endpoints
  .get("/monitor/health", async () => {
    const { HealthChecker } = await import("./infra/health");
    return await HealthChecker.runFullCheck();
  })

  // Error handling (with DB graceful degradation)
  .onError(({ code, error, set }) => {
    const { isAppError, toAppError } = require("./utils/errors") as typeof import("./utils/errors");

    if (isAppError(error)) {
      set.status = error.statusCode;
      return error.toJSON();
    }

    logger.error(`Error [${code}]:`, error);

    if (code === "VALIDATION") {
      set.status = 400;
      return {
        message: "Validation failed",
        code: "VALIDATION_ERROR",
        details: error.message,
      };
    }

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

        // Cache policy: HTML always no-cache (prevents Kong from caching stale index.html);
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
export async function registerAllRoutes() {
  const {
    projectRoutes,
    projectDashboardRoutes: registeredProjectDashboardRoutes,
    projectSecretsRoutes,
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
    authRoutes,
    wechatAuthRoutes,
    chinaAuthRoutes,
    userManagementRoutes,
    authHooksRoutes,
    authSsoRoutes,
    authOAuthServerRoutes,
    authMfaRoutes,
    frontendRoutes,
    webhookRoutes,
    deployRoutes,
    chatRoutes,
    platformSettingsRoutes,
    projectLogsRoutes,
    systemRoutes,
    diagnosticsRoutes,
  } = await import("./routes");

  return (
    new Elysia({ name: "api-routes" })
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

        const result = await checkAuth(request);
        if (result) {
          set.status = result.status;
          if (shouldAuditRequest(request)) {
            await logAuditEvent({ request, status: result.status, action: "auth_denied" });
          }
          return { message: result.body.error, code: String(result.status) };
        }
      })
      .onAfterHandle(async ({ request, set }) => {
        if (shouldAuditRequest(request)) {
          await logAuditEvent({ request, status: Number(set.status || 200) });
        }
      })
      .onError(async ({ request, code, error, set }) => {
        if (shouldAuditRequest(request)) {
          await logAuditEvent({ request, status: Number(set.status || 500), action: `error:${code}` });
        }
        const { isAppError, toAppError } = require("./utils/errors") as typeof import("./utils/errors");
        if (isAppError(error)) {
          set.status = error.statusCode;
          return error.toJSON();
        }
        logger.error(`[API] Unhandled error [${code}]:`, error);
        if (code === "VALIDATION") {
          set.status = 400;
          return { message: "Validation failed", code: "VALIDATION_ERROR", details: error.message };
        }
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
      .use(storageRoutes)
      .use(projectStorageRoutes)
      .use(scalingRoutes)
      .use(taskRoutes)
      .use(databaseRoutes)
      .use(authRoutes)
      .use(wechatAuthRoutes)
      .use(chinaAuthRoutes)
      .use(userManagementRoutes)
      .use(authHooksRoutes)
      .use(authSsoRoutes)
      .use(authOAuthServerRoutes)
      .use(authMfaRoutes)
      .use(frontendRoutes)
      .use(webhookRoutes)
      .use(deployRoutes)
      .use(chatRoutes)
      .use(platformSettingsRoutes)
      .use(projectLogsRoutes)
      .use(systemRoutes)
      .use(diagnosticsRoutes)
  );
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
    try {
      await runUpgrade({ forceYes, targetVersion });
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
      printProjectHelp,
    } = await import("./cli/project");
    const subCommand = args[1];
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
      case "--help":
      case "-h":
      default:
        printProjectHelp();
        process.exit(0);
    }
    process.exit(0);
  } else if (isStaticServeCommand()) {
    const { runStaticServeCli } = await import("./utils/bun-static-serve");
    runStaticServeCli(args.slice(1));
  } else if (args.includes("--version") || args.includes("-v")) {
    const pkg = await import("../package.json");
    logger.info(`SupaCloud Version: ${pkg.version}`);
    process.exit(0);
  } else if (args.includes("--help") || args.includes("-h")) {
    process.exit(0);
  } else if (args.length === 0 || args.includes("--server")) {
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

    Bun.serve({
      port: config.port,
      maxRequestBodySize: config.maxRequestBodySize,
      idleTimeout: 255,
      websocket: {
        open(ws) {
          const data = ws.data as unknown as {
            upstreamUrl: string;
            requestHeaders: Record<string, string>;
            upstream?: WebSocket;
            __buffer?: string[];
          };
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
            upstream?: WebSocket;
            __buffer?: string[];
          };
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
        const url = new URL(request.url);

        // ── Realtime WebSocket proxy ──────────────────────────────
        // Intercept WebSocket upgrade requests for /realtime/v1 before Elysia
        if (
          url.pathname.startsWith("/realtime/v1") &&
          request.headers.get("upgrade")?.toLowerCase() === "websocket"
        ) {
          const apikey = request.headers.get("apikey") || url.searchParams.get("apikey") || "";
          if (!apikey) {
            return new Response("Missing apikey", { status: 401 });
          }

          const projectRef = await resolveProjectRefFromApiKey(apikey) || "";

          if (!projectRef) {
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
          const upstreamUrl = `${wsBase}${wsPath}${url.search}`;
          // Forward relevant request headers and align websocket proxy headers with HTTP sdk-proxy.
          const requestHeaders: Record<string, string> = {};
          const forwardHeaders = [
            "apikey",
            "authorization",
            "sec-websocket-protocol",
          ];
          for (const h of forwardHeaders) {
            const val = request.headers.get(h);
            if (val) requestHeaders[h] = val;
          }
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
            data: { upstreamUrl, requestHeaders, projectRef },
          });
          if (upgraded) return undefined; // Bun will handle the WebSocket
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        // Everything else goes through Elysia
        return app.fetch(request);
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

if (import.meta.main) {
  bootstrap();

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

export { app };
