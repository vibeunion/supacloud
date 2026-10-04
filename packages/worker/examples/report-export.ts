import { SQL } from "bun";
import { createHash } from "node:crypto";
import { parseWorkerExecutionGroup, type WorkerExecutionGroup } from "@supacloud/delivery/worker-execution";
import {
  createExecutionGroupWorker, workerEnvelope, admitWorkerOperation, releaseWorkerOperation,
  type WorkerTransaction,
} from "../src/index.js";

export interface ReportActor { actorId: string; tenantId: string }
export interface ReportSnapshot { sourceId: string; revision: string }
export interface ReportObject { objectId: string; sha256: string; rows: number }
export interface ReportObjectWriter {
  write(chunk: Uint8Array): Promise<void>;
  /** Conditional, immutable publish: same operation/digest replays, different bytes conflict. */
  commit(sha256: string): Promise<string>;
  abort(): Promise<void>;
}
export interface ReportExportDomain {
  /** Verify current identity, source ownership and the immutable snapshot revision. */
  authorize(actor: ReportActor, snapshot: ReportSnapshot, signal?: AbortSignal): Promise<boolean>;
  /** Stable, immutable source; each page must respect the supplied hard limit. */
  page(snapshot: ReportSnapshot, cursor: string | null, limit: number, signal: AbortSignal):
    Promise<{ rows: readonly (readonly (string | number | boolean | null)[])[]; next: string | null }>;
  /** Server-owned object namespace; never accept a destination URL from a task payload. */
  open(operationId: string): Promise<ReportObjectWriter>;
}
interface RequestRow {
  operation_id: string; actor_id: string; tenant_id: string; source_id: string; revision: string;
  group_name: string; status: "pending" | "succeeded" | "failed";
  object_id: string | null; sha256: string | null; row_count: number | null;
}
function tx(sql: Pick<SQL, "unsafe">): WorkerTransaction {
  return { query: async (text, args = []) => {
    const value: unknown = await sql.unsafe(text, [...args]);
    return value;
  } };
}
function decode(value: unknown): { requestId: string } {
  if (!value || typeof value !== "object" || !("requestId" in value)
    || typeof value.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(value.requestId)
    || Object.keys(value).length !== 1) throw new Error("REPORT_EXPORT_INPUT_INVALID");
  return { requestId: value.requestId };
}
function csv(row: readonly (string | number | boolean | null)[]): string {
  return row.map(value => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("REPORT_EXPORT_ROW_INVALID");
    // Spreadsheet formula injection is escaped in text cells, not numeric cells.
    const text = value === null ? "" : String(value);
    const safe = typeof value === "string" && /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  }).join(",") + "\r\n";
}

