/**
 * Project Log Query Service
 *
 * Extracted from project.service.ts — handles journalctl-based log queries
 * for per-tenant services (GoTrue, PostgREST, Patroni).
 */
import { projectRepository } from "../repositories/project.repository";
import { shellService } from "./shell.service";
import { logger } from "../utils/logger";
import { $ } from "bun";
import type { LogEntryResponse } from "./project.service";

export class ProjectLogService {
  async queryLogs(ref: string, type: string = "all"): Promise<LogEntryResponse[]> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return [];

    try {
      let mappedType = "all";
      if (type === "auth" || type === "gotrue") mappedType = "auth";
      else if (type === "api" || type === "postgrest") mappedType = "api";
      else if (type === "database" || type === "postgres") mappedType = "database";

      const limit = 50;
      const rawOutputs: { source: string; jsonStr: string }[] = [];

      const fetchJournal = async (unitName: string, sourceName: string) => {
        try {
          const result = await $`journalctl -u ${unitName} -o json -n ${limit} --no-pager`.nothrow().quiet();
          if (result.exitCode === 0) {
            const lines = result.text().trim().split('\\n').filter((l: string) => l.trim().length > 0);
            for (const line of lines) {
              rawOutputs.push({ source: sourceName, jsonStr: line });
            }
          }
        } catch (e: unknown) {
          logger.error(`Error fetching journal for ${unitName}`, {
            error: (e instanceof Error ? e.message : String(e)) || String(e),
          });
        }
      };

      if (mappedType === "auth" || mappedType === "all") {
        await fetchJournal(`supacloud-gotrue@${ref}`, "auth");
      }
      if (mappedType === "api" || mappedType === "all") {
        await fetchJournal(`supacloud-pgrst@${ref}`, "api");
      }

      if (mappedType === "database" || mappedType === "all") {
        try {
          if (!/^[a-zA-Z0-9_]+$/.test(ref)) {
            throw new Error("Invalid ref format");
          }
          const pgLogCmd = await shellService.execute("bash", [
            "-c",
            `journalctl -u patroni -o json -n 20 --no-pager | grep supa_${ref}`,
          ]);
          if (pgLogCmd.success && pgLogCmd.output.trim().length > 0) {
            const lines = pgLogCmd.output.trim().split('\\n').filter((l: string) => l.trim().length > 0);
            for (const line of lines) {
              rawOutputs.push({ source: "database", jsonStr: line });
            }
          }
        } catch (e: unknown) {
          logger.debug(`[ProjectLogService] DB log fetch failed for ${ref}`, { error: e });
        }
      }

      if (rawOutputs.length === 0) return [];

      const parsedLogs: LogEntryResponse[] = [];

      for (const raw of rawOutputs) {
        try {
          const entry = JSON.parse(raw.jsonStr);
          const timestampNum = parseInt(entry.__REALTIME_TIMESTAMP || "0");
          const ms = Math.floor(timestampNum / 1000) || Date.now();
          const timestampStr = new Date(ms).toISOString();

          const source = raw.source || "system";
          const message = entry.MESSAGE || JSON.stringify(entry);

          let severity = "info";
          const prio = parseInt(entry.PRIORITY || "6");
          if (prio <= 3) severity = "error";
          else if (prio === 4) severity = "warning";
          if (message.toLowerCase().includes("error") || message.toLowerCase().includes("fatal")) {
            severity = "error";
          } else if (message.toLowerCase().includes("warn")) {
            severity = "warning";
          }

          parsedLogs.push({
            id: `log-${ms}-${Math.random().toString(36).substring(2, 9)}`,
            timestamp: timestampStr,
            event_message: message,
            metadata: {
              items: [{ severity, source, syslog_identifier: entry.SYSLOG_IDENTIFIER, message }],
            },
          });
        } catch {
          // Skip unparseable lines
        }
      }

      parsedLogs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      return parsedLogs.slice(0, limit);
    } catch (e: unknown) {
      logger.error(`Failed to get real logs for ${ref}`, { error: e instanceof Error ? e.message : String(e) });
      return [];
    }
  }
}

export const projectLogService = new ProjectLogService();
