import { SQL } from "bun";
import { createHash } from "node:crypto";
import { mkdir, open, link, unlink, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TaskHandler } from "../../src/queue-handler.js";
import { submitBoundedTask, TaskSubmissionError } from "../../src/bounded-admission.js";
import type { createWorkerTelemetry } from "../../src/telemetry.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface ReportInput { operationId: string }
interface Chunk { sequence: number; last_row_id: string; row_count: number; digest: string }

export class LocalArtifacts {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  async put(content: string): Promise<string> {
    const digest = createHash("sha256").update(content).digest("hex");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.tmp-${crypto.randomUUID()}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
      await file.close();
      try { await link(temporary, join(this.directory, digest)); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        if ((await this.read(digest)).toString() !== content) throw new Error("ARTIFACT_CONFLICT");
      }
      return digest;
    } finally { await file.close(); await unlink(temporary); }
  }
  async read(digest: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("ARTIFACT_INVALID");
    const content = await readFile(join(this.directory, digest));
    if (createHash("sha256").update(content).digest("hex") !== digest) throw new Error("ARTIFACT_CORRUPT");
    return content;
  }
}

export async function submitReport(sql: SQL, projectRef: string, actorId: string,
  operationId: string, sourceId: string, revision: string) {
  if (!uuid.test(operationId) || !uuid.test(sourceId) || revision.length > 100)
    throw new Error("REPORT_INPUT_INVALID");
  return submitBoundedTask(sql, { projectRef, queueName: "scw_reports", taskKey: "report.generate" }, async tx => {
    const [source] = await tx<{ id: string }[]>`
      SELECT id FROM report_demo.sources WHERE id=${sourceId} AND revision=${revision}
        AND owner_id=${actorId} AND frozen`;
    if (!source) throw new TaskSubmissionError("REPORT_FORBIDDEN");
    const inserted = await tx`
      INSERT INTO report_demo.requests(operation_id,source_id,revision,actor_id)
      VALUES (${operationId},${sourceId},${revision},${actorId}) ON CONFLICT DO NOTHING RETURNING operation_id`;
    const [request] = await tx<{ source_id: string; revision: string; actor_id: string }[]>`
      SELECT source_id,revision,actor_id FROM report_demo.requests WHERE operation_id=${operationId} FOR UPDATE`;
    if (!request || request.source_id !== sourceId || request.revision !== revision || request.actor_id !== actorId)
      throw new TaskSubmissionError("REPORT_OPERATION_CONFLICT");
    return inserted.length === 0
      ? { replay: true, value: operationId }
      : { replay: false, value: operationId, idempotencyKey: operationId, input: { operationId } };
  });
}

function csv(value: string): string {
  // Neutralize spreadsheet formulas in text labels; numeric columns stay numeric.
  const safe = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function reportHandler(options: {
  sql: SQL; artifacts: LocalArtifacts;
  telemetry: ReturnType<typeof createWorkerTelemetry>;
  batchSize: number;
  maxAttempts?: number;
}): TaskHandler<ReportInput> {
  const { sql, artifacts, telemetry } = options;
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1000 ||
    !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 11)
    throw new Error("REPORT_BATCH_INVALID");
  return {
    decode(input) {
      if (!input || typeof input !== "object" || !("operationId" in input) ||
        typeof input.operationId !== "string" || !uuid.test(input.operationId) ||
        Object.keys(input).length !== 1) throw new Error("REPORT_INPUT_INVALID");
      return { operationId: input.operationId };
    },
    async authorize(input, context) {
      if (context.idempotencyKey !== input.operationId) return false;
      const [row] = await sql`SELECT 1 FROM report_demo.requests r
        JOIN report_demo.sources s ON s.id=r.source_id AND s.revision=r.revision AND s.owner_id=r.actor_id
        WHERE r.operation_id=${input.operationId} AND s.frozen AND r.state<>'revoked'`;
      return Boolean(row);
    },
    async execute({ operationId }, context) {
      try {
      const [request] = await sql<{ source_id: string; state: string }[]>`
        SELECT source_id,state FROM report_demo.requests WHERE operation_id=${operationId}`;
      if (!request || request.state === "revoked") throw new Error("REPORT_FORBIDDEN");
      if (request.state === "completed") return;
      const chunks = await sql<Chunk[]>`
        SELECT sequence,last_row_id::text,row_count,digest FROM report_demo.chunks
        WHERE operation_id=${operationId} ORDER BY sequence`;
      for (const chunk of chunks) await artifacts.read(chunk.digest);
      let cursor = chunks.at(-1)?.last_row_id ?? "0";
      let sequence = chunks.length;
      while (true) {
        context.signal.throwIfAborted();
        const rows = await telemetry.measure("read", () => sql<{ row_id: string; label: string; amount_cents: string }[]>`
          SELECT row_id::text,label,amount_cents::text FROM report_demo.rows
          WHERE source_id=${request.source_id} AND row_id>${cursor}::bigint
          ORDER BY report_demo.rows.row_id LIMIT ${options.batchSize}`);
        if (rows.length === 0) {
          if (sequence === 0) {
            const digest = await artifacts.put("row_id,label,amount_cents\n");
            await sql`INSERT INTO report_demo.chunks VALUES (${operationId},0,0,0,${digest}) ON CONFLICT DO NOTHING`;
          }
          break;
        }
        const content = await telemetry.measure("compute", () =>
          (sequence === 0 ? "row_id,label,amount_cents\n" : "") +
          rows.map(row => `${row.row_id},${csv(row.label)},${row.amount_cents}\n`).join(""));
        const digest = await telemetry.measure("write", () => artifacts.put(content));
        const last = rows.at(-1)!.row_id;
        await telemetry.measure("write", () => sql.begin(async tx => {
          const [state] = await tx<{ state: string }[]>`
            SELECT state FROM report_demo.requests WHERE operation_id=${operationId} FOR UPDATE`;
          if (state?.state === "revoked") throw new Error("REPORT_FORBIDDEN");
          await tx`INSERT INTO report_demo.chunks VALUES (${operationId},${sequence},${last},${rows.length},${digest})
            ON CONFLICT DO NOTHING`;
          const [saved] = await tx<{ digest: string }[]>`
            SELECT digest FROM report_demo.chunks WHERE operation_id=${operationId} AND sequence=${sequence}`;
          if (saved?.digest !== digest) throw new Error("REPORT_CHECKPOINT_CONFLICT");
        }));
        cursor = last;
        sequence++;
      }
      context.signal.throwIfAborted();
      await telemetry.measure("write", () => sql.begin(async tx => {
        const [state] = await tx<{ state: string }[]>`
          SELECT state FROM report_demo.requests WHERE operation_id=${operationId} FOR UPDATE`;
        if (state?.state === "revoked") throw new Error("REPORT_FORBIDDEN");
        const [totals] = await tx<{ actual: string; expected: string }[]>`
          SELECT (SELECT COALESCE(sum(row_count),0)::text FROM report_demo.chunks WHERE operation_id=${operationId}) actual,
            (SELECT count(*)::text FROM report_demo.rows WHERE source_id=${request.source_id}) expected`;
        if (!totals || totals.actual !== totals.expected) throw new Error("REPORT_ROW_COUNT_MISMATCH");
        await tx`INSERT INTO report_demo.receipts(operation_id,row_count)
          SELECT ${operationId}::uuid,COALESCE(sum(row_count),0) FROM report_demo.chunks
          WHERE operation_id=${operationId} ON CONFLICT DO NOTHING`;
        await tx`UPDATE report_demo.requests SET state='completed',last_error_code=NULL WHERE operation_id=${operationId}`;
      }));
      } catch (error) {
        if (!context.signal.aborted) {
          await sql`UPDATE report_demo.requests SET last_attempt=${context.attempt},
            last_error_code='REPORT_EXECUTION_FAILED',
            state=CASE WHEN ${context.attempt}::int>=${maxAttempts}::int THEN 'failed' ELSE state END
            WHERE operation_id=${operationId} AND state NOT IN ('completed','revoked')`;
        }
        throw error;
      }
    },
  };
}

export async function downloadReport(sql: SQL, artifacts: LocalArtifacts, actorId: string, operationId: string) {
  if (!uuid.test(operationId)) throw new Error("REPORT_INPUT_INVALID");
  const [allowed] = await sql`SELECT 1 FROM report_demo.requests r
    JOIN report_demo.receipts receipt USING(operation_id)
    WHERE r.operation_id=${operationId} AND r.actor_id=${actorId} AND r.state='completed'`;
  if (!allowed) throw new Error("REPORT_FORBIDDEN");
  const chunks = await sql<{ digest: string }[]>`
    SELECT digest FROM report_demo.chunks WHERE operation_id=${operationId} ORDER BY sequence`;
  let position = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = chunks[position++];
      if (!chunk) { controller.close(); return; }
      controller.enqueue(await artifacts.read(chunk.digest));
    },
  });
}
