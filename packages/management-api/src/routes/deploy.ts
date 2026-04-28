import { Elysia, t, status } from "elysia";
import { deployService } from "../services/deploy.service";
import { logger } from "../utils/logger";
import { requireAdminAuth } from "../middleware/auth";

export const deployRoutes = new Elysia({ prefix: "/v1/deploy" })
  .post("/", async ({ body, request }) => {
    const authError = await requireAdminAuth(request);
    if (authError) return status(authError.status, authError.body);
    try {
      const result = await deployService.deploy(
        {
          app: body.app,
          tenant: body.tenant,
          artifact: body.artifact,
          config: body.config,
        },
        "api"
      );

      return result;
    } catch (error: unknown) {
      logger.error("Deploy failed", { error });
      return status(500, {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error",
        code: "500",
      });
    }
  }, {
    body: t.Object({
      app: t.String(),
      tenant: t.String(),
      artifact: t.String(),
      config: t.Any(),
    }),
  })
  .post("/rollback", async ({ body, request }) => {
    const authError = await requireAdminAuth(request);
    if (authError) return status(authError.status, authError.body);
    try {
      const result = await deployService.rollback(body.app, body.version);
      return result;
    } catch (error: unknown) {
      logger.error("Rollback failed", { error });
      return status(500, {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error",
        code: "500",
      });
    }
  }, {
    body: t.Object({
      app: t.String(),
      version: t.Optional(t.String()),
    }),
  })
  .get("/history", async ({ query }) => {
    try {
      const app = query.app;
      const limit = parseInt(query.limit ?? "20") || 20;

      const history = await deployService.getHistory(app, limit);

      return {
        success: true,
        history,
      };
    } catch (error: unknown) {
      logger.error("Failed to get history", { error });
      return status(500, {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error",
        code: "500",
      });
    }
  }, {
    query: t.Object({
      app: t.Optional(t.String()),
      limit: t.Optional(t.String()),
    }),
  })
  .get("/versions", async ({ query }) => {
    try {
      if (!query.app) {
        return status(400, {
          success: false,
          message: "Missing required query parameter: app",
          code: "400",
        });
      }

      const versions = await deployService.getVersions(query.app);

      return {
        success: true,
        app: query.app,
        versions,
      };
    } catch (error: unknown) {
      logger.error("Failed to get versions", { error });
      return status(500, {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error",
        code: "500",
      });
    }
  }, {
    query: t.Object({
      app: t.Optional(t.String()),
    }),
  });
