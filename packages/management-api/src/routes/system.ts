import { Elysia, status } from "elysia";
import { logger } from "../utils/logger";
import * as auth from "../middleware/auth";
import * as systemInfoService from "../services/system-info";
import { realtimeService } from "../services/realtime.service";

/**
 * System Info Routes
 *
 * Provides `/v1/system/info` for the web console dashboard
 * to display CPU, memory, uptime, and version information.
 */
export const systemRoutes = new Elysia({ name: "system" })

  .get("/v1/system/info", async ({ request }) => {
    const context = await auth.getAuthContext(request);
    if ("status" in context) return status(context.status, context.body);
    if (context.role !== "master" && context.role !== "admin") {
      return status(403, { error: "Admin privileges required" });
    }
    try {
      return await systemInfoService.collectSystemInfo();
    } catch (error: unknown) {
      logger.error("[System] Failed to collect system info", { error });
      return status(503, { code: "SYSTEM_INFO_UNAVAILABLE", message: "System information unavailable" });
    }
  }, {
    detail: { tags: ["monitor"], summary: "Get system information" },
  })

  // Check Realtime CDC prerequisites on Postgres cluster
  .get("/v1/system/realtime/prerequisites", async () => {
    return await realtimeService.checkCdcPrerequisites();
  }, {
    detail: { tags: ["monitor"], summary: "Check Realtime CDC prerequisites" },
  })

  // Ensure supabase_admin role has REPLICATION attribute, then return latest check
  .post("/v1/system/realtime/prerequisites/ensure", async ({ request }) => {
    const authError = await auth.requireAdminAuth(request);
    if (authError) return status(authError.status, authError.body);
    const ensure = await realtimeService.ensureSupabaseAdminReplication();
    const current = await realtimeService.checkCdcPrerequisites();
    return { ensure, current };
  }, {
    detail: { tags: ["monitor"], summary: "Ensure Realtime replication is configured" },
  });