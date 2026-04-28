import { Elysia, status } from "elysia";
import { logger } from "../utils/logger";
import { requireAdminAuth } from "../middleware/auth";
import { realtimeService } from "../services/realtime.service";
import os from "node:os";

const startTime = Date.now();

/**
 * System Info Routes
 *
 * Provides `/v1/system/info` for the web console dashboard
 * to display CPU, memory, uptime, and version information.
 */
export const systemRoutes = new Elysia({ name: "system" })

  .get("/v1/system/info", async () => {
    try {
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const uptimeSecs = os.uptime();

      // CPU usage: average idle percentage across all cores
      const cpuIdle = cpus.reduce((sum, cpu) => {
        const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        return sum + (cpu.times.idle / total);
      }, 0) / cpus.length;
      const cpuUsage = ((1 - cpuIdle) * 100).toFixed(1) + "%";

      // Format memory
      const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);
      const memory = `${formatMB(usedMem)} / ${formatMB(totalMem)} MB`;

      // Format uptime
      const days = Math.floor(uptimeSecs / 86400);
      const hours = Math.floor((uptimeSecs % 86400) / 3600);
      const mins = Math.floor((uptimeSecs % 3600) / 60);
      const uptime = days > 0
        ? `${days}d ${hours}h ${mins}m`
        : hours > 0
          ? `${hours}h ${mins}m`
          : `${mins}m`;

      // Read version from package.json
      let version = "unknown";
      try {
        const pkg = await import("../../package.json");
        version = pkg.version || pkg.default?.version || "unknown";
      } catch { /* ignore */ }

      return {
        cpu: cpuUsage,
        memory,
        uptime,
        version,
        cores: cpus.length,
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        processUptime: Math.floor((Date.now() - startTime) / 1000),
      };
    } catch (error: unknown) {
      logger.error("[System] Failed to collect system info", { error });
      return {
        cpu: "-",
        memory: "-",
        uptime: "-",
        version: "-",
      };
    }
  })

  // Check Realtime CDC prerequisites on Postgres cluster
  .get("/v1/system/realtime/prerequisites", async () => {
    return await realtimeService.checkCdcPrerequisites();
  })

  // Ensure supabase_admin role has REPLICATION attribute, then return latest check
  .post("/v1/system/realtime/prerequisites/ensure", async ({ request }) => {
    const authError = await requireAdminAuth(request);
    if (authError) return status(authError.status, authError.body);
    const ensure = await realtimeService.ensureSupabaseAdminReplication();
    const current = await realtimeService.checkCdcPrerequisites();
    return { ensure, current };
  });
