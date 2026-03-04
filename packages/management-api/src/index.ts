import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { config } from "./config";
import { authMiddleware } from "./middleware/auth";
import { closeDb } from "./db";

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

  // Studio compatibility routes (IS_PLATFORM mode expects /platform/*)
  .get("/platform/projects", async () => {
    const { projectService } = await import("./services");
    const projects = await projectService.listProjects();
    return projects.map((project: any) => ({
      id: project.id,
      ref: project.ref,
      name: project.name,
      status: project.status,
      region: project.region,
      organization_id: "default",
      cloud_provider: project.cloud_provider || "localhost",
      status: project.status?.toUpperCase() || "ACTIVE_HEALTHY",
      inserted_at: project.created_at,
      updated_at: project.updated_at,
      database: {
        host: project.database?.host || "localhost",
        name: project.database?.name || `supa_${project.ref}`,
        user: project.database?.user || `role_${project.ref}`,
        port: project.database?.port || 5432,
        pool_size: project.database?.pool_size || 20,
      },
      api: {
        url: project.api?.url || "",
        internal_api_key: project.internal_api_key || "",
        jwt_secret: project.jwt_secret || "",
      },
      studio: {
        url: project.studio?.url || "",
        internal_api_key: project.internal_api_key || "",
      },
      services: project.services || [],
      rest: project.rest || {},
      realtime: project.realtime || false,
    }));
  })
  .get("/platform/projects/:ref", async ({ params, set }) => {
    const { projectService } = await import("./services");
    let project = await projectService.getProject(params.ref);
    
    // If ref is "default", return the first project
    if (!project && params.ref === "default") {
      const projects = await projectService.listProjects();
      project = projects[0];
    }
    
    if (!project) {
      set.status = 404;
      return { error: "Project not found" };
    }
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
      updated_at: project.updated_at || null,
      database: {
        host: project.database?.host || "localhost",
        name: project.database?.name || `supa_${project.ref}`,
        user: project.database?.user || `role_${project.ref}`,
        port: project.database?.port || 5432,
        pool_size: project.database?.pool_size || 20,
      },
      api: {
        url: project.api?.url || "",
        internal_api_key: project.internal_api_key || "",
        jwt_secret: project.jwt_secret || "",
      },
      studio: {
        url: project.studio?.url || "",
        internal_api_key: project.internal_api_key || "",
      },
      services: project.services || [],
      rest: project.rest || {},
      realtime: project.realtime || false,
    };
  })
  .get("/platform/organizations", async () => {
    return [{ id: 1, name: "SupaCloud", slug: "supacloud" }];
  })
  .get("/platform/profile", async () => {
    const { projectService } = await import("./services");
    const projects = await projectService.listProjects();
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
        projects: projects.map((p: any) => ({
          id: p.id,
          ref: p.ref,
          name: p.name,
          status: p.status?.toUpperCase() || "ACTIVE_HEALTHY",
          region: p.region || "local",
          organization_id: "default",
          cloud_provider: p.cloud_provider || "localhost",
          inserted_at: p.created_at,
        }))
      }]
    };
  })
  // Auth routes for Studio compatibility
  .get("/platform/auth/user", async () => {
    return {
      id: "1",
      email: "admin@supacloud.local",
      user_metadata: {
        first_name: "Admin",
        last_name: "User",
      },
      app_metadata: {},
      aud: "authenticated",
      role: "authenticated",
      created_at: new Date().toISOString(),
    };
  })
  .get("/platform/subscription", async () => {
    return {
      id: 1,
      name: "Pro Plan",
      tier: "pro",
      billing_email: "admin@supacloud.local",
    };
  })
  // Auth session for Studio
  .get("/auth/session", async () => {
    return {
      access_token: "mock-access-token",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "mock-refresh-token",
      user: {
        id: "1",
        email: "admin@supacloud.local",
        user_metadata: {
          first_name: "Admin",
          last_name: "User",
        },
        app_metadata: {},
        aud: "authenticated",
        role: "authenticated",
        created_at: new Date().toISOString(),
      },
    };
  })

  // API version info (no auth required)
  .get("/", () => ({
    name: "SupaCloud Management API",
    version: "1.0.0",
    docs: "/swagger",
  }))

  // Monitoring and diagnostic endpoints (no auth required, can add later)
  .get("/monitor/health", async () => {
    const { HealthChecker } = await import("./infra/health");
    return await HealthChecker.runFullCheck();
  })

  // Error handling
  .onError(({ code, error, set }) => {
    console.error(`Error [${code}]:`, error);

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

// @ts-ignore: This file is auto-generated by scripts/pack-assets.ts
import { EMBEDDED_ASSETS } from "./assets.gen";

/**
 * Register static assets (SPA)
 */
export function registerStaticAssets() {
  return new Elysia({ name: "static-assets" }).get("*", async (context) => {
    const { request, set } = context;
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;

    if (path.startsWith("/api/") || path.startsWith("/v1/")) {
      set.status = 404;
      return { error: "Route not found" };
    }

    try {
      const ASSETS = EMBEDDED_ASSETS;
      let asset = ASSETS[path];
      if (!asset && !path.includes(".")) {
        asset = ASSETS["/index.html"];
      }

      if (asset) {
        set.headers["Content-Type"] = asset.mimeType as string;
        return Buffer.from(asset.content, 'base64');
      } else {
        set.status = 404;
        return "Internal Asset Not Found.";
      }
    } catch (e) {
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
    projectRoutes, organizationRoutes, userRoutes, backupRoutes,
    monitorRoutes, maintenanceRoutes, extensionRoutes, securityRoutes,
    storageRoutes, scalingRoutes, taskRoutes, databaseRoutes, authRoutes,
    frontendRoutes, webhookRoutes
  } = await import("./routes");

  return new Elysia({ name: "api-routes" })
    .use(authMiddleware)
    .use(projectRoutes)
    .use(organizationRoutes)
    .use(userRoutes)
    .use(backupRoutes)
    .use(monitorRoutes)
    .use(maintenanceRoutes)
    .use(extensionRoutes)
    .use(securityRoutes)
    .use(storageRoutes)
    .use(scalingRoutes)
    .use(taskRoutes)
    .use(databaseRoutes)
    .use(authRoutes)
    .use(frontendRoutes)
    .use(webhookRoutes);
}

const args = process.argv.slice(2);

/**
 * Core logic: Based on command line arguments, decide whether to execute a single task or start the API server.
 * This ensures that database reconnection logic is never triggered during installation (no database).
 */
async function bootstrap() {
  if (args.includes("--init-db")) {
    const { initDatabase } = await import("./db/init");
    try {
      await initDatabase();
      console.log("Database initialized successfully!");
      process.exit(0);
    } catch (err) {
      console.error("Failed to initialize database:", err);
      process.exit(1);
    }
  } else if (args.includes("install") || args.includes("--install")) {
    const { runInstall } = await import("./install");
    const forceYes = args.includes("--yes") || args.includes("-y");
    try {
      await runInstall({ forceYes });
      process.exit(0);
    } catch (err) {
      console.error("Installation aborted:", err);
      process.exit(1);
    }
  } else if (args.includes("upgrade") || args.includes("--upgrade")) {
    const { runUpgrade } = await import("./upgrade");
    const forceYes = args.includes("--yes") || args.includes("-y");
    try {
      await runUpgrade({ forceYes });
      process.exit(0);
    } catch (err) {
      console.error("Upgrade aborted:", err);
      process.exit(1);
    }
  } else if (args.includes("doctor") || args.includes("--doctor")) {
    const { runDoctor } = await import("./doctor");
    const skipSmokeTest = args.includes("--skip-smoke-test");
    const forceYes = args.includes("--yes") || args.includes("-y");
    try {
      await runDoctor({ skipSmokeTest, forceYes });
      process.exit(0);
    } catch (err) {
      console.error("Doctor scan failed:", err);
      process.exit(1);
    }
  } else if (args.includes("storage") || args.includes("--storage")) {

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
          console.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectGet(args[2]);
        break;
      case "delete":
      case "rm":
        if (!args[2]) {
          console.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectDelete(args[2], args.slice(3));
        break;
      case "pause":
        if (!args[2]) {
          console.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectPause(args[2]);
        break;
      case "restore":
        if (!args[2]) {
          console.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectRestore(args[2]);
        break;
      case "restart":
        if (!args[2]) {
          console.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectRestart(args[2]);
        break;
      case "keys":
        if (!args[2]) {
          console.error("Error: project ref required");
          printProjectHelp();
          process.exit(1);
        }
        await handleProjectKeys(args[2]);
        break;
      case "rotate-keys":
        if (!args[2]) {
          console.error("Error: project ref required");
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
    console.log(`SupaCloud Version: ${pkg.version}`);
    process.exit(0);
  } else if (args.includes("--help") || args.includes("-h")) {
    console.log(`
      SupaCloud Management API CLI
      
      Usage:
        supacloud install [--dry-run]  Install SupaCloud full-stack environment
        supacloud start / up           Bring up all component containers
        supacloud stop / down          Gracefully stop and cleanup components
        supacloud status / check       Check core component and port health status
        supacloud logs [service]       View specified component or all logs
        supacloud doctor               Run environment pre-check and diagnostics
        supacloud upgrade              Upgrade cluster components
        
      Project Management:
        supacloud project create [--name <name>] [--domain <domain>]  Create a new project
        supacloud project list                                         List all projects
        supacloud project get <ref>                                    Get project details
        supacloud project delete <ref>                                 Delete a project
        supacloud project pause <ref>                                  Pause a project
        supacloud project restore <ref>                                Restore a paused project
        supacloud project restart <ref>                                Restart a project
        supacloud project keys <ref>                                   Get API keys
        supacloud project rotate-keys <ref>                            Rotate API keys
        
        supacloud --version            Display version number
        supacloud --help               Display this help message
        
      If no arguments are provided, the API server will start.
    `);
    process.exit(0);
  } else if (args.length === 0 || args.includes("--server")) {
    // API server mode: Only then load routes and start TaskWorker
    app.use(await registerAllRoutes());
    app.use(registerStaticAssets());
    const { taskWorker } = await import("./services/task.worker");

    app.listen(config.port);
    taskWorker.start();

    console.log(`
    ╔═══════════════════════════════════════════════════════════╗
    ║          SupaCloud Management API                         ║
    ╠═══════════════════════════════════════════════════════════╣
    ║  Server running at: http://localhost:${config.port}                ║
    ║  Swagger docs at:   http://localhost:${config.port}/swagger        ║
    ╚═══════════════════════════════════════════════════════════╝
    `);
  } else {
    // Unknown command
    console.error(`Unknown command or argument: ${args.join(" ")}`);
    console.log("Run 'supacloud --help' for usage information.");
    process.exit(1);
  }
}

if (import.meta.main) {
  bootstrap();

  // 增加 Graceful Shutdown 支持以释放连接池及保护 Task 队列一致性
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Gracefully shutting down...`);

    // Stop TaskWorker loop if it is running
    try {
      const { taskWorker } = await import("./services/task.worker");
      taskWorker.stop();
    } catch { /* ignore if not loaded */ }

    // Close Database connections including LRU caches
    try {
      await closeDb();
      console.log("Database connections released.");
    } catch { /* ignore */ }

    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

export { app };
