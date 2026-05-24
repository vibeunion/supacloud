/**
 * Task lifecycle webhook config routes.
 *
 * Stores webhook config under `projects.config.task_event_webhook` so the
 * consumer keeps its own business task table and can survive restarts.
 */
import { Elysia, status, t } from "elysia";
import * as authMiddleware from "../middleware/auth";
import { projectRepository } from "../repositories/project.repository";
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";

interface TaskEventWebhookConfig {
  url: string;
  secret?: string;
}

function isTaskEventWebhookConfig(value: unknown): value is TaskEventWebhookConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const webhook = value as Record<string, unknown>;
  return typeof webhook.url === "string";
}

function readWebhookConfig(projectConfig: Record<string, unknown> | null | undefined): { url: string; secret?: string } | null {
  const config = normalizeProjectConfig(projectConfig);
  const webhook = config.task_event_webhook;
  if (!isTaskEventWebhookConfig(webhook)) return null;

  const url = webhook.url.trim();
  if (!url) return null;

  const secret = typeof webhook.secret === "string" && webhook.secret.trim().length > 0
    ? webhook.secret.trim()
    : undefined;
  return { url, secret };
}

export const taskEventRoutes = new Elysia({ prefix: "/v1/projects/:ref/task-events" })
  .onBeforeHandle(async ({ params, request }) => {
    const authError = await authMiddleware.requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .post("/webhook", async ({ params, body }) => {
    const input = body as { url: string; secret?: string };
    const url = input.url?.trim();
    if (!url || !/^https:\/\//i.test(url)) {
      return status(400, { error: "url must be a valid HTTPS URL" });
    }

    const project = await projectRepository.findByRef(params.ref);
    if (!project) {
      return status(404, { error: "Project not found" });
    }

    const updated = await projectRepository.updateConfig(
      params.ref,
      mergeProjectConfig(project.config, {
        task_event_webhook: {
          url,
          secret: input.secret?.trim() || undefined,
        },
      }),
    );

    if (!updated) {
      return status(404, { error: "Project not found" });
    }

    return { registered: true, project_ref: params.ref, url };
  }, {
    body: t.Object({
      url: t.String(),
      secret: t.Optional(t.String()),
    }),
    detail: { tags: ["task-events"], summary: "Register a task lifecycle webhook" },
  })
  .delete("/webhook", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) {
      return status(404, { error: "Project not found" });
    }

    const config = normalizeProjectConfig(project.config);
    if (!config.task_event_webhook) {
      return status(404, { error: "No webhook registered for this project" });
    }

    const next = { ...config };
    delete next.task_event_webhook;
    const updated = await projectRepository.updateConfig(params.ref, next);
    if (!updated) {
      return status(404, { error: "Project not found" });
    }

    return { unregistered: true, project_ref: params.ref };
  }, {
    detail: { tags: ["task-events"], summary: "Unregister the task lifecycle webhook" },
  })
  .get("/webhook", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) {
      return status(404, { error: "Project not found" });
    }

    const webhook = readWebhookConfig(project.config);
    if (!webhook) {
      return status(404, { error: "No webhook registered for this project" });
    }

    return {
      project_ref: params.ref,
      url: webhook.url,
      has_secret: !!webhook.secret,
    };
  }, {
    detail: { tags: ["task-events"], summary: "Inspect the task lifecycle webhook" },
  });
