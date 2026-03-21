import { Elysia, status } from "elysia";
import { logger } from "../utils/logger";
import { sql } from "../db";

export const taskRoutes = new Elysia({ prefix: "/v1/projects/:ref/tasks" })
    .get("/", async ({ params }) => {
        try {
            const tasks = await sql`
                SELECT id, task_type, status, error, created_at, updated_at
                FROM project_tasks
                WHERE project_ref = ${params.ref}
                ORDER BY created_at DESC
                LIMIT 50
            `;
            return tasks;
        } catch (err: unknown) {
                        return status(500, { error: "Failed to retrieve tasks", details: (err instanceof Error ? err.message : String(err)) });
        }
    });
