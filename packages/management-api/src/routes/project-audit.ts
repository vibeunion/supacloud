import { Elysia, status, t } from "elysia";
import { sql } from "../db";
import { requireProjectOrAdminAuth } from "../middleware/auth";

interface AuditLogRow {
  id: string;
  project_ref: string | null;
  actor: string;
  action: string;
  method: string;
  path: string;
  status: number | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: Date | string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadata(value: AuditLogRow["metadata"]): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function stringFromMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value ? value : null;
}

function toAuditEntry(row: AuditLogRow) {
  const metadata = parseMetadata(row.metadata);
  const details = isRecord(metadata.details) ? metadata.details : metadata;
  return {
    id: row.id,
    project_ref: row.project_ref,
    event_type: row.action,
    actor_id: stringFromMetadata(metadata, "actor_id") || row.actor,
    actor_type: stringFromMetadata(metadata, "actor_type") || "system",
    resource_type: stringFromMetadata(metadata, "resource_type") || "management_api",
    resource_id: stringFromMetadata(metadata, "resource_id") || row.path,
    details,
    method: row.method,
    path: row.path,
    status: row.status,
    request_id: row.request_id,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function parseOffset(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(Math.trunc(parsed), 0);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const projectAuditRoutes = new Elysia({ prefix: "/v1/projects/:ref/audit" })
  .onBeforeHandle(async ({ params, request }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .get("", async ({ params, query }) => {
    const eventType = optionalString(query.event_type);
    const resourceType = optionalString(query.resource_type);
    const resourceId = optionalString(query.resource_id);
    const actorId = optionalString(query.actor_id);
    const from = optionalString(query.from);
    const to = optionalString(query.to);
    const limit = parseLimit(query.limit, 100, 200);
    const offset = parseOffset(query.offset);

    const rows = await sql`
      SELECT id, project_ref, actor, action, method, path, status, ip_address, user_agent, request_id, metadata, created_at
      FROM audit_logs
      WHERE project_ref = ${params.ref}
        AND (${eventType}::text IS NULL OR action = ${eventType})
        AND (${resourceType}::text IS NULL OR metadata->>'resource_type' = ${resourceType})
        AND (${resourceId}::text IS NULL OR metadata->>'resource_id' = ${resourceId})
        AND (${actorId}::text IS NULL OR metadata->>'actor_id' = ${actorId} OR actor = ${actorId})
        AND (${from}::timestamptz IS NULL OR created_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR created_at <= ${to}::timestamptz)
      ORDER BY created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    ` as AuditLogRow[];

    const items = rows.map(toAuditEntry);
    return { items, total: items.length };
  }, {
    query: t.Object({
      event_type: t.Optional(t.String()),
      resource_type: t.Optional(t.String()),
      resource_id: t.Optional(t.String()),
      actor_id: t.Optional(t.String()),
      limit: t.Optional(t.String()),
      offset: t.Optional(t.String()),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
    }, { additionalProperties: true }),
    detail: { tags: ["audit"], summary: "Query project audit logs" },
  })
  .post("/events", async ({ params, body }) => {
    const input = body as {
      event_type: string;
      actor_id?: string | null;
      actor_type?: string | null;
      resource_type: string;
      resource_id: string;
      details?: Record<string, unknown>;
    };
    if (!input.event_type?.trim()) return status(400, { message: "event_type is required", code: "400" });
    if (!input.resource_type?.trim()) return status(400, { message: "resource_type is required", code: "400" });
    if (!input.resource_id?.trim()) return status(400, { message: "resource_id is required", code: "400" });

    const requestId = crypto.randomUUID();
    const metadata = {
      actor_id: input.actor_id || null,
      actor_type: input.actor_type || "system",
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      details: isRecord(input.details) ? input.details : {},
    };
    const rows = await sql`
      INSERT INTO audit_logs (project_ref, actor, action, method, path, status, request_id, metadata)
      VALUES (
        ${params.ref},
        ${input.actor_id || input.actor_type || "system"},
        ${input.event_type},
        ${"EVENT"},
        ${`/v1/projects/${params.ref}/audit/events`},
        ${200},
        ${requestId},
        ${JSON.stringify(metadata)}::jsonb
      )
      RETURNING id, project_ref, actor, action, method, path, status, ip_address, user_agent, request_id, metadata, created_at
    ` as AuditLogRow[];
    return toAuditEntry(rows[0]);
  }, {
    body: t.Object({
      event_type: t.String(),
      actor_id: t.Optional(t.Nullable(t.String())),
      actor_type: t.Optional(t.Nullable(t.String())),
      resource_type: t.String(),
      resource_id: t.String(),
      details: t.Optional(t.Record(t.String(), t.Unknown())),
    }, { additionalProperties: true }),
    detail: { tags: ["audit"], summary: "Record a project audit event" },
  })
  .get("/:logId", async ({ params }) => {
    const rows = await sql`
      SELECT id, project_ref, actor, action, method, path, status, ip_address, user_agent, request_id, metadata, created_at
      FROM audit_logs
      WHERE project_ref = ${params.ref} AND id = ${params.logId}
      LIMIT 1
    ` as AuditLogRow[];
    if (!rows[0]) return status(404, { message: "Audit log not found", code: "404" });
    return toAuditEntry(rows[0]);
  }, {
    detail: { tags: ["audit"], summary: "Get a project audit log entry" },
  });
