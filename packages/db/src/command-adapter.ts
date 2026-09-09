import {
  CommandError, canonicalCommandJson, commandIdentifier, decodeCommandJson, decodeDurableCommandReceipt,
} from "@supacloud/contracts";
import type {
  CommandStore, CommandStoreSession, StoredCommand, OperationReference,
  CommandRecoveryStore, RecoveryClaim, RecoveryScope,
} from "@supacloud/contracts";

export interface CommandTransaction {
  query(sql: string, parameters?: readonly (string | number | boolean | null)[]): Promise<unknown>;
}
export interface CommandDatabase {
  transaction<T>(run: (transaction: CommandTransaction) => Promise<T>): Promise<T>;
}
const where = "tenant_id=$1 AND actor_id=$2 AND command=$3 AND operation_key=$4";
const keys = (ref: OperationReference) => [ref.tenantId, ref.actorId, ref.command, ref.operationId].map(commandIdentifier);
function rows(value: unknown): Record<string, unknown>[] {
  const isRow = (row: unknown): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row);
  if (!Array.isArray(value) || !Array.from(value).every(isRow)) throw new CommandError("COMMAND_RECEIPT_INVALID");
  return value;
}
function decodeStored(row: Record<string, unknown>): StoredCommand {
  try {
    const fingerprint = row["input_fingerprint"], payload = row["input_payload"], kind = row["kind"];
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)
      || (payload !== null && typeof payload !== "string") || (kind !== "transactional" && kind !== "external")) throw new Error("Invalid record");
    const serialized = row["result_json"];
    if (serialized !== null && typeof serialized !== "string") throw new Error("Invalid stored JSON");
    const raw: unknown = typeof serialized === "string" ? JSON.parse(serialized) : undefined;
    const receipt = decodeDurableCommandReceipt({ ...row, ...(raw === undefined ? {} : { result: raw }) }, decodeCommandJson);
    return { receipt, kind, inputFingerprint: fingerprint, inputPayload: payload };
  } catch { throw new CommandError("COMMAND_RECEIPT_INVALID"); }
}
const projection = `tenant_id AS "tenantId", actor_id AS "actorId", command,
  operation_key AS "operationId", dispatch_key::text AS "dispatchKey",
  status, audit_state AS audit, result::text AS result_json, input_fingerprint,input_payload,kind`;

