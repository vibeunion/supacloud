import { Elysia } from "elysia";
import { taskRoutes as existingTaskRoutes } from "./tasks";
import { taskOutputRoutes } from "./task-output";

/** Compose the optional extension without changing the existing task routes. */
export const taskRoutes = new Elysia({ name: "task-routes-with-output" })
  .use(existingTaskRoutes)
  .use(taskOutputRoutes);
