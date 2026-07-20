import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { Elysia, status, t } from "elysia";
import { sql } from "../db";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import {
  appendAuditEvent,
  redactAuditValue,
  verifyProjectAuditIntegrity,
} from "../services/audit.service";
import { resolveTrustedPrincipal, type TrustedPrincipal } from "../services/bff-proof.service";
import {
  requireCapability,
  type CollaboratorCapability,
} from "../services/project-collaborator.service";
import { hasSupaOAuthDelegationHeaders } from "../utils/bff-proof-headers";
import { ForbiddenError, isAppError, ValidationError } from "../utils/errors";

interface AuditLogRow {
  id: string;
  project_ref: string | null;
  actor: string;
  actor_type?: string;
  action: string;
  method: string;
  path: string;
  status: number | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  source?: string;
  metadata: Record<string, unknown> | string | null;
  previous_hash?: string | null;
  event_hash?: string | null;
  chain_sequence?: number | string | null;
  created_at: Date | string;
}

const authorizedActors = new WeakMap<Request, TrustedPrincipal>();

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

function toHttpError(error: unknown) {
  if (isAppError(error)) return status(error.statusCode, error.toJSON());
  throw error;
}

function parseMetadata(metadataValue: AuditLogRow["metadata"]): Record<string, unknown> {
  if (isRecord(metadataValue)) return metadataValue;
  if (typeof metadataValue !== "string" || !metadataValue.trim()) return {};
  try {
    const parsed = JSON.parse(metadataValue);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  return typeof metadata[key] === "string" && metadata[key] ? String(metadata[key]) : null;
}

function toAuditEntry(row: AuditLogRow) {
  const metadata = redactAuditValue(parseMetadata(row.metadata)) as Record<string, unknown>;
  const details = isRecord(metadata.details) ? metadata.details : metadata;
  return {
    id: row.id,
    project_ref: row.project_ref,
    event_type: row.action,
    actor_id: metadataString(metadata, "actor_id") || row.actor,
    actor_type: row.actor_type || metadataString(metadata, "actor_type") || "system",
    resource_type: metadataString(metadata, "resource_type") || "management_api",
    resource_id: metadataString(metadata, "resource_id") || row.path,
    details,
    method: row.method,
    path: row.path,
    status: row.status,
    source: row.source || "management-api",
    request_id: row.request_id,
    previous_hash: row.previous_hash || null,
    event_hash: row.event_hash || null,
    chain_sequence: row.chain_sequence === null || row.chain_sequence === undefined
      ? null
      : Number(row.chain_sequence),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function toSensitiveAuditEntry(row: AuditLogRow) {
  return {
    ...toAuditEntry(row),
    ip_address: row.ip_address,
    user_agent: row.user_agent ? redactAuditValue(row.user_agent) : row.user_agent,
  };
}

function optionalString(queryValue: unknown): string | null {
  return typeof queryValue === "string" && queryValue.trim() ? queryValue.trim() : null;
}

function parseLimit(queryValue: unknown, fallback = 100, max = 500): number {
  const parsed = Number(queryValue);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(1, Math.trunc(parsed))) : fallback;
}

function decodeCursor(cursorValue: string | null): { createdAt: string; id: string } | null {
  if (!cursorValue) return null;
  const decoded = Buffer.from(cursorValue, "base64url").toString("utf8");
  const split = decoded.lastIndexOf("|");
  const createdAt = decoded.slice(0, split);
  const id = decoded.slice(split + 1);
  return split > 0 && !Number.isNaN(Date.parse(createdAt)) && id ? { createdAt, id } : null;
}

function encodeCursor(row: AuditLogRow): string {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  return Buffer.from(`${createdAt}|${row.id}`).toString("base64url");
}

type AuditFilters = {
  eventType: string | null;
  resourceType: string | null;
  resourceId: string | null;
  actorId: string | null;
  from: string | null;
  to: string | null;
};

async function countAuditRows(ref: string, filters: AuditFilters): Promise<number> {
  const [row] = await sql`
    SELECT COUNT(*)::int AS count FROM audit_logs
    WHERE project_ref = ${ref}
      AND (${filters.eventType}::text IS NULL OR action = ${filters.eventType})
      AND (${filters.resourceType}::text IS NULL OR metadata->>'resource_type' = ${filters.resourceType})
      AND (${filters.resourceId}::text IS NULL OR metadata->>'resource_id' = ${filters.resourceId})
      AND (${filters.actorId}::text IS NULL OR actor = ${filters.actorId})
      AND (${filters.from}::timestamptz IS NULL OR created_at >= ${filters.from}::timestamptz)
      AND (${filters.to}::timestamptz IS NULL OR created_at <= ${filters.to}::timestamptz)
  `;
  return Number(row?.count || 0);
}

type AuditRowQuery = {
  ref: string;
  filters: AuditFilters;
  limit: number;
  cursor: { createdAt: string; id: string } | null;
  offset: number;
};

async function selectAuditRows(database: SQL, query: AuditRowQuery) {
  return database`
    SELECT id, project_ref, actor, actor_type, action, method, path, status,
           ip_address, user_agent, request_id, source, metadata,
           previous_hash, event_hash, chain_sequence, created_at
    FROM audit_logs
    WHERE project_ref = ${query.ref}
      AND (${query.filters.eventType}::text IS NULL OR action = ${query.filters.eventType})
      AND (${query.filters.resourceType}::text IS NULL OR metadata->>'resource_type' = ${query.filters.resourceType})
      AND (${query.filters.resourceId}::text IS NULL OR metadata->>'resource_id' = ${query.filters.resourceId})
      AND (${query.filters.actorId}::text IS NULL OR actor = ${query.filters.actorId})
      AND (${query.filters.from}::timestamptz IS NULL OR created_at >= ${query.filters.from}::timestamptz)
      AND (${query.filters.to}::timestamptz IS NULL OR created_at <= ${query.filters.to}::timestamptz)
      AND (${query.cursor?.createdAt || null}::timestamptz IS NULL
        OR (created_at, id) < (${query.cursor?.createdAt || null}::timestamptz, ${query.cursor?.id || null}::uuid))
    ORDER BY created_at DESC, id DESC
    LIMIT ${query.limit}
    OFFSET ${query.offset}
  ` as unknown as AuditLogRow[];
}

function csvCell(cellValue: unknown): string {
  const text = typeof cellValue === "string" ? cellValue : JSON.stringify(cellValue ?? "");
  const safeText = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

function renderExport(entries: ReturnType<typeof toAuditEntry>[], format: "jsonl" | "csv"): string {
  if (format === "jsonl") return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const columns = ["id", "created_at", "event_type", "actor_id", "actor_type", "resource_type", "resource_id", "request_id", "status", "details"] as const;
  return [
    columns.join(","),
    ...entries.map((entry) => columns.map((column) => csvCell(entry[column])).join(",")),
  ].join("\n") + "\n";
}

function filtersFromQuery(query: Record<string, unknown>): AuditFilters {
  return {
    eventType: optionalString(query.event_type),
    resourceType: optionalString(query.resource_type),
    resourceId: optionalString(query.resource_id),
    actorId: optionalString(query.actor_id),
    from: optionalString(query.from),
    to: optionalString(query.to),
  };
}

type AuditExportRequest = Record<string, unknown> & {
  format?: "jsonl" | "csv";
  limit?: number;
};

async function createAuditExport(ref: string, body: AuditExportRequest, actor: string) {
  const format = body.format || "jsonl";
  const filters = filtersFromQuery(body);
  const rowLimit = Math.min(50_000, Math.max(1, body.limit || 10_000));
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`audit-chain:${ref}`}))`;
    const rows = await selectAuditRows(tx, { ref, filters, limit: rowLimit, cursor: null, offset: 0 });
    const entries = rows.map(toAuditEntry);
    const content = renderExport(entries, format);
    const checksum = createHash("sha256").update(content).digest("hex");
    const [checkpoint] = await tx`
      SELECT last_event_hash FROM audit_log_checkpoints WHERE project_ref = ${ref}
    `;
    const [record] = await tx`
      INSERT INTO audit_exports (
        project_ref, actor, format, filters, status, row_count, checksum,
        checkpoint_hash, content, completed_at
      ) VALUES (
        ${ref}, ${actor}, ${format}, ${JSON.stringify(filters)}::jsonb,
        'completed', ${entries.length}, ${checksum}, ${checkpoint?.last_event_hash || null},
        ${content}, NOW()
      )
      RETURNING id, project_ref, actor, format, filters, status, row_count, checksum,
                checkpoint_hash, expires_at, created_at, completed_at
    `;
    return record;
  });
}

function auditCapability(request: Request): CollaboratorCapability {
  const pathname = new URL(request.url).pathname;
  if (pathname.includes("/audit/exports")) return "audit.export";
  if (pathname.endsWith("/audit/events") && request.method === "POST") return "audit.write";
  if (new URL(request.url).searchParams.get("include_sensitive") === "true") return "audit.read_sensitive";
  return "audit.read";
}

async function authorizeAuditWrite(
  request: Request,
  ref: string,
  actor: TrustedPrincipal,
): Promise<void> {
  if (!hasSupaOAuthDelegationHeaders(request)) {
    throw new ForbiddenError("A signed SupaOAuth delegation proof is required for audit events");
  }
  if (["user", "system"].includes(actor.type)) return;
  if (actor.type !== "admin") throw new ForbiddenError("Unsupported delegated audit actor type");
  await requireCapability(ref, actor, "audit.write");
}

async function authorizeAuditRequest(request: Request, ref: string): Promise<void> {
  const actor = await resolveTrustedPrincipal(request, ref);
  const capability = auditCapability(request);
  if (capability === "audit.write") {
    await authorizeAuditWrite(request, ref, actor);
  } else {
    await requireCapability(ref, actor, capability);
  }
  authorizedActors.set(request, actor);
}

function authorizedActor(request: Request): TrustedPrincipal {
  return authorizedActors.get(request)!;
}

export const projectAuditRoutes = new Elysia({ prefix: "/v1/projects/:ref/audit" })
  .onBeforeHandle(async ({ params, request }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
    try {
      await authorizeAuditRequest(request, params.ref);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("", async ({ params, query }) => {
    const filters = filtersFromQuery(query);
    const limit = parseLimit(query.limit);
    const cursorValue = optionalString(query.cursor);
    const cursor = decodeCursor(cursorValue);
    if (cursorValue && !cursor) return status(400, { message: "Invalid cursor", code: "VALIDATION_ERROR" });
    const offset = cursor ? 0 : Math.max(0, Math.trunc(Number(query.offset || 0) || 0));
    const [total, rows] = await Promise.all([
      countAuditRows(params.ref, filters),
      selectAuditRows(sql, { ref: params.ref, filters, limit: limit + 1, cursor, offset }),
    ]);
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(toAuditEntry),
      total,
      next_cursor: hasMore && pageRows.length > 0 ? encodeCursor(pageRows[pageRows.length - 1]) : null,
    };
  }, {
    query: t.Object({
      event_type: t.Optional(t.String()),
      resource_type: t.Optional(t.String()),
      resource_id: t.Optional(t.String()),
      actor_id: t.Optional(t.String()),
      limit: t.Optional(t.String()),
      offset: t.Optional(t.String()),
      cursor: t.Optional(t.String()),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
    }, { additionalProperties: true }),
    detail: { tags: ["audit"], summary: "Query append-only project audit logs" },
  })
  .post("/events", async ({ params, body, request, set }) => {
    try {
      const actor = authorizedActor(request);
      if (!body.event_type.trim() || !body.resource_type.trim() || !body.resource_id.trim()) {
        return status(400, { message: "event_type, resource_type and resource_id are required", code: "VALIDATION_ERROR" });
      }
      const row = await appendAuditEvent({
        projectRef: params.ref,
        actor: actor.id,
        actorType: actor.type,
        action: body.event_type,
        method: "EVENT",
        path: `/v1/projects/${params.ref}/audit/events`,
        status: 200,
        requestId: actor.requestId,
        source: "supauth",
        metadata: {
          resource_type: body.resource_type,
          resource_id: body.resource_id,
          details: body.details || {},
        },
      }) as AuditLogRow;
      set.status = 201;
      return toAuditEntry(row);
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    body: t.Object({
      event_type: t.String(),
      // Accepted for wire compatibility but intentionally ignored as authority.
      actor_id: t.Optional(t.Nullable(t.String())),
      actor_type: t.Optional(t.Nullable(t.String())),
      resource_type: t.String(),
      resource_id: t.String(),
      details: t.Optional(t.Record(t.String(), t.Unknown())),
    }, { additionalProperties: false }),
    detail: { tags: ["audit"], summary: "Record a product audit event with verified actor" },
  })
  .get("/integrity", async ({ params }) => {
    return verifyProjectAuditIntegrity(params.ref);
  }, {
    detail: { tags: ["audit"], summary: "Read project audit integrity checkpoint" },
  })
  .get("/exports", async ({ params }) => {
    const rows = await sql`
      SELECT id, project_ref, actor, format, filters, status, row_count, checksum,
             checkpoint_hash, expires_at, created_at, completed_at, error
      FROM audit_exports WHERE project_ref = ${params.ref}
      ORDER BY created_at DESC LIMIT 100
    `;
    return { items: rows, total: rows.length };
  }, {
    detail: { tags: ["audit"], summary: "List project audit exports" },
  })
  .post("/exports", async ({ params, body, request, set }) => {
    try {
      const principal = authorizedActor(request);
      const record = await createAuditExport(params.ref, body, principal.id);
      set.status = 201;
      return { ...record, download_url: `/v1/projects/${params.ref}/audit/exports/${record.id}/download` };
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    body: t.Object({
      format: t.Optional(t.Union([t.Literal("jsonl"), t.Literal("csv")])),
      event_type: t.Optional(t.String()),
      resource_type: t.Optional(t.String()),
      resource_id: t.Optional(t.String()),
      actor_id: t.Optional(t.String()),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      limit: t.Optional(t.Number({ minimum: 1, maximum: 50000 })),
    }, { additionalProperties: false }),
    detail: { tags: ["audit"], summary: "Create a bounded project audit export" },
  })
  .get("/exports/:exportId/download", async ({ params }) => {
    const [record] = await sql`
      SELECT format, content, checksum FROM audit_exports
      WHERE project_ref = ${params.ref} AND id = ${params.exportId}
        AND status = 'completed' AND expires_at > NOW()
    `;
    if (!record) return status(404, { message: "Audit export not found or expired", code: "NOT_FOUND" });
    const contentType = record.format === "csv" ? "text/csv" : "application/x-ndjson";
    return new Response(String(record.content || ""), {
      headers: {
        "content-type": `${contentType}; charset=utf-8`,
        "content-disposition": `attachment; filename="audit-${params.ref}-${params.exportId}.${record.format}"`,
        "x-content-sha256": String(record.checksum || ""),
        "cache-control": "private, no-store",
      },
    });
  }, {
    detail: { tags: ["audit"], summary: "Download a project audit export" },
  })
  .get("/exports/:exportId", async ({ params }) => {
    const [record] = await sql`
      SELECT id, project_ref, actor, format, filters, status, row_count, checksum,
             checkpoint_hash, expires_at, created_at, completed_at, error
      FROM audit_exports WHERE project_ref = ${params.ref} AND id = ${params.exportId}
    `;
    if (!record) return status(404, { message: "Audit export not found", code: "NOT_FOUND" });
    return { ...record, download_url: record.status === "completed" ? `/v1/projects/${params.ref}/audit/exports/${record.id}/download` : null };
  }, {
    detail: { tags: ["audit"], summary: "Get a project audit export" },
  })
  .get("/:logId", async ({ params, query, request }) => {
    try {
      if (query.include_sensitive && !["true", "false"].includes(query.include_sensitive)) {
        throw new ValidationError("include_sensitive must be true or false");
      }
      const includeSensitive = query.include_sensitive === "true";
      if (includeSensitive) {
        await requireCapability(params.ref, authorizedActor(request), "audit.read_sensitive");
      }
      const [row] = await sql`
        SELECT id, project_ref, actor, actor_type, action, method, path, status,
               ip_address, user_agent, request_id, source, metadata,
               previous_hash, event_hash, chain_sequence, created_at
        FROM audit_logs
        WHERE project_ref = ${params.ref} AND id = ${params.logId}
        LIMIT 1
      ` as AuditLogRow[];
      if (!row) return status(404, { message: "Audit log not found", code: "NOT_FOUND" });
      return includeSensitive ? toSensitiveAuditEntry(row) : toAuditEntry(row);
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    query: t.Object({ include_sensitive: t.Optional(t.String()) }, { additionalProperties: false }),
    detail: { tags: ["audit"], summary: "Get a project audit log entry" },
  });
