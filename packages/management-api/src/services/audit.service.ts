import { sql } from "../db";
import { extractProjectRefFromPath } from "../utils/project-auth";
import { logger } from "../utils/logger";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function actorFromRequest(request: Request): string {
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) return `bearer:${auth.slice(7, 19)}`;
  return "anonymous";
}

function ipFromRequest(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

export function shouldAuditRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.pathname.startsWith("/v1") && WRITE_METHODS.has(request.method.toUpperCase());
}

export async function logAuditEvent(input: {
  request: Request;
  status?: number;
  action?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    const url = new URL(input.request.url);
    const action = input.action || `${input.request.method.toUpperCase()} ${url.pathname}`;
    const projectRef = extractProjectRefFromPath(url.pathname);
    await sql`
      INSERT INTO audit_logs (project_ref, actor, action, method, path, status, ip_address, user_agent, request_id, metadata)
      VALUES (
        ${projectRef},
        ${actorFromRequest(input.request)},
        ${action},
        ${input.request.method.toUpperCase()},
        ${url.pathname},
        ${input.status || null},
        ${ipFromRequest(input.request)},
        ${input.request.headers.get("user-agent") || ""},
        ${input.request.headers.get("x-request-id") || crypto.randomUUID()},
        ${JSON.stringify(input.metadata || {})}
      )
    `;
  } catch (error: unknown) {
    logger.warn("Failed to write audit log", { error: error instanceof Error ? error.message : String(error) });
  }
}
