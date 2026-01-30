import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { config } from "./config";
import { authMiddleware } from "./middleware/auth";
import { projectRoutes, organizationRoutes, userRoutes } from "./routes";

const app = new Elysia()
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

  .listen(config.port);

console.log(`
╔═══════════════════════════════════════════════════════════╗
║          SupaCloud Management API                         ║
╠═══════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${config.port}                ║
║  Swagger docs at:   http://localhost:${config.port}/swagger        ║
╚═══════════════════════════════════════════════════════════╝
`);

export { app };