/** PostgreSQL only: no remote sending, domain matching or recovery policy lives here. */
export function createPostgresCommandStore(database: CommandDatabase): CommandStore<CommandTransaction> & CommandRecoveryStore {
  const transaction = async <T>(run: (tx: CommandTransaction) => Promise<T>): Promise<T> => {
    let started = false;
    try {
      return await database.transaction((tx) => { started = true; return run(tx); });
    } catch (error) {
      if (error instanceof CommandError) throw error;
      throw new CommandError(started ? "COMMAND_OUTCOME_UNKNOWN" : "COMMAND_UNAVAILABLE");
    }
  };
  const session = (tx: CommandTransaction): CommandStoreSession<CommandTransaction> => ({
    transaction: tx,
    async lock(ref) { await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(keys(ref))]); },
    async read(ref) {
      const found = rows(await tx.query(`SELECT ${projection} FROM supacloud_commands.execution_receipts WHERE ${where}`, keys(ref)));
      if (found.length > 1) throw new CommandError("COMMAND_RECEIPT_INVALID");
      const row = found[0];
      return row === undefined ? null : decodeStored(row);
    },
    async insert(record) {
      const receipt = record.receipt;
      const result = receipt.status === "confirmed" ? canonicalCommandJson(receipt.result) : null;
      await tx.query(`INSERT INTO supacloud_commands.execution_receipts
        (tenant_id,actor_id,command,operation_key,dispatch_key,kind,input_fingerprint,input_payload,status,audit_state,result)
        VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8,$9,$10,$11::text::jsonb)`,
      [...keys(receipt), receipt.dispatchKey, record.kind, record.inputFingerprint, record.inputPayload, receipt.status, receipt.audit, result]);
    },
    async confirm(ref, result) {
      await tx.query(`UPDATE supacloud_commands.execution_receipts SET status='confirmed',result=$5::text::jsonb,updated_at=now()
        WHERE ${where} AND status<>'confirmed'`, [...keys(ref), canonicalCommandJson(result)]);
    },
    async markUnknown(ref) {
      await tx.query(`UPDATE supacloud_commands.execution_receipts SET status='unknown',updated_at=now()
        WHERE ${where} AND status<>'confirmed'`, keys(ref));
    },
    async audit(ref, event, details) {
      await tx.query(`INSERT INTO supacloud_commands.execution_audit
        (tenant_id,actor_id,command,operation_key,event,details) VALUES ($1,$2,$3,$4,$5,$6::text::jsonb)`,
      [...keys(ref), commandIdentifier(event), canonicalCommandJson(details)]);
    },
    async completeAudit(ref) {
      await tx.query(`UPDATE supacloud_commands.execution_receipts SET audit_state='complete',updated_at=now() WHERE ${where}`, keys(ref));
    },
  });
  const scopeKeys = (scope: RecoveryScope) => {
    if (scope.commands.length === 0) throw new CommandError("COMMAND_INPUT_INVALID");
    return [commandIdentifier(scope.tenantId), JSON.stringify(scope.commands.map(commandIdentifier))];
  };
  const integer = (value: number, min: number, max = Number.MAX_SAFE_INTEGER) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new CommandError("COMMAND_INPUT_INVALID");
    return value;
  };
  const selected = `tenant_id=$1 AND command IN (SELECT jsonb_array_elements_text($2::text::jsonb))`;
  const join = `r.tenant_id=c.tenant_id AND r.actor_id=c.actor_id AND r.command=c.command AND r.operation_key=c.operation_key`;
  return {
    transaction: (run) => transaction((tx) => run(session(tx))),
    async claim(options) {
      const found = await transaction(async (tx) => rows(await tx.query(`WITH candidates AS (
        SELECT tenant_id,actor_id,command,operation_key FROM supacloud_commands.execution_receipts
        WHERE ${selected} AND (status<>'confirmed' OR audit_state<>'complete')
          AND next_attempt_at<=to_timestamp($3::double precision/1000)
          AND (lease_until IS NULL OR lease_until<=to_timestamp($3::double precision/1000))
        ORDER BY created_at,actor_id,operation_key LIMIT $4 FOR UPDATE SKIP LOCKED
      ) UPDATE supacloud_commands.execution_receipts r
        SET lease_id=gen_random_uuid(),lease_until=to_timestamp(($3::double precision+$5)/1000),recovery_attempts=recovery_attempts+1
        FROM candidates c WHERE ${join}
        RETURNING r.tenant_id AS "tenantId",r.actor_id AS "actorId",r.command,r.operation_key AS "operationId",
          r.lease_id::text AS "leaseId",extract(epoch from r.created_at)::double precision*1000 AS "createdAt",
          r.recovery_attempts AS attempts`,
      [...scopeKeys(options), integer(options.now, 0), integer(options.limit, 1, 1000), integer(options.leaseMs, 1)])));
      return found.map((row): RecoveryClaim => {
        const createdAt = row["createdAt"], attempts = row["attempts"];
        if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || typeof attempts !== "number" || !Number.isSafeInteger(attempts)) {
          throw new CommandError("COMMAND_RECEIPT_INVALID");
        }
        return {
          tenantId: commandIdentifier(row["tenantId"]), actorId: commandIdentifier(row["actorId"]),
          command: commandIdentifier(row["command"]), operationId: commandIdentifier(row["operationId"]),
          leaseId: commandIdentifier(row["leaseId"]), createdAt, attempts,
        };
      });
    },
    async release(claim, nextAttemptAt) {
      await transaction(async (tx) => {
        await tx.query(`UPDATE supacloud_commands.execution_receipts SET lease_id=NULL,lease_until=NULL,
          next_attempt_at=to_timestamp($6::double precision/1000) WHERE ${where} AND lease_id=$5::uuid`,
        [...keys(claim), commandIdentifier(claim.leaseId), integer(nextAttemptAt, 0)]);
      });
    },
    async redactCompleted(options) {
      return transaction(async (tx) => rows(await tx.query(`WITH candidates AS (
        SELECT tenant_id,actor_id,command,operation_key FROM supacloud_commands.execution_receipts
        WHERE ${selected} AND status='confirmed' AND audit_state='complete' AND input_payload IS NOT NULL
          AND updated_at<to_timestamp($3::double precision/1000)
          AND (lease_id IS NULL OR lease_until<to_timestamp($3::double precision/1000))
        ORDER BY updated_at LIMIT $4 FOR UPDATE SKIP LOCKED
      ) UPDATE supacloud_commands.execution_receipts r SET input_payload=NULL FROM candidates c
        WHERE ${join} RETURNING r.operation_key`,
      [...scopeKeys(options), integer(options.before, 0), integer(options.limit, 1, 1000)])).length);
    },
  };
}
