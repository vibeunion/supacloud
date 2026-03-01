import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { config } from "./config";
import { authMiddleware } from "./middleware/auth";
import { projectRoutes, organizationRoutes, userRoutes, backupRoutes, monitorRoutes, maintenanceRoutes, extensionRoutes, securityRoutes, storageRoutes, scalingRoutes, taskRoutes } from "./routes";
import { wakeupProxy } from "./wakeup-proxy";

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

  // 需要认证的路由
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
  })

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

import { initDatabase } from "./db/init";
import { taskWorker } from "./services/task.worker";
import { runInstall } from "./install";
import { runUpgrade } from "./upgrade";
import { runDoctor } from "./doctor";
import { runStorageManager } from "./storage";

const args = process.argv.slice(2);

if (args.includes("--init-db")) {
  initDatabase().then(() => {
    console.log("Database initialized successfully!");
    process.exit(0);
  }).catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
} else if (args.includes("install") || args.includes("--install")) {
  runInstall().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error("Installation aborted:", err);
    process.exit(1);
  });
} else if (args.includes("upgrade") || args.includes("--upgrade")) {
  runUpgrade().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error("Upgrade aborted:", err);
    process.exit(1);
  });
} else if (args.includes("doctor") || args.includes("--doctor")) {
  runDoctor().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error("Doctor scan failed:", err);
    process.exit(1);
  });
} else if (args.includes("storage") || args.includes("--storage")) {
  runStorageManager().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error("Storage management failed:", err);
    process.exit(1);
  });
} else {
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

export { app };
