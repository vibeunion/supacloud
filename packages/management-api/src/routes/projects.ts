/**
 * Project Routes — Re-export barrel
 * 
 * Original monolithic file has been split into:
 * - project-crud.ts     — CRUD operations (list, create, get, update, delete, pause, restore)
 * - project-services.ts — Service control (health, status, usage, restart, service start/stop)
 * - project-config.ts   — Configuration (settings, API keys, auth config, gateway, pgbouncer)
 * 
 * This file composes them back into a single `projectRoutes` export for backward compatibility.
 */
import { Elysia } from "elysia";
import { projectEndpointRoutes } from "./project-endpoints";
import { projectCrudRoutes } from "./project-crud";
import { projectServiceRoutes } from "./project-services";
import { projectConfigRoutes } from "./project-config";

export const projectRoutes = new Elysia()
  .use(projectEndpointRoutes)
  .use(projectCrudRoutes)
  .use(projectServiceRoutes)
  .use(projectConfigRoutes);
