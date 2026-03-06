import { Elysia } from "elysia";
import { deployService } from "../services/deploy.service";
import { logger } from "../utils/logger";

export const deployRoutes = new Elysia({ prefix: "/v1/deploy" })
  .post("/", async ({ body }) => {
    try {
      const { app, tenant, artifact, config } = body as {
        app: string;
        tenant: string;
        artifact: string;
        config: any;
      };

      if (!app || !tenant || !artifact || !config) {
        return {
          success: false,
          error: "Missing required fields: app, tenant, artifact, config",
        };
      }

      const result = await deployService.deploy(
        {
          app,
          tenant,
          artifact,
          config,
        },
        "api"
      );

      return result;
    } catch (error) {
      logger.error("Deploy failed", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  })
  .post("/rollback", async ({ body }) => {
    try {
      const { app, version } = body as {
        app: string;
        version?: string;
      };

      if (!app) {
        return {
          success: false,
          error: "Missing required field: app",
        };
      }

      const result = await deployService.rollback(app, version);
      return result;
    } catch (error) {
      logger.error("Rollback failed", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  })
  .get("/history", async ({ query }) => {
    try {
      const app = query.app as string | undefined;
      const limit = parseInt(query.limit as string) || 20;

      const history = await deployService.getHistory(app, limit);

      return {
        success: true,
        history,
      };
    } catch (error) {
      logger.error("Failed to get history", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  })
  .get("/versions", async ({ query }) => {
    try {
      const app = query.app as string;

      if (!app) {
        return {
          success: false,
          error: "Missing required query parameter: app",
        };
      }

      const versions = await deployService.getVersions(app);

      return {
        success: true,
        app,
        versions,
      };
    } catch (error) {
      logger.error("Failed to get versions", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });
