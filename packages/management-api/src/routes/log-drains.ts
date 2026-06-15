/**
 * Log Drains routes.
 *
 * Stores drain config under `projects.config.log_drains` and exposes a tiny
 * best-effort forwarder the platform can call when it has captured log events.
 * Mirrors the task-events webhook route shape so the web console and CLI can
 * list/create/update/delete drains against a single, persistent REST surface.
 */
import { Elysia, status, t } from "elysia";
import * as authMiddleware from "../middleware/auth";
import { projectRepository } from "../repositories/project.repository";
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";
import { logger } from "../utils/logger";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type LogDrainType = "webhook" | "datadog" | "loki" | "elasticsearch";

export interface LogDrainConfig {
  id: string;
  name: string;
  type: LogDrainType;
  url: string;
  token?: string;
  enabled: boolean;
}

const ALLOWED_TYPES: ReadonlySet<LogDrainType> = new Set([
  "webhook",
  "datadog",
  "loki",
  "elasticsearch",
]);

const MAX_DRAINS_PER_PROJECT = 10;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
]);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80:") ||
    lower.startsWith("::ffff:10.") ||
    lower.startsWith("::ffff:127.") ||
    lower.startsWith("::ffff:169.254.") ||
    lower.startsWith("::ffff:192.168.")
  );
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}

export function validateLogDrainUrl(urlValue: string): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlValue.trim());
  } catch {
    return { ok: false, error: "url must be a valid HTTP(S) URL" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "url must be a valid HTTP(S) URL" };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    return { ok: false, error: "url host is not allowed for log drains" };
  }

  if (isIP(hostname) && isBlockedAddress(hostname)) {
    return { ok: false, error: "url host must not resolve to a private or local address" };
  }

  return { ok: true, url: parsed.toString() };
}

