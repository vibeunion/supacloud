import { Elysia } from "elysia";
import { sql } from "../db";

export const taskRoutes = new Elysia({ prefix: "/v1/projects/:ref/tasks" })
    .get("/", async ({ params, set }: any) => {
        try {
            const tasks = await sql`
                SELECT id, task_type, status, error, created_at, updated_at
                FROM project_tasks
                WHERE project_ref = ${params.ref}
                ORDER BY created_at DESC
                LIMIT 50
            `;
            return tasks;
        } catch (err: any) {
            set.status = 500;
            return { error: "Failed to retrieve tasks", details: err.message };
        }
    });
