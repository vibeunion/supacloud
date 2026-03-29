import { Elysia, t } from "elysia";
import { projectService } from "../services";
import { $ } from "bun";

export const projectLogsRoutes = new Elysia({ prefix: "/v1/projects/:ref/logs" })
    .get(
        "",
        async ({ params, query, set }) => {
            const project = await projectService.getProject(params.ref);
            if (!project) {
                set.status = 404;
                return { error: "Project not found" };
            }

            try {
                const limit = query.limit || "200";
                
                // Fetch logs from all multi-tenant instance services
                // Combine logs from gotrue, pgrst, and postgres specific to this project
                const result = await $`journalctl -u supacloud-gotrue@${params.ref} -u supacloud-pgrst@${params.ref} -u supacloud-postgres@${params.ref} -u supacloud-realtime@${params.ref} -u supacloud-storage@${params.ref} -u supacloud-kong@${params.ref} -n ${limit} --output short-iso --no-pager`.nothrow().quiet();
                
                const output = result.text();
                
                // Parse lines
                const lines = output.split('\n').filter(line => line.trim() !== '' && !line.startsWith('-- '));
                
                const parsedLogs = lines.map(line => {
                    // Typical journalctl short-iso format:
                    // 2023-10-25T14:32:00+0000 hostname systemd[1]: log message...
                    // Or for our services:
                    // 2023-10-25T14:32:00+0000 ubuntu bash[123]: ...
                    
                    const match = line.match(/^([0-9-T:+.]+)\s+\S+\s+([^:]+):\s+(.*)$/);
                    if (match) {
                        return {
                            timestamp: match[1],
                            service: match[2].trim(),
                            message: match[3]
                        };
                    }
                    return {
                        timestamp: new Date().toISOString(),
                        service: "system",
                        message: line
                    };
                });

                return { data: parsedLogs };
            } catch (error: unknown) {
                set.status = 500;
                return {
                    error: "Failed to fetch logs",
                    message: error instanceof Error ? error.message : "Unknown error",
                };
            }
        },
        {
            params: t.Object({
                ref: t.String({ minLength: 1 }),
            }),
            query: t.Object({
                limit: t.Optional(t.String()),
            })
        }
    );
