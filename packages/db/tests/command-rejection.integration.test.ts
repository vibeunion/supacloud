import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
  createExternalCommand,
  createCommandRecoveryHandler,
  plaintextCommandInput,
  type CommandWorkflowPort,
} from "../../commands/src/index";
import {
  createPostgresCommandStore,
  type CommandDatabase,
} from "../src/command-adapter";
import { createBunCommandDatabase } from "../src/command-bun";
import {
  COMMAND_PERSISTENCE_SQL,
  COMMAND_PERSISTENCE_UPGRADE_SQL,
} from "../src/command-schema";

const connection = process.env["SUPACLOUD_COMMAND_TEST_URL"];
if (!connection && process.env["REQUIRE_COMMAND_REJECTION_INTEGRATION"] === "1") {
  throw new Error("SUPACLOUD_COMMAND_TEST_URL is required");
}
const suite = connection ? describe.serial : describe.skip;

const identity = { tenantId: "tenant-rejection", actorId: "actor-rejection" };
const input = { id: "target-rejection", enabled: true };
let sql: SQL;

// 历史版本表定义：保留匿名 CHECK，验证 PostgreSQL 实际生成的约束名。
const oldPersistenceSql = `
CREATE SCHEMA IF NOT EXISTS supacloud_commands;
CREATE TABLE supacloud_commands.execution_receipts (
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  command text NOT NULL,
  operation_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('transactional', 'external')),
  input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
  input_payload text,
  dispatch_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'unknown', 'confirmed')),
  audit_state text NOT NULL CHECK (audit_state IN ('pending', 'complete')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_id, command, operation_key),
  CHECK ((status = 'confirmed') = (result IS NOT NULL)),
  CHECK (audit_state <> 'complete' OR status = 'confirmed'),
  CHECK (kind <> 'transactional' OR (status = 'confirmed' AND audit_state = 'complete'))
);
CREATE TABLE supacloud_commands.execution_audit (
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  command text NOT NULL,
  operation_key text NOT NULL,
  event text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_id, command, operation_key),
  FOREIGN KEY (tenant_id, actor_id, command, operation_key)
    REFERENCES supacloud_commands.execution_receipts (tenant_id, actor_id, command, operation_key)
);
`;

async function rows(text: string, parameters: readonly (string | number | boolean | null)[] = []) {
  const result: unknown = await sql.unsafe<unknown>(text, [...parameters]);
  if (!Array.isArray(result)) throw new Error("Expected PostgreSQL rows");
  return result;
}

function rejectionCommand(options: {
  auditFailure?: boolean;
  database?: CommandDatabase;
  name?: string;
  send?: () => Promise<void>;
  lookup?: () => Promise<unknown>;
} = {}) {
  const store = createPostgresCommandStore(options.database ?? createBunCommandDatabase(sql));
  return createExternalCommand({
    store,
    inputCodec: plaintextCommandInput,
    name: options.name ?? "rejection.integration.v1",
    input: (value: unknown) => {
      if (!value || typeof value !== "object" || !("id" in value)
        || typeof value.id !== "string" || !("enabled" in value)
        || typeof value.enabled !== "boolean") throw new Error("Invalid input");
      return { id: value.id, enabled: value.enabled };
    },
    result: (value: unknown) => {
      if (!value || typeof value !== "object" || !("id" in value)
        || typeof value.id !== "string" || !("enabled" in value)
        || typeof value.enabled !== "boolean") throw new Error("Invalid result");
      return { id: value.id, enabled: value.enabled };
    },
    authorize: () => "allow",
    authorizeRecovery: () => "allow",
    send: async () => {
      if (options.send) await options.send();
      throw new Error("remote write definitively rejected");
    },
    lookup: options.lookup ?? (async () => null),
    matches: () => false,
    audit: { event: "rejection.unexpected.success", details: () => ({}) },
    rejection: {
      isDefinitiveWriteFailure: () => true,
      audit: {
        event: "rejection.recorded",
        details: (value: { id: string }) => ({ target: value.id, reason: "remote-rejected" }),
        write: async () => {
          if (options.auditFailure) throw new Error("audit unavailable");
        },
      },
    },
  });
}

