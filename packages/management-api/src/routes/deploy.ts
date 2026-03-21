import { Elysia, t, status } from "elysia";
import { deployService } from "../services/deploy.service";
import { logger } from "../utils/logger";

export const deployRoutes = new Elysia({ prefix: "/v1/deploy" })
  .post("/", async ({ body }) => {
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
        error: error instanceof Error ? error.message : "Unknown error",
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
  .post("/rollback", async ({ body }) => {
    try {
      const result = await deployService.rollback(body.app, body.version);
      return result;
    } catch (error: unknown) {
      logger.error("Rollback failed", { error });
      return status(500, {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
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
        error: error instanceof Error ? error.message : "Unknown error",
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
          error: "Missing required query parameter: app",
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
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }, {
    query: t.Object({
      app: t.Optional(t.String()),
    }),
  });

