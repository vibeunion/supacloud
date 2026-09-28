import { Elysia } from "elysia";
import { createTaskOutputHandlers, type TaskOutputDependencies } from "./task-output-handler";

export function createTaskOutputRoutes(dependencies: TaskOutputDependencies) {
  const handlers = createTaskOutputHandlers(dependencies);
  return new Elysia({ name: "task-output", prefix: "/v1/projects/:ref/tasks" })
    .get("/:taskId/events", {
      detail: { tags: ["tasks"], summary: "Read an owned task's durable output using a decimal-string cursor" },
    }, ({ request, params }) => handlers.read(request, params))
    .post("/:taskId/events", {
      parse: "none",
      detail: { tags: ["tasks"], summary: "Append bounded output for an active task attempt (trusted executor only)" },
    }, ({ request, params }) => handlers.append(request, params));
}
