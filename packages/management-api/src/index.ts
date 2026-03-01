import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { config } from "./config";
import { authMiddleware } from "./middleware/auth";

const app = new Elysia({ strictPath: false })
  // Swagger 文档
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

  // 健康检查 (无需认证)
  .get("/health", () => ({ status: "ok", timestamp: new Date().toISOString() }))

  // API 版本信息 (无需认证)
  .get("/", () => ({
    name: "SupaCloud Management API",
    version: "1.0.0",
    docs: "/swagger",
  }))

  // 监控与诊断接口 (无需认证，后续可加)
  .get("/monitor/health", async () => {
    const { HealthChecker } = await import("./infra/health");
    return await HealthChecker.runFullCheck();
  })

  // 错误处理
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

// @ts-ignore: 此文件由 scripts/pack-assets.ts 自动生成
import { EMBEDDED_ASSETS } from "./assets.gen";

app.get("*", async ({ request, set }) => {
  const url = new URL(request.url);
  const path = url.pathname === "/" ? "/index.html" : url.pathname;

  if (path.startsWith("/api/")) {
    set.status = 404;
    return { error: "API route not found" };
  }

  try {
    const ASSETS = EMBEDDED_ASSETS;
    let asset = ASSETS[path];
    if (!asset && !path.includes(".")) {
      asset = ASSETS["/index.html"];
    }

    if (asset) {
      set.headers["Content-Type"] = asset.mimeType;
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

const args = process.argv.slice(2);

/**
 * 核心逻辑：根据命令行参数决定是执行单次任务还是启动 API 服务器。
 * 这确保了在安装阶段 (无数据库) 绝不会触发数据库重连逻辑。
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
    try {
      await runInstall();
      process.exit(0);
    } catch (err) {
      console.error("Installation aborted:", err);
      process.exit(1);
    }
  } else if (args.includes("upgrade") || args.includes("--upgrade")) {
    const { runUpgrade } = await import("./upgrade");
    try {
      await runUpgrade();
      process.exit(0);
    } catch (err) {
      console.error("Upgrade aborted:", err);
      process.exit(1);
    }
  } else if (args.includes("doctor") || args.includes("--doctor")) {
    const { runDoctor } = await import("./doctor");
    try {
      await runDoctor();
      process.exit(0);
    } catch (err) {
      console.error("Doctor scan failed:", err);
      process.exit(1);
    }
  } else if (args.includes("storage") || args.includes("--storage")) {
    const { runStorageManager } = await import("./storage");
    try {
      await runStorageManager();
      process.exit(0);
    } catch (err) {
      console.error("Storage management failed:", err);
      process.exit(1);
    }
  } else if (args.includes("node") || args.includes("--node")) {
    const { runNodeManager } = await import("./node");
    try {
      await runNodeManager();
      process.exit(0);
    } catch (err) {
      console.error("Node management failed:", err);
      process.exit(1);
    }
  } else if (args.includes("cluster") || args.includes("--cluster")) {
    const { runClusterManager } = await import("./cluster");
    try {
      await runClusterManager();
      process.exit(0);
    } catch (err) {
      console.error("Cluster management failed:", err);
      process.exit(1);
    }
  } else if (args.includes("--version") || args.includes("-v")) {
    const pkg = await Bun.file("package.json").json();
    console.log(`SupaCloud Version: ${pkg.version}`);
    process.exit(0);
  } else {
    // API 服务器模式：此时才加载路由和启动 TaskWorker
    const {
      projectRoutes, organizationRoutes, userRoutes, backupRoutes,
      monitorRoutes, maintenanceRoutes, extensionRoutes, securityRoutes,
      storageRoutes, scalingRoutes, taskRoutes
    } = await import("./routes");
    const { taskWorker } = await import("./services/task.worker");

    app
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
      .use(taskRoutes);

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
  }
}

bootstrap();

export { app };
