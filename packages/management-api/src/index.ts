import { Elysia } from "elysia";
import { logger } from "./utils/logger";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";

try {
  const envFile = Bun.file('/opt/supacloud/config.env');
  if (envFile.size > 0) {
    const text = await envFile.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.slice(0, eqIdx).trim();
      // Strip surrounding quotes (both single and double) from the value
      const rawVal = trimmed.slice(eqIdx + 1).trim();
      const val = rawVal.replace(/^["']|["']$/g, '');
      if (key && /^[A-Z0-9_]+$/.test(key) && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
} catch (e: unknown) {
  // Ignore - config.env may not exist in dev mode
}

import { config } from "./config";
import { checkAuth } from "./middleware/auth";
import { closeDb } from "./db";
import { authRoutes, deployRoutes, storageCompatRoutes } from "./routes";

const WEB_CONSOLE_DIR = "/opt/supacloud/packages/web-console/build";

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

let _embeddedAssets: Record<string, { content: string; encoding: string; mimeType: string }> | null = null;
async function getEmbeddedAssets() {
  if (!_embeddedAssets) {
    try {
      const mod = await import("./assets.gen") as Record<string, unknown>;
      _embeddedAssets = (mod.EMBEDDED_ASSETS as typeof _embeddedAssets) ?? {};
    } catch {
      logger.debug("Failed to load embedded assets (assets.gen.ts not found), using empty fallback.");
      _embeddedAssets = {};
    }
  }
  return _embeddedAssets;
}

// --- Caddy/Angie-style try_files static asset serving ---
// No pre-warmed Set. Direct disk checks per request (Bun.file is near-zero-cost).
// index.html is cached in memory with mtime-based invalidation.
let _cachedIndexHtml: string | null = null;
let _indexHtmlMtime: number = 0;

/** Check if a static asset exists on disk (O(1) syscall) */
function staticFileExists(relativePath: string): boolean {
  try {
    const f = Bun.file(`${WEB_CONSOLE_DIR}${relativePath}`);
    return f.size > 0;
  } catch {
    return false;
  }
}

/** Determine if a path is an immutable hashed asset (should never SPA-fallback) */
function isImmutableAsset(path: string): boolean {
  return path.startsWith('/_app/') || path.startsWith('/assets/');
}

/** Determine if a path looks like a static file request (has a file extension) */
function hasFileExtension(path: string): boolean {
  const lastSegment = path.split('/').pop() || '';
  return lastSegment.includes('.');
}

/** Get index.html with mtime-based cache invalidation */
async function getIndexHtml(): Promise<string | null> {
  try {
    const file = Bun.file(`${WEB_CONSOLE_DIR}/index.html`);
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
  logger.error("Failed to setup master routes", e instanceof Error ? e.message : String(e));
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
          { name: "organizations", description: "Organization management endpoints" },
          { name: "user", description: "User profile endpoints" },
          { name: "backups", description: "Database backup and restore endpoints" },
          { name: "monitor", description: "Database monitoring and health endpoints" },
          { name: "maintenance", description: "High availability and cluster maintenance" },
          { name: "extensions", description: "PostgreSQL extension management (Market)" },
          { name: "security", description: "Firewall and SSL security management" },
          { name: "storage", description: "JuiceFS storage and S3 migration management" },
          { name: "scaling", description: "Auto-scaling and vertical upgrade management" },
          { name: "tasks", description: "Background task monitoring" },
          { name: "auth", description: "Authentication and OAuth provider management" },
          { name: "frontend", description: "Frontend hosting and deployment management" },
          { name: "webhook", description: "GitHub webhook and CI/CD integration" },
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
    })
  )
  // CORS
  .use(cors())

  // Health check (no auth required)
  .get("/health", () => ({ status: "ok", timestamp: new Date().toISOString() }))

  // ─── Studio Login (no auth required) ──────────────────────────────────
  .post("/auth/login", async ({ body, set }) => {
    const { username, password } = body as { username: string; password: string };
    if (username === config.studioUsername && password === config.studioPassword) {
      // Generate a simple HMAC-based session token (valid for 24h)
      const payload = JSON.stringify({ user: username, exp: Date.now() + 86400000 });
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", encoder.encode(config.masterToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
      const token = btoa(payload) + "." + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
      return { success: true, token };
    }
    set.status = 401;
    return { success: false, error: "用户名或密码错误" };
  })
  .post("/auth/verify", async ({ body }) => {
    const { token } = body as { token: string };
    try {
      const [payloadB64, sigHex] = token.split(".");
      const payload = JSON.parse(atob(payloadB64));
      if (payload.exp < Date.now()) return { valid: false, error: "expired" };
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", encoder.encode(config.masterToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(payload)));
      const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
      // Use timing-safe comparison to prevent timing attacks
      const sigBuf = Buffer.from(sigHex, 'hex');
      const expBuf = Buffer.from(expected, 'hex');
      const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
      return { valid };
    } catch (err: unknown) {
      logger.warn("[Auth] Failed to verify session token signature", { error: err });
      return { valid: false };
    }
  })

  // WebSocket routes (no HTTP auth guard — WS uses query token)
  .use((await import("./routes/ws")).wsRoutes)

  // Main API Routes
  .use(storageCompatRoutes)
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
    logger.error(`Error [${code}]:`, error);

    if (code === "VALIDATION") {
      set.status = 400;
      return { error: "Validation failed", details: error.message };
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Not found" };
    }

    // DB connection errors → 503 Service Unavailable (not 500)
    const errMsg = error instanceof Error ? error.message : String(error);
    if (
      errMsg.includes("ECONNREFUSED") ||
      errMsg.includes("Connection terminated") ||
      errMsg.includes("connection refused") ||
      errMsg.includes("exhausted all")
    ) {
      set.status = 503;
      set.headers["Retry-After"] = "5";
      return { error: "Service temporarily unavailable", retryAfter: 5 };
    }

    set.status = 500;
    return { error: "Internal server error" };
  });



/**
 * Caddy/Angie-inspired try_files static asset serving.
 *
 * Strategy (mirrors `try_files $uri $uri/ /index.html`):
 *   1. If exact file exists on disk → serve it (with content-negotiation for br/gzip)
 *   2. If path is an immutable asset (/_app/, /assets/) but missing → 404 (NEVER fallback to HTML)
 *   3. If path has no file extension (SPA route like /project/xxx/tables) → serve index.html
 *   4. Last resort: embedded assets fallback
 */
export function registerStaticAssets() {
  // Log directory presence once at startup (no full directory scan)
  try {
    const idx = Bun.file(`${WEB_CONSOLE_DIR}/index.html`);
    if (idx.size > 0) {
      logger.info(`[StaticAssets] Serving from ${WEB_CONSOLE_DIR} (try_files mode)`);
    }
  } catch {
    logger.warn(`[StaticAssets] ${WEB_CONSOLE_DIR} not found, will use embedded fallback`);
  }

  return new Elysia({ name: "static-assets" }).get("*", async (context) => {
    const { request, set } = context;
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;

    // Do NOT catch API routes
    if (path.startsWith("/api/") || path.startsWith("/v1/")) {
      set.status = 404;
      return { error: "Route not found" };
    }

    // --- Step 1: try_files $uri — check exact file on disk ---
    try {
      const acceptEncoding = request.headers.get('accept-encoding') || '';
      let diskFile: string | null = null;
      let encoding: 'br' | 'gzip' | null = null;

      // Content-negotiation: prefer brotli > gzip > raw
      if (acceptEncoding.includes('br') && staticFileExists(path + '.br')) {
        diskFile = path + '.br';
        encoding = 'br';
      } else if (acceptEncoding.includes('gzip') && staticFileExists(path + '.gz')) {
        diskFile = path + '.gz';
        encoding = 'gzip';
      } else if (staticFileExists(path)) {
        diskFile = path;
      }

      if (diskFile) {
        const file = Bun.file(`${WEB_CONSOLE_DIR}${diskFile}`);
        
        // ETag / 304 Not Modified support
        const etag = `W/"${file.lastModified}-${file.size}"`;
        set.headers["ETag"] = etag;
        if (request.headers.get("if-none-match") === etag) {
          set.status = 304;
          return "";
        }

        const extMatch = path.match(/\.[0-9a-z]+$/i);
        const ext = extMatch ? extMatch[0].toLowerCase() : '';
        set.headers["Content-Type"] = MIME_TYPES[ext] || "application/octet-stream";

        // Immutable hashed assets get permanent cache; everything else gets short cache
        set.headers["Cache-Control"] = isImmutableAsset(path) || path.match(/\.[0-9a-f]{8,}\./)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600";

        if (encoding) {
          set.headers["Content-Encoding"] = encoding;
          set.headers["Vary"] = "Accept-Encoding";
        }

        return file;
      }
    } catch (e: unknown) {
      logger.error("[StaticAssets] FS error:", { path, error: e instanceof Error ? e.message : String(e) });
    }

    // --- Step 2: immutable asset miss → strict 404 (Caddy/Angie behavior) ---
    // /_app/immutable/... files are content-hashed; if they don't exist, it's a stale reference.
    // Returning index.html here would cause "Expected JS but got text/html" browser errors.
    if (isImmutableAsset(path) || hasFileExtension(path)) {
      set.status = 404;
      return "";
    }

    // --- Step 3: SPA fallback → serve index.html (only for navigation routes) ---
    const indexHtml = await getIndexHtml();
    if (indexHtml) {
      return new Response(indexHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }
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
          return Buffer.from(asset.content, 'base64');
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
    projectRoutes, projectSecretsRoutes, projectFunctionsRoutes, organizationRoutes, userRoutes, backupRoutes,
    monitorRoutes, maintenanceRoutes, extensionRoutes, systemExtensionRoutes, securityRoutes,
    storageRoutes, scalingRoutes, taskRoutes, databaseRoutes, authRoutes,
    wechatAuthRoutes, chinaAuthRoutes, userManagementRoutes,
    frontendRoutes, webhookRoutes, deployRoutes,
    chatRoutes, platformSettingsRoutes, projectLogsRoutes, systemRoutes
  } = await import("./routes");

  return new Elysia({ name: "api-routes" })
    // Auth guard — runs before every route in this group
    .onBeforeHandle(async ({ request, set }) => {
      const result = await checkAuth(request);
      if (result) {
        set.status = result.status;
        return result.body;
      }
    })
    .use(projectRoutes)
    .use(projectSecretsRoutes)
    .use(projectFunctionsRoutes)
    .use(organizationRoutes)
    .use(userRoutes)
    .use(backupRoutes)
    .use(monitorRoutes)
    .use(maintenanceRoutes)
    .use(extensionRoutes)
    .use(systemExtensionRoutes)
    .use(securityRoutes)
    .use(storageRoutes)
    .use(scalingRoutes)
    .use(taskRoutes)
    .use(databaseRoutes)
    .use(authRoutes)
    .use(wechatAuthRoutes)
    .use(chinaAuthRoutes)
    .use(userManagementRoutes)
    .use(frontendRoutes)
    .use(webhookRoutes)
    .use(deployRoutes)
    .use(chatRoutes)
    .use(platformSettingsRoutes)
    .use(projectLogsRoutes)
    .use(systemRoutes);
}

const args = process.argv.slice(2);

/**
 * Auto-detect and stop orphan systemd services for deleted/missing projects.
 * Runs on startup to prevent resource waste from failed cleanup sagas.
 */
async function cleanupOrphanServices() {
  const { $ } = await import("bun");
  const { sql: metaSql } = await import("./db");

  // Get all active project refs from database
  const activeProjects = await metaSql`SELECT ref FROM projects WHERE status != 'deleted'`;
  const activeRefs = new Set(activeProjects.map((p: Record<string, unknown>) => p.ref));

  // List running supacloud-gotrue and supacloud-pgrst services
  const result = await $`systemctl list-units 'supacloud-gotrue@*' 'supacloud-pgrst@*' --all --plain --no-pager`
    .nothrow().quiet();
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
      logger.error("Failed to initialize database:", { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }
  } else if (args.includes("install") || args.includes("--install")) {
    const { runInstall } = await import("./install");
    const forceYes = args.includes("--yes") || args.includes("-y");
    try {
      await runInstall({ forceYes });
      process.exit(0);
    } catch (err: unknown) {
      logger.error("Installation aborted:", { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }
  } else if (args.includes("upgrade") || args.includes("--upgrade")) {
    const { runUpgrade } = await import("./upgrade");
    const forceYes = args.includes("--yes") || args.includes("-y");
    try {
      await runUpgrade({ forceYes });
      process.exit(0);
    } catch (err: unknown) {
      logger.error("Upgrade aborted:", { error: err instanceof Error ? err.message : String(err) });
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
      logger.error("Doctor scan failed:", { error: err instanceof Error ? err.message : String(err) });
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
    const serviceTarget = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
    await handleLogs(serviceTarget);
    process.exit(0);
  } else if (args[0] === "project") {
    const { handleProjectCreate, handleProjectList, handleProjectGet, handleProjectDelete,
      handleProjectPause, handleProjectRestore, handleProjectRestart,
      handleProjectKeys, handleProjectRotateKeys, printProjectHelp } = await import("./cli/project");
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
  } else if (args.includes("--version") || args.includes("-v")) {
    const pkg = await import("../package.json");
    logger.info(`SupaCloud Version: ${pkg.version}`);
    process.exit(0);
  } else if (args.includes("--help") || args.includes("-h")) {
    process.exit(0);
  } else if (args.length === 0 || args.includes("--server")) {
    // Use Bun.serve with custom fetch to intercept /mcp before Elysia touches the body
    const { handleMcp } = await import("./routes/mcp");
    Bun.serve({
      port: config.port,
      async fetch(request: Request) {
        const url = new URL(request.url);
        // Route /mcp paths directly to MCP handler (bypasses Elysia body parsing)
        if (url.pathname.startsWith("/mcp")) {
          if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/sql") || url.pathname.startsWith("/mcp/tokens") || url.pathname.startsWith("/mcp/logs") || url.pathname.startsWith("/mcp/migrations")) {
            return handleMcp(request);
          }
          // Rewrite /mcp/v1... to /v1... and pass to Elysia
          const newUrl = new URL(request.url);
          newUrl.pathname = newUrl.pathname.replace(/^\/mcp/, "");
          const newReq = new Request(newUrl.toString(), request);
          return app.fetch(newReq);
        }
        // Everything else goes through Elysia
        return app.fetch(request);
      },
    });
    const { taskWorker } = await import("./services/task.worker");
    taskWorker.start();

    const { edgeRuntimeManager } = await import("./plugins/edge-runtime-manager");
    edgeRuntimeManager.start().catch((err: unknown) => logger.error("[EdgeRuntime] Failed to start", { error: err instanceof Error ? err.message : String(err) }));

    // Auto-detect and stop orphan services for deleted projects
    cleanupOrphanServices().catch(err =>
      logger.warn("[Bootstrap] Orphan service cleanup failed (non-fatal):", err)
    );

    logger.info(`
    ╔═══════════════════════════════════════════════════════════╗
    ║          SupaCloud Management API                         ║
    ╠═══════════════════════════════════════════════════════════╣
    ║  Server running at: http://localhost:${config.port}                ║
    ║  Swagger docs at:   http://localhost:${config.port}/swagger        ║
    ╚═══════════════════════════════════════════════════════════╝
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
      const { edgeRuntimeManager } = await import("./plugins/edge-runtime-manager");
      edgeRuntimeManager.stop();
    } catch (e: unknown) { logger.debug("[index] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }

    try {
      await closeDb();
      logger.info("Database connections released.");
    } catch (e: unknown) { logger.debug("[index] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }

    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

export { app };
