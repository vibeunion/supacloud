import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { $ } from "bun";
import { logger } from "../utils/logger";

const activeStreams = new Map<string, number>();
const MAX_STREAMS_PER_PROJECT = 5;

function getUnits(ref: string, service?: string): string[] {
    const all = [
        `supacloud-gotrue@${ref}`,
        `supacloud-pgrst@${ref}`,
        "supacloud-realtime",
        `supacloud-storage@${ref}`,
    ];
    if (!service || service === "all") return all;
    const map: Record<string, string> = {
        auth: `supacloud-gotrue@${ref}`,
        gotrue: `supacloud-gotrue@${ref}`,
        api: `supacloud-pgrst@${ref}`,
        postgrest: `supacloud-pgrst@${ref}`,
        realtime: "supacloud-realtime",
        storage: `supacloud-storage@${ref}`,
    };
    const unit = map[service];
    return unit ? [unit] : all;
}

export const projectLogsRoutes = new Elysia({ prefix: "/v1/projects/:ref/logs" })
    .get(
        "",
        async ({ params, query, set }) => {
            const project = await projectService.getProject(params.ref);
            if (!project) {
                return status(404, { message: "Project not found", code: "404" });
            }

            try {
                const limit = query.limit || "200";
                const result = await $`journalctl -u supacloud-gotrue@${params.ref} -u supacloud-pgrst@${params.ref} -u supacloud-postgres@${params.ref} -u supacloud-realtime -u supacloud-storage@${params.ref} -u supacloud-kong@${params.ref} -n ${limit} --output short-iso --no-pager`.nothrow().quiet();
                const output = result.text();
                const lines = output.split('\n').filter(line => line.trim() !== '' && !line.startsWith('-- '));

                const parsedLogs = lines.map((line, idx) => {
                    const match = line.match(/^([0-9-T:+.]+)\s+\S+\s+([^:]+):\s+(.*)$/);
                    if (match) {
                        const ts = new Date(match[1]).getTime() || Date.now();
                        const svc = match[2].trim();
                        return {
                            id: `${params.ref}-${idx}`,
                            timestamp: ts,
                            event_message: match[3],
                            metadata: { service: svc },
                        };
                    }
                    return {
                        id: `${params.ref}-${idx}`,
                        timestamp: Date.now(),
                        event_message: line,
                        metadata: { service: "system" },
                    };
                });

                return {
                    result: parsedLogs,
                    pagination: {
                        offset: 0,
                        limit: parseInt(limit) || 200,
                        total: parsedLogs.length,
                    },
                };
            } catch (error: unknown) {
                set.status = 500;
                return { message: "Failed to fetch logs", code: "500" };
            }
        },
        {
            params: t.Object({ ref: t.String({ minLength: 1 }) }),
            query: t.Object({ limit: t.Optional(t.String()), service: t.Optional(t.String()) }),
            detail: { tags: ["projects"], summary: "Get project logs" }
        }
    )

    .get(
        "/stream",
        async ({ params, query, set }) => {
            const { ref } = params;

            const project = await projectService.getProject(ref);
            if (!project) {
                return status(404, { message: "Project not found", code: "404" });
            }

            const current = activeStreams.get(ref) || 0;
            if (current >= MAX_STREAMS_PER_PROJECT) {
                set.status = 429;
                return { message: `Too many active streams for project ${ref}`, code: "429" };
            }
            activeStreams.set(ref, current + 1);

            const units = getUnits(ref, query.service);
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