/** A complete short, bounded export path. Long exports should be split into versioned shards. */
export function createReportExport(options: {
  projectRef: string; connectionString: string; group: WorkerExecutionGroup;
  maxRows?: number; maxBytes?: number;
}, domain: ReportExportDomain) {
  const group = parseWorkerExecutionGroup(options.group);
  const maxRows = options.maxRows ?? 100000, maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1_000_000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 3) throw new Error("REPORT_EXPORT_LIMIT_INVALID");
  const database = new SQL(options.connectionString, {
    max: group.database.handlerConnectionsPerReplica, connectionTimeout: 5, idleTimeout: 30,
  });
  async function request(id: string, connection: Pick<SQL, "unsafe"> = database): Promise<RequestRow> {
    const rows = await connection.unsafe<RequestRow[]>("SELECT * FROM report_export_example.requests WHERE operation_id=$1::uuid", [id]);
    if (rows.length !== 1) throw new Error("REPORT_EXPORT_NOT_FOUND");
    return rows[0]!;
  }
  const actor = (row: RequestRow) => ({ actorId: row.actor_id, tenantId: row.tenant_id });
  const snapshot = (row: RequestRow) => ({ sourceId: row.source_id, revision: row.revision });
  const binding = (operationId: string) => ({ projectRef: options.projectRef, group: group.name, operationId });
  const allowed = async (row: RequestRow, signal?: AbortSignal) =>
    row.group_name === group.name && await domain.authorize(actor(row), snapshot(row), signal);
  const worker = createExecutionGroupWorker({
    projectRef: options.projectRef, connectionString: options.connectionString, group,
  }, {
    decode,
    async preflight(policy, projectRef) {
      const rows = await database`SELECT i.project_ref,l.max_outstanding
        FROM supacloud_worker.installation i CROSS JOIN supacloud_worker.admission_limits l
        WHERE i.singleton AND l.group_name=${policy.name}`;
      if (rows.length !== 1 || rows[0].project_ref !== projectRef
        || rows[0].max_outstanding !== policy.admission.maxOutstandingOperations) throw new Error("REPORT_EXPORT_BINDING_INVALID");
      // Queue existence and read/settlement grants are additionally checked by the engine.
      await database`SELECT queue_name FROM pgmq.list_queues() WHERE queue_name=${policy.queue}`.then(rows => {
        if (rows.length !== 1) throw new Error("REPORT_EXPORT_QUEUE_MISSING");
      });
    },
    async probe(signal) {
      const pending = database`SELECT 1`;
      const abort = () => pending.cancel();
      signal.addEventListener("abort", abort, { once: true });
      try { signal.throwIfAborted(); await pending; return !signal.aborted; }
      finally { signal.removeEventListener("abort", abort); }
    },
    authorize: async (input, context) =>
      input.requestId === context.idempotencyKey && allowed(await request(input.requestId), context.signal),
    async execute(input, context) {
      const existing = await request(input.requestId);
      if (existing.status !== "pending") return;
      const writer = await domain.open(input.requestId);
      const hash = createHash("sha256");
      let cursor: string | null = null, count = 0, bytes = 0, committed = false;
      try {
        do {
          context.signal.throwIfAborted();
          const page = await domain.page(snapshot(existing), cursor, 500, context.signal);
          if (page.rows.length > 500 || (page.next !== null && (page.next === cursor || !page.next || !page.rows.length))) {
            throw new Error("REPORT_EXPORT_PAGE_INVALID");
          }
          count += page.rows.length;
          if (count > maxRows) throw new Error("REPORT_EXPORT_TOO_LARGE");
          for (const row of page.rows) {
            const chunk = new TextEncoder().encode(csv(row));
            bytes += chunk.byteLength;
            if (bytes > maxBytes || chunk.byteLength > 1024 * 1024) throw new Error("REPORT_EXPORT_TOO_LARGE");
            hash.update(chunk);
            await writer.write(chunk);
          }
          cursor = page.next;
        } while (cursor !== null);
        context.signal.throwIfAborted();
        const sha256 = hash.digest("hex");
        const objectId = await writer.commit(sha256);
        committed = true;
        if (!objectId || objectId.length > 512) throw new Error("REPORT_EXPORT_OBJECT_INVALID");
        await database.begin(async connection => {
          const current = await request(input.requestId, connection);
          if (!await allowed(current, context.signal)) throw new Error("REPORT_EXPORT_FORBIDDEN");
          await connection`UPDATE report_export_example.requests
            SET status='succeeded',object_id=${objectId},sha256=${sha256},row_count=${count},completed_at=clock_timestamp()
            WHERE operation_id=${input.requestId}::uuid AND status='pending'`;
          const terminal = await request(input.requestId, connection);
          if (terminal.status !== "succeeded" || terminal.object_id !== objectId || terminal.sha256 !== sha256
            || terminal.row_count !== count) throw new Error("REPORT_EXPORT_RESULT_CONFLICT");
          await releaseWorkerOperation(tx(connection), binding(input.requestId), async () => "succeeded");
        });
      } finally { if (!committed) await writer.abort(); }
    },
    close: () => database.close(),
  });
  return {
    worker,
    async submit(identity: ReportActor, source: ReportSnapshot, operationId: string) {
      decode({ requestId: operationId });
      if (!await domain.authorize(identity, source)) throw new Error("REPORT_EXPORT_FORBIDDEN");
      const fingerprint = createHash("sha256").update(JSON.stringify([
        identity.tenantId, identity.actorId, source.sourceId, source.revision, group.taskKey, group.definitionVersion,
      ])).digest("hex");
      return database.begin(async connection => {
        const admission = await admitWorkerOperation(tx(connection), binding(operationId), fingerprint);
        if (admission.admitted) {
          await connection`INSERT INTO report_export_example.requests
            (operation_id,actor_id,tenant_id,source_id,revision,group_name)
            VALUES (${operationId}::uuid,${identity.actorId},${identity.tenantId},${source.sourceId},${source.revision},${group.name})`;
          // PGMQ is in this database: enqueue and intent commit atomically, with no second dispatcher.
          await connection`SELECT pgmq.send(${group.queue},
            ${workerEnvelope(group, options.projectRef, operationId, { requestId: operationId })}::jsonb)`;
        }
        const row = await request(operationId, connection);
        if (row.actor_id !== identity.actorId || row.tenant_id !== identity.tenantId) throw new Error("REPORT_EXPORT_FORBIDDEN");
        return { operationId, status: row.status, replayed: !admission.admitted };
      });
    },
    async result(identity: ReportActor, operationId: string): Promise<ReportObject | null> {
      decode({ requestId: operationId });
      const row = await request(operationId);
      if (row.actor_id !== identity.actorId || row.tenant_id !== identity.tenantId || !await allowed(row)) {
        throw new Error("REPORT_EXPORT_FORBIDDEN");
      }
      return row.status === "succeeded" && row.object_id && row.sha256 && row.row_count !== null
        ? { objectId: row.object_id, sha256: row.sha256, rows: row.row_count } : null;
    },
    close: () => worker.close(),
  };
}
