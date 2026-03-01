import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { config } from "./config";
import { authMiddleware } from "./middleware/auth";
import { projectRoutes, organizationRoutes, userRoutes, backupRoutes, monitorRoutes, maintenanceRoutes, extensionRoutes, securityRoutes, storageRoutes, scalingRoutes, taskRoutes } from "./routes";

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

  // 挂载内置打包静态资源 SPA (通过 pack-assets.ts 编译期预塞入内存)
  .get("*", async ({ request, set }) => {
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;

    // 如果是 API 路由前缀且没有匹配则不归 SPA 管，或者返回 404
    if (path.startsWith("/api/")) {
      set.status = 404;
      return { error: "API route not found" };
    }

    try {
      // 动态引入编译后的字典文件。如果是开发阶段未构建 web-console 则提供友善提示
      // @ts-ignore:此文件将在生产构建 (bun run build) 阶段由 pack-assets.ts 动态生成
      const builtin = await import("./assets.gen");
      const ASSETS = builtin.ASSETS;

      let asset = ASSETS[path];
      // 支持 SPA 前端客户端路由的 Fallback (任意找不到路径的 URI 均返回 HTML 单壳)
      if (!asset && !path.includes(".")) {
        asset = ASSETS["/index.html"];
      }

      if (asset) {
        set.headers["Content-Type"] = asset.contentType;
        return asset.content;
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

if (process.argv.includes("--init-db")) {
  initDatabase().then(() => {
    console.log("Database initialized successfully!");
    process.exit(0);
  }).catch((err) => {
    console.error("Failed to initialize database:", err);
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
