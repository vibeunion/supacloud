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
      return { success: true, token, masterToken: config.masterToken };
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
      return { valid: sigHex === expected };
    } catch (err: unknown) {
      logger.warn("[Auth] Failed to verify session token signature", { error: err });
      return { valid: false };
    }
  })

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

  // Error handling
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

    set.status = 500;
    return { error: "Internal server error" };
  });

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

// Lazy-loaded embedded assets (only loaded on first fallback request)
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

// Cached SPA index.html content (avoids re-reading on every fallback)
import { Glob } from "bun";

let _cachedIndexHtml: string | null = null;
const staticAssetCache = new Set<string>();
let staticCacheWarmed = false;

function warmupStaticAssets() {
  if (staticCacheWarmed) return;
  try {
    const glob = new Glob("**/*");
    for (const file of glob.scanSync({ cwd: WEB_CONSOLE_DIR, onlyFiles: true })) {
      const standardPath = file.startsWith('/') ? file : '/' + file;
      staticAssetCache.add(standardPath);
    }
    logger.info(`[StaticAssets] Pre-warmed ${staticAssetCache.size} files into memory cache O(1)`);
    staticCacheWarmed = true;
  } catch (e: unknown) {
    logger.warn("[StaticAssets] Failed to warm up directory", { dir: WEB_CONSOLE_DIR, error: String(e) });
  }
}

/**
 * Register static assets (SPA) with O(1) hashmap checks and zero-copy / pre-compression
 */
export function registerStaticAssets() {
  warmupStaticAssets();

  return new Elysia({ name: "static-assets" }).get("*", async (context) => {
    const { request, set } = context;
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;

    // Do NOT catch API routes in static assets
    if (path.startsWith("/api/") || path.startsWith("/v1/")) {
      set.status = 404;
      return { error: "Route not found" };
    }

    try {
      // Memory Hash check O(1)
      const acceptEncoding = request.headers.get('accept-encoding') || '';
      let diskFile: string | null = null;
      let encoding: 'br' | 'gzip' | null = null;

      if (acceptEncoding.includes('br') && staticAssetCache.has(path + '.br')) {
        diskFile = path + '.br';
        encoding = 'br';
      } else if (acceptEncoding.includes('gzip') && staticAssetCache.has(path + '.gz')) {
        diskFile = path + '.gz';
        encoding = 'gzip';
      } else if (staticAssetCache.has(path)) {
        diskFile = path;
      }

      if (diskFile) {
        const extMatch = path.match(/\.[0-9a-z]+$/i);
        const ext = extMatch ? extMatch[0].toLowerCase() : '';
        set.headers["Content-Type"] = MIME_TYPES[ext] || "application/octet-stream";

        set.headers["Cache-Control"] = path.includes('/assets/') || path.match(/\.[0-9a-f]{8}\./)
          ? "public, max-age=31536000, immutable" 
          : "public, max-age=3600";

        if (encoding) {
          set.headers["Content-Encoding"] = encoding;
          set.headers["Vary"] = "Accept-Encoding";
        }

        return Bun.file(`${WEB_CONSOLE_DIR}${diskFile}`);
      }

      // Try index.html for SPA routing (fallback for non-asset paths)
      const exactPath = `${WEB_CONSOLE_DIR}/index.html`;
      if (staticAssetCache.has("/index.html")) {
        if (!_cachedIndexHtml) {
          _cachedIndexHtml = await Bun.file(exactPath).text();
        }
        return new Response(_cachedIndexHtml, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
      }
    } catch (e: unknown) {
      logger.error("Asset FS error:", { error: e instanceof Error ? e.message : String(e) });
    }

    // Fall back to embedded assets (lazy-loaded)
    try {
      const ASSETS = await getEmbeddedAssets();
      if (ASSETS) {
        let asset = ASSETS[path];
        if (!asset && !path.includes(".")) {
          asset = ASSETS["/index.html"];
        }

        if (asset) {
          set.headers["Content-Type"] = asset.mimeType as string;
          return Buffer.from(asset.content, 'base64');
        }
      }

      set.status = 404;
      return "Internal Asset Not Found.";
    } catch (e: unknown) {
      if (process.env.NODE_ENV !== "production") {
        return "Management Console DEV mode: run 'bun run build:all' to load SPA assets into memory.";
      }
      set.status = 404;
      return "App Assets Not Built.";
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
    chatRoutes, platformSettingsRoutes, projectLogsRoutes
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
    .use(projectLogsRoutes);
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