async function workflowRpc(
  name: "claim" | "get" | "complete" | "retry" | "fail",
  request: object,
): Promise<unknown> {
  const functionName = name === "get" ? "supacloud_command_get" : `supacloud_workflow_${name}`;
  const result = await rows(`SELECT public.${functionName}($1::text::jsonb) AS result`, [JSON.stringify(request)]);
  const row: unknown = result[0];
  if (!row || typeof row !== "object" || !("result" in row)) throw new Error("Invalid workflow response");
  return row.result;
}

suite("command rejection PostgreSQL integration", () => {
  beforeAll(async () => {
    if (!connection) throw new Error("SUPACLOUD_COMMAND_TEST_URL is required");
    const url = new URL(connection);
    if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["127.0.0.1", "localhost"].includes(url.hostname)
      || url.pathname !== "/supacloud_commands_test" || url.search !== "" || url.hash !== "") {
      throw new Error("Command integration tests require the dedicated loopback database");
    }
    // 本套件会清理 persistence 表并调整队列可见性，数据库必须由本套件独占。
    sql = new SQL(connection);
    expect(await rows("SELECT current_database() AS name")).toEqual([{ name: "supacloud_commands_test" }]);
    await sql.unsafe(COMMAND_PERSISTENCE_SQL);
  });

  afterAll(async () => {
    await sql?.close();
  });

  test("durable rejection survives executor recreation with exactly one audit", async () => {
    let sends = 0, lookups = 0;
    const options = {
      send: async () => { sends++; },
      lookup: async () => { lookups++; return null; },
    };
    const command = rejectionCommand(options);
    const receipt = await command.execute(identity, crypto.randomUUID(), input);
    expect(receipt).toMatchObject({ status: "rejected", audit: "complete" });
    expect("result" in receipt).toBe(false);
    expect(await rejectionCommand(options).execute(identity, receipt.operationId, input)).toEqual(receipt);
    expect(await command.lookupByReference(identity, receipt.operationId)).toEqual(receipt);
    expect(await command.reconcile(identity, receipt.operationId, input)).toEqual(receipt);
    expect([sends, lookups]).toEqual([1, 0]);
    const audit = await rows(
      "SELECT event, details FROM supacloud_commands.execution_audit WHERE operation_key=$1",
      [receipt.operationId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toEqual({
      event: "rejection.recorded",
      details: { reason: "remote-rejected", target: input.id },
    });
  });

  test("audit failure rolls back rejection but preserves the committed pending intent", async () => {
    const command = rejectionCommand({ auditFailure: true });
    const operationId = crypto.randomUUID();
    await expect(command.execute(identity, operationId, input))
      .rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    expect(await rows(
      "SELECT status,audit_state FROM supacloud_commands.execution_receipts WHERE operation_key=$1",
      [operationId],
    )).toEqual([{ status: "pending", audit_state: "pending" }]);
    expect(await rows(
      "SELECT 1 FROM supacloud_commands.execution_audit WHERE operation_key=$1",
      [operationId],
    )).toHaveLength(0);
  });

  test("already queued recovery completes with rejected output without redispatch", async () => {
    let sends = 0, lookups = 0;
    const command = rejectionCommand({
      send: async () => { sends++; },
      lookup: async () => { lookups++; return null; },
    });
    const receipt = await command.execute(identity, crypto.randomUUID(), input);
    const commandId = receipt.dispatchKey;
    // 只在专用数据库内调整可见性，避免历史队列消息抢占本次 claim。
    await sql.unsafe(`SELECT pgmq.set_vt('supacloud_internal_workflows',queue_message_id,
      CASE WHEN run_id=$1::uuid THEN 0 ELSE 3600 END) FROM supacloud_workflows.steps
      WHERE status IN ('queued','running')`, [commandId]);
    const claim = await workflowRpc("claim", {
      workerId: "worker-rejection",
      visibilityTimeoutSeconds: 60,
    });
    expect(claim).toMatchObject({ runId: commandId, stepKey: "reconcile" });
    const workflows: CommandWorkflowPort = {
      complete: (request) => workflowRpc("complete", request),
      retry: (request) => workflowRpc("retry", request),
      fail: (request) => workflowRpc("fail", request),
    };
    const handler = createCommandRecoveryHandler({
      workflows, tenantId: identity.tenantId, principal: { subject: "worker-rejection" },
      authorize: () => "allow", commands: { "rejection.integration.v1": command }, retryDelaySeconds: 0,
    });
    expect(await handler.run(claim)).toBe("completed");
    expect(await rows(
      "SELECT status FROM supacloud_workflows.runs WHERE id=$1::uuid",
      [commandId],
    )).toEqual([{ status: "completed" }]);
    expect(await rows(
      "SELECT status,step_key FROM supacloud_workflows.steps WHERE run_id=$1::uuid ORDER BY step_key",
      [commandId],
    )).toEqual([{ status: "completed", step_key: "reconcile" }]);
    expect(await workflowRpc("get", { commandId })).toMatchObject({
      execution: { status: "rejected", audit: "complete" }, workflow: { status: "completed" },
    });
    expect([sends, lookups]).toEqual([1, 0]);
  });

  test("old writers cannot change confirmed or rejected terminal receipts", async () => {
    const command = rejectionCommand();
    const rejected = await command.execute(identity, crypto.randomUUID(), input);
    const confirmedId = crypto.randomUUID();
    await sql.unsafe(
      `INSERT INTO supacloud_commands.execution_receipts
       (tenant_id,actor_id,command,operation_key,kind,input_fingerprint,input_payload,status,audit_state,result)
       VALUES ($1,$2,$3,$4,'external',$5,$6,'confirmed','complete',$7::jsonb)`,
      [identity.tenantId, identity.actorId, "rejection.integration.v1", confirmedId,
        "a".repeat(64), JSON.stringify(input), JSON.stringify(input)],
    );
    for (const operationId of [rejected.operationId, confirmedId]) {
      for (const assignment of [
        "status='unknown',result=NULL,audit_state='pending'",
        "status='confirmed',result='{\"id\":\"overwrite\",\"enabled\":false}'::jsonb",
        "audit_state='pending'",
      ]) {
        await expect(rows(
          `UPDATE supacloud_commands.execution_receipts SET ${assignment} WHERE operation_key=$1`,
          [operationId],
        )).rejects.toThrow("SUPACLOUD_COMMAND_TERMINAL_RECEIPT");
      }
    }
  });

  test("rejected terminal receipts remain recoverable after redaction", async () => {
    const name = `retention.${crypto.randomUUID()}`;
    const command = rejectionCommand({ name });
    const operationId = crypto.randomUUID();
    const receipt = await command.execute(identity, operationId, input);
    const pendingId = crypto.randomUUID();
    await expect(rejectionCommand({ name, auditFailure: true }).execute(identity, pendingId, input))
      .rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    const store = createPostgresCommandStore(createBunCommandDatabase(sql));
    expect(await store.redactCompleted({
      tenantId: identity.tenantId,
      commands: [name],
      before: Date.now() + 1_000,
      limit: 10,
    })).toBe(1);
    await expect(command.lookupByReference(identity, operationId))
      .rejects.toMatchObject({ code: "COMMAND_INPUT_EXPIRED" });
    expect(await command.recover(
      { subject: "worker-rejection" },
      { ...identity, command: name, operationId },
    )).toEqual(receipt);
    expect(await rows(
      "SELECT input_payload FROM supacloud_commands.execution_receipts WHERE operation_key=$1",
      [operationId],
    )).toEqual([{ input_payload: null }]);
    expect(await rows("SELECT input_payload IS NOT NULL AS retained FROM supacloud_commands.execution_receipts WHERE operation_key=$1",
      [pendingId])).toEqual([{ retained: true }]);
    expect(await rows("SELECT count(*)::integer AS count FROM supacloud_commands.execution_audit WHERE operation_key=$1",
      [operationId])).toEqual([{ count: 1 }]);
    expect(await command.execute(identity, operationId, input)).toEqual(receipt);
    await expect(command.execute(identity, operationId, { ...input, enabled: false }))
      .rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_CONFLICT" });
  });

  test("missing rejection audit fails at COMMIT and rolls the state back", async () => {
    const operationId = crypto.randomUUID();
    await expect(sql.begin(async (tx) => {
      await tx.unsafe(`INSERT INTO supacloud_commands.execution_receipts
        (tenant_id,actor_id,command,operation_key,kind,input_fingerprint,status,audit_state)
        VALUES ($1,$2,'commit.rejection',$3,'external',$4,'rejected','complete')`,
      [identity.tenantId, identity.actorId, operationId, "b".repeat(64)]);
      const visible: unknown = await tx.unsafe<unknown>(
        "SELECT status FROM supacloud_commands.execution_receipts WHERE operation_key=$1", [operationId]);
      expect(visible).toEqual([{ status: "rejected" }]);
    })).rejects.toThrow("SUPACLOUD_COMMAND_REJECTION_AUDIT_REQUIRED");
    expect(await rows("SELECT 1 FROM supacloud_commands.execution_receipts WHERE operation_key=$1", [operationId]))
      .toHaveLength(0);
  });

  test("failure before rejection COMMIT rolls back both inserted audit and rejection", async () => {
    const database = createBunCommandDatabase(sql);
    const name = `commit.abort.${crypto.randomUUID()}`;
    const failing: CommandDatabase = {
      transaction: (run) => database.transaction(async (tx) => {
        const value = await run(tx);
        const audit: unknown = await tx.query(
          "SELECT 1 FROM supacloud_commands.execution_audit WHERE command=$1", [name]);
        if (Array.isArray(audit) && audit.length > 0) throw new Error("Commit aborted");
        return value;
      }),
    };
    const operationId = crypto.randomUUID();
    await expect(rejectionCommand({ name, database: failing }).execute(identity, operationId, input))
      .rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    expect(await rows("SELECT status,audit_state FROM supacloud_commands.execution_receipts WHERE operation_key=$1",
      [operationId])).toEqual([{ status: "pending", audit_state: "pending" }]);
    expect(await rows("SELECT 1 FROM supacloud_commands.execution_audit WHERE operation_key=$1", [operationId]))
      .toHaveLength(0);
  });

  test("lost rejection COMMIT acknowledgement recovers the committed rejection without resending", async () => {
    const database = createBunCommandDatabase(sql);
    let commits = 0, sends = 0;
    const name = `commit.lost.${crypto.randomUUID()}`;
    const command = rejectionCommand({
      name, send: async () => { sends++; },
      database: { transaction: async (run) => {
        const result = await database.transaction(run);
        if (++commits === 2) throw new Error("COMMIT acknowledgement lost");
        return result;
      } },
    });
    const operationId = crypto.randomUUID();
    await expect(command.execute(identity, operationId, input))
      .rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    const recreated = rejectionCommand({ name, send: async () => { sends++; } });
    expect(await recreated.execute(identity, operationId, input)).toMatchObject({ status: "rejected", audit: "complete" });
    expect(await rows("SELECT count(*)::integer AS count FROM supacloud_commands.execution_audit WHERE operation_key=$1",
      [operationId])).toEqual([{ count: 1 }]);
    expect(sends).toBe(1);
  });

  test("fresh persistence tables accept audited rejection without enqueuing recovery", async () => {
    const rollback = new Error("Rollback fresh fixture");
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("DROP TABLE supacloud_commands.execution_audit");
        await tx.unsafe("DROP TABLE supacloud_commands.execution_receipts");
        await tx.unsafe(COMMAND_PERSISTENCE_SQL);
        const operationId = crypto.randomUUID(), dispatchKey = crypto.randomUUID();
        await tx.unsafe(`INSERT INTO supacloud_commands.execution_receipts
          (tenant_id,actor_id,command,operation_key,dispatch_key,kind,input_fingerprint,status,audit_state)
          VALUES ($1,$2,'fresh.rejection',$3,$4::uuid,'external',$5,'rejected','complete')`,
        [identity.tenantId, identity.actorId, operationId, dispatchKey, "d".repeat(64)]);
        await tx.unsafe(`INSERT INTO supacloud_commands.execution_audit
          (tenant_id,actor_id,command,operation_key,event,details)
          VALUES ($1,$2,'fresh.rejection',$3,'fresh.rejected','{}')`,
        [identity.tenantId, identity.actorId, operationId]);
        await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
        const queue: unknown = await tx.unsafe<unknown>("SELECT id FROM supacloud_workflows.runs WHERE id=$1::uuid", [dispatchKey]);
        expect(queue).toEqual([]);
        const stored: unknown = await tx.unsafe<unknown>("SELECT status,audit_state FROM supacloud_commands.execution_receipts");
        expect(stored).toEqual([{ status: "rejected", audit_state: "complete" }]);
        throw rollback;
      });
      throw new Error("Fresh fixture was not rolled back");
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });

  test("exact historical unnamed checks survive upgrade and repeated upgrade safely", async () => {
    const rollback = new Error("Rollback historical fixture");
    // 表替换与迁移全部回滚，不删除本轮或其他执行器的持久化证据。
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("DROP TABLE supacloud_commands.execution_audit");
        await tx.unsafe("DROP TABLE supacloud_commands.execution_receipts");
        await tx.unsafe(oldPersistenceSql);
        const constraints: unknown = await tx.unsafe<unknown>(`SELECT conname FROM pg_constraint
          WHERE conrelid='supacloud_commands.execution_receipts'::regclass
          AND conname IN ('execution_receipts_status_check','execution_receipts_check',
            'execution_receipts_check1','execution_receipts_check2') ORDER BY conname`);
        expect(constraints).toEqual([
          { conname: "execution_receipts_check" }, { conname: "execution_receipts_check1" },
          { conname: "execution_receipts_check2" }, { conname: "execution_receipts_status_check" },
        ]);
        const operationId = crypto.randomUUID();
        await tx.unsafe(`INSERT INTO supacloud_commands.execution_receipts
          (tenant_id,actor_id,command,operation_key,kind,input_fingerprint,input_payload,status,audit_state)
          VALUES ($1,$2,'historical.rejection',$3,'external',$4,$5,'unknown','pending')`,
        [identity.tenantId, identity.actorId, operationId, "c".repeat(64), JSON.stringify(input)]);
        await tx.unsafe(COMMAND_PERSISTENCE_UPGRADE_SQL);
        await tx.unsafe(COMMAND_PERSISTENCE_UPGRADE_SQL);
        await tx.unsafe(`INSERT INTO supacloud_commands.execution_audit
          (tenant_id,actor_id,command,operation_key,event,details)
          VALUES ($1,$2,'historical.rejection',$3,'historical.rejected','{}')`,
        [identity.tenantId, identity.actorId, operationId]);
        await tx.unsafe(`UPDATE supacloud_commands.execution_receipts
          SET status='rejected',audit_state='complete' WHERE operation_key=$1`, [operationId]);
        await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
        const preserved: unknown = await tx.unsafe<unknown>(`SELECT operation_key,input_fingerprint,input_payload,status,audit_state
          FROM supacloud_commands.execution_receipts WHERE operation_key=$1`, [operationId]);
        expect(preserved).toEqual([{
          operation_key: operationId, input_fingerprint: "c".repeat(64), input_payload: JSON.stringify(input),
          status: "rejected", audit_state: "complete",
        }]);
        const recovery: unknown = await tx.unsafe<unknown>(`SELECT count(*)::integer AS count
          FROM supacloud_workflows.steps s JOIN supacloud_commands.execution_receipts r ON r.dispatch_key=s.run_id
          WHERE r.operation_key=$1`, [operationId]);
        expect(recovery).toEqual([{ count: 1 }]);
        throw rollback;
      });
      throw new Error("Historical fixture was not rolled back");
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });
});