async function isLogDrainUrlSafeForFetch(urlValue: string): Promise<boolean> {
  const validated = validateLogDrainUrl(urlValue);
  if (!validated.ok) return false;

  const hostname = new URL(validated.url).hostname;
  if (isIP(hostname)) return true;

  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results.length > 0 && results.every((result) => !isBlockedAddress(result.address));
  } catch (err: unknown) {
    logger.debug("[log-drains] failed to resolve drain host", {
      host: hostname,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function isLogDrainConfig(value: unknown): value is LogDrainConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const drain = value as Record<string, unknown>;
  return (
    typeof drain.id === "string" &&
    typeof drain.name === "string" &&
    typeof drain.type === "string" &&
    ALLOWED_TYPES.has(drain.type as LogDrainType) &&
    typeof drain.url === "string" &&
    typeof drain.enabled === "boolean"
  );
}

function readDrains(projectConfig: unknown): LogDrainConfig[] {
  const config = normalizeProjectConfig(projectConfig as Record<string, unknown> | null | undefined);
  const raw = config.log_drains;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isLogDrainConfig);
}

function sanitizeDrain(drain: LogDrainConfig): LogDrainConfig {
  return {
    id: drain.id,
    name: drain.name.slice(0, 120),
    type: drain.type,
    url: drain.url,
    token: typeof drain.token === "string" && drain.token.trim().length > 0 ? drain.token.trim() : undefined,
    enabled: drain.enabled,
  };
}

export const logDrainRoutes = new Elysia({ prefix: "/v1/projects/:ref/log-drains" })
  .onBeforeHandle(async ({ params, request }) => {
    const authError = await authMiddleware.requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .get("", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) {
      return status(404, { error: "Project not found" });
    }

    const drains = readDrains(project.config).map((drain) => ({
      ...drain,
      has_token: !!drain.token,
      token: drain.token ? "********" : undefined,
    }));

    return { project_ref: params.ref, drains };
  }, {
    detail: { tags: ["log-drains"], summary: "List configured log drains" },
  })
  .post("", async ({ params, body }) => {
    const input = body as { name: string; type: LogDrainType; url: string; token?: string };

    if (!input.name?.trim()) {
      return status(400, { error: "name is required" });
    }
    if (!ALLOWED_TYPES.has(input.type)) {
      return status(400, { error: `type must be one of: ${[...ALLOWED_TYPES].join(", ")}` });
    }
    const urlResult = validateLogDrainUrl(input.url || "");
    if (!urlResult.ok) {
      return status(400, { error: urlResult.error });
    }

    const project = await projectRepository.findByRef(params.ref);
    if (!project) {
      return status(404, { error: "Project not found" });
    }

    const existing = readDrains(project.config);
    if (existing.length >= MAX_DRAINS_PER_PROJECT) {
      return status(400, { error: `A project can have at most ${MAX_DRAINS_PER_PROJECT} log drains` });
    }

    const newDrain = sanitizeDrain({
      id: crypto.randomUUID(),
      name: input.name.trim(),
      type: input.type,
      url: urlResult.url,
      token: input.token?.trim() || undefined,
      enabled: true,
    });

    const updated = await projectRepository.updateConfig(
      params.ref,
      mergeProjectConfig(project.config, {
        log_drains: [...existing, newDrain],
      }),
    );

    if (!updated) {
      return status(404, { error: "Project not found" });
    }

    return {
      created: true,
      project_ref: params.ref,
      drain: { ...newDrain, has_token: !!newDrain.token, token: newDrain.token ? "********" : undefined },
    };
  }, {
    body: t.Object({
      name: t.String(),
      type: t.Union([t.Literal("webhook"), t.Literal("datadog"), t.Literal("loki"), t.Literal("elasticsearch")]),
      url: t.String(),
      token: t.Optional(t.String()),
    }),
    detail: { tags: ["log-drains"], summary: "Create a log drain" },
  })
  .patch("/:drainId", async ({ params, body }) => {
    const input = body as Partial<Pick<LogDrainConfig, "name" | "url" | "token" | "enabled">>;

    const project = await projectRepository.findByRef(params.ref);
    if (!project) {
      return status(404, { error: "Project not found" });
    }

    const drains = readDrains(project.config);
    const target = drains.find((drain) => drain.id === params.drainId);
    if (!target) {
      return status(404, { error: "Log drain not found" });
    }

    const nextUrl = input.url === undefined ? target.url : validateLogDrainUrl(input.url);
    if (nextUrl !== target.url && typeof nextUrl !== "string" && !nextUrl.ok) {
      return status(400, { error: nextUrl.error });
    }

    const updatedDrain: LogDrainConfig = {
      ...target,
      name: input.name !== undefined ? input.name.trim().slice(0, 120) : target.name,
      url: typeof nextUrl === "string" ? nextUrl : nextUrl.url,
      enabled: input.enabled !== undefined ? !!input.enabled : target.enabled,
      // Empty token clears the secret; missing key keeps the previous one.
      token: input.token !== undefined ? (input.token.trim() || undefined) : target.token,
    };

    const next = drains.map((drain) => (drain.id === target.id ? updatedDrain : drain));
    const updated = await projectRepository.updateConfig(
      params.ref,
      mergeProjectConfig(project.config, { log_drains: next }),
    );

    if (!updated) {
      return status(404, { error: "Project not found" });
    }

    return {
      updated: true,
      project_ref: params.ref,
      drain: { ...updatedDrain, has_token: !!updatedDrain.token, token: updatedDrain.token ? "********" : undefined },
    };
  }, {
    body: t.Object({
      name: t.Optional(t.String()),
      url: t.Optional(t.String()),
      token: t.Optional(t.String()),
      enabled: t.Optional(t.Boolean()),
    }),
    detail: { tags: ["log-drains"], summary: "Update a log drain" },
  })
  .delete("/:drainId", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) {
      return status(404, { error: "Project not found" });
    }

    const drains = readDrains(project.config);
    const next = drains.filter((drain) => drain.id !== params.drainId);
    if (next.length === drains.length) {
      return status(404, { error: "Log drain not found" });
    }

    const updated = await projectRepository.updateConfig(
      params.ref,
      mergeProjectConfig(project.config, { log_drains: next }),
    );
    if (!updated) {
      return status(404, { error: "Project not found" });
    }

    return { deleted: true, project_ref: params.ref, drain_id: params.drainId };
  }, {
    detail: { tags: ["log-drains"], summary: "Delete a log drain" },
  });

/**
 * Best-effort forward a single log event to every enabled drain for a project.
 * Fire-and-forget: callers must not depend on the delivery outcome and the
 * forwarder swallows errors so log forwarding never blocks request handling.
 */
export async function forwardLogEvent(
  projectRef: string,
  event: { timestamp: string; source: string; severity: string; message: string; metadata?: Record<string, unknown> },
): Promise<void> {
  let drains: LogDrainConfig[] = [];
  try {
    const project = await projectRepository.findByRef(projectRef);
    if (!project) return;
    drains = readDrains(project.config).filter((drain) => drain.enabled);
  } catch (err) {
    logger.debug("[log-drains] failed to load drains", { projectRef, error: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (drains.length === 0) return;

  const basePayload = JSON.stringify(event);

  await Promise.allSettled(
    drains.map(async (drain) => {
      try {
        if (!(await isLogDrainUrlSafeForFetch(drain.url))) {
          logger.warn("[log-drains] skipped unsafe drain url", { projectRef, drainId: drain.id });
          return;
        }

        const headers: Record<string, string> = { "content-type": "application/json" };
        if (drain.token) {
          if (drain.type === "datadog") {
            headers["dd-api-key"] = drain.token;
          } else {
            headers["authorization"] = `Bearer ${drain.token}`;
          }
        }

        await fetch(drain.url, {
          method: "POST",
          headers,
          body: basePayload,
          signal: AbortSignal.timeout(5000),
        });
      } catch (err) {
        logger.debug("[log-drains] failed to forward", {
          projectRef,
          drainId: drain.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}
