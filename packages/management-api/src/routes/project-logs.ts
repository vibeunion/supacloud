import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { config } from "../config";
import { logger } from "../utils/logger";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { victoriaLogsService } from "../services/victorialogs.service";

const activeStreams = new Map<string, number>();
const MAX_STREAMS_PER_PROJECT = 5;

export function normalizePersistedLogService(service?: string): string | undefined {
    const aliases: Record<string, string> = {
        api: "postgrest",
        gotrue: "auth",
        db: "database",
    };
    return service ? aliases[service] || service : undefined;
}

export function getProjectLogUnits(ref: string, service?: string): string[] {
    const all = [
        `supacloud-gotrue@${ref}`,
        `supacloud-pgrst@${ref}`,
        `supacloud-postgres@${ref}`,
        `supacloud-storage@${ref}`,
    ];
    if (!service || service === "all") return all;
    const map: Record<string, string> = {
        auth: `supacloud-gotrue@${ref}`,
        gotrue: `supacloud-gotrue@${ref}`,
        api: `supacloud-pgrst@${ref}`,
        postgrest: `supacloud-pgrst@${ref}`,
        database: `supacloud-postgres@${ref}`,
        db: `supacloud-postgres@${ref}`,
        storage: `supacloud-storage@${ref}`,
    };
    const unit = map[service];
    if (!unit) throw new Error("Live log streaming only supports project-isolated auth, api, database, and storage services");
    return [unit];
}

export const projectLogsRoutes = new Elysia({ prefix: "/v1/projects/:ref/logs" })
    .get(
        "",
        async ({ params, query, request }) => {
            const authError = await requireProjectOrAdminAuth(request, params.ref);
            if (authError) return status(authError.status, authError.body);
            const project = await projectService.getProject(params.ref);
            if (!project) {
                return status(404, { message: "Project not found", code: "404" });
            }

            try {
                const limit = query.limit === undefined ? 200 : Number(query.limit);
                const offset = query.offset === undefined ? 0 : Number(query.offset);
                const parsedLogs = await victoriaLogsService.queryProjectLogs(params.ref, {
                    limit,
                    offset,
                    service: normalizePersistedLogService(query.service),
                    search: query.search,
                    start: query.start,
                    end: query.end,
                });
                return {
                    backend: "victorialogs",
                    result: parsedLogs,
                    sources: config.logCollectorJournalEnabled
                        ? ["auth", "api", "database", "storage", "functions"]
                        : ["functions"],
                    live_stream: config.logCollectorJournalEnabled,
                    pagination: {
                        offset,
                        limit,
                        total: parsedLogs.length,
                    },
                };
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                if (/^(Invalid|Log query|start |end )/.test(message)) {
                    return status(400, { message, code: "VALIDATION_ERROR", backend: "victorialogs" });
                }
                logger.warn("[ProjectLogs] VictoriaLogs query failed", { ref: params.ref, error: message });
                return status(503, {
                    message: "Persistent project logs are temporarily unavailable",
                    code: "LOG_STORE_UNAVAILABLE",
                    backend: "victorialogs",
                });
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            query: t.Object({
                limit: t.Optional(t.String()),
                offset: t.Optional(t.String()),
                service: t.Optional(t.String()),
                search: t.Optional(t.String()),
                start: t.Optional(t.String()),
                end: t.Optional(t.String()),
            }),
            detail: { tags: ["projects"], summary: "Get project logs" }
        }
    )

    .get(
        "/stream",
        async ({ params, query, set, request }) => {
            const { ref } = params;

            const authError = await requireProjectOrAdminAuth(request, ref);
            if (authError) return status(authError.status, authError.body);
            if (!config.logCollectorJournalEnabled) {
                return status(501, {
                    capability: false,
                    reason: "journald_unavailable",
                    message: "Live project log streaming requires the host systemd/journald profile",
                });
            }

            const project = await projectService.getProject(ref);
            if (!project) {
                return status(404, { message: "Project not found", code: "404" });
            }

            let units: string[];
            try {
                units = getProjectLogUnits(ref, query.service);
            } catch (error: unknown) {
                return status(400, {
                    message: error instanceof Error ? error.message : String(error),
                    code: "INVALID_LOG_SERVICE",
                });
            }

            const current = activeStreams.get(ref) || 0;
            if (current >= MAX_STREAMS_PER_PROJECT) {
                set.status = 429;
                return { message: `Too many active streams for project ${ref}`, code: "429" };
            }
            activeStreams.set(ref, current + 1);

            const unitArgs = units.flatMap(u => ["-u", u]);

            const proc = Bun.spawn(
                ["journalctl", "--follow", "--no-pager", "-o", "short-iso", ...unitArgs],
                { stdout: "pipe", stderr: "ignore" }
            );

            logger.info(`[SSE] Log stream started for ${ref} (services: ${query.service || "all"}, pid: ${proc.pid})`);

            const encoder = new TextEncoder();
            let cancelled = false;
            let cleaned = false;

            function cleanup() {
                if (cleaned) return;
                cleaned = true;
                try { proc.kill(); } catch { /* ignore */ }
                const count = activeStreams.get(ref) || 1;
                activeStreams.set(ref, Math.max(0, count - 1));
                logger.info(`[SSE] Log stream closed for ${ref} (pid: ${proc.pid})`);
            }

            const stream = new ReadableStream({
                async start(controller) {
                    controller.enqueue(encoder.encode(": connected\n\n"));

                    const reader = proc.stdout.getReader();
                    const decoder = new TextDecoder();
                    let buffer = "";

                    try {
                        while (!cancelled) {
                            const { done, value } = await reader.read();
                            if (done) break;

                            buffer += decoder.decode(value, { stream: true });
                            const lines = buffer.split("\n");
                            buffer = lines.pop() || "";

                            for (const line of lines) {
                                if (!line.trim()) continue;

                                const match = line.match(/^([0-9-T:+.]+)\s+\S+\s+([^:]+):\s+(.*)$/);
                                const event = match
                                    ? { timestamp: match[1], service: match[2].trim(), message: match[3] }
                                    : { timestamp: new Date().toISOString(), service: "system", message: line };

                                controller.enqueue(
                                    encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
                                );
                            }
                        }
                    } catch (err: unknown) {
                        if (!cancelled) {
                            logger.error(`[SSE] Stream error for ${ref}:`, err instanceof Error ? err.message : String(err));
                        }
                    } finally {
                        cleanup();
                        controller.close();
                    }
                },
                cancel() {
                    cancelled = true;
                    cleanup();
                }
            });

            return new Response(stream, {
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                }
            });
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            query: t.Object({ service: t.Optional(t.String()) }),
            detail: { tags: ["projects"], summary: "Stream project logs via SSE" }
        }
    );
