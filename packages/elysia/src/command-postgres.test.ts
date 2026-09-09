import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createBunCommandDatabase } from "@supacloud/db/bun";
import { COMMAND_PERSISTENCE_SQL, COMMAND_PERSISTENCE_UPGRADE_SQL } from "@supacloud/db";
import { createTransactionalCommand, createExternalCommand, createCommandRecoveryHandler, plaintextCommandInput, type CommandWorkflowPort } from "@supacloud/commands";
import { decodeCommandStatus } from "@supacloud/contracts";
import { createPostgresCommandStore, type CommandTransaction, type CommandSubmissionBinding } from "@supacloud/db";

const connection = process.env["SUPACLOUD_COMMAND_TEST_URL"];
const suite = connection ? describe : describe.skip;
const identity = { tenantId: "tenant-a", actorId: "actor-a" };

function decodeInput(value: unknown): { id: string; enabled: boolean } {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string"
    || !("enabled" in value) || typeof value.enabled !== "boolean") throw new Error("Invalid input");
  return { id: value.id, enabled: value.enabled };
}
const decodeResult = decodeInput;

suite("native PostgreSQL durable command boundaries", () => {
  let sql: SQL;
  beforeAll(async () => {
    if (!connection) throw new Error("Missing dedicated command test database");
    const url = new URL(connection);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/supacloud_commands_test") {
      throw new Error("Command integration tests require an isolated local test database");
    }
    sql = new SQL(connection);
    await sql.unsafe(COMMAND_PERSISTENCE_SQL);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS public.command_test_webhooks
      (id text PRIMARY KEY, enabled boolean NOT NULL, writes integer NOT NULL DEFAULT 0)`);
  });
  afterAll(async () => { await sql?.close(); });

  async function fixture() {
    const id = crypto.randomUUID();
    await sql.unsafe("INSERT INTO public.command_test_webhooks(id,enabled) VALUES($1,false)", [id]);
    return { id, enabled: true };
  }

  async function writes(id: string): Promise<number> {
    const raw: unknown = await sql.unsafe<unknown>("SELECT writes FROM public.command_test_webhooks WHERE id=$1", [id]);
    if (!Array.isArray(raw)) throw new Error("Invalid rows");
    const row: unknown = raw[0];
    if (!row || typeof row !== "object" || !("writes" in row) || typeof row.writes !== "number") throw new Error("Invalid row");
    return row.writes;
  }

  const update = async (tx: CommandTransaction, input: ReturnType<typeof decodeInput>) => {
    await tx.query("UPDATE public.command_test_webhooks SET enabled=$2,writes=writes+1 WHERE id=$1", [input.id, input.enabled]);
    return input;
  };
  function transactionCommand(options: { denied?: () => boolean; audit?: () => Promise<void> } = {}) {
    return createTransactionalCommand({
      store: createPostgresCommandStore(createBunCommandDatabase(sql)), inputCodec: plaintextCommandInput, name: "webhook.update.v1",
      input: decodeInput, result: decodeResult,
      authorize: () => options.denied?.() ? "deny" : "allow",
      execute: update,
      audit: { event: "webhook.updated", details: (input) => ({ target: input.id }), write: async () => { await options.audit?.(); } },
    });
  }

  test("concurrent duplicate requests commit one write and one audit, and survive executor recreation", async () => {
    const input = await fixture(), key = crypto.randomUUID();
    const command = transactionCommand();
    const receipts = await Promise.all(Array.from({ length: 8 }, () => command.execute(identity, key, input)));
    expect(receipts.every((item) => item.status === "confirmed" && item.audit === "complete")).toBe(true);
    expect(await writes(input.id)).toBe(1);
    const receipt = receipts[0];
    if (receipt === undefined) throw new Error("Missing receipt");
    expect(await transactionCommand().lookup(identity, key, input)).toEqual(receipt);
    expect(await transactionCommand().lookupByReference(identity, key)).toEqual(receipt);
    const audit: unknown = await sql.unsafe<unknown>(
      "SELECT count(*)::integer AS count FROM supacloud_commands.execution_audit WHERE operation_key=$1", [key]);
    if (!Array.isArray(audit)) throw new Error("Invalid audit rows");
    const count: unknown = audit[0];
    expect(count).toEqual({ count: 1 });
    expect(audit.length).toBe(1);
  });

  test("audit failure rolls back the business write and receipt", async () => {
    const input = await fixture(), key = crypto.randomUUID();
    const command = transactionCommand({ audit: async () => { throw new Error("Audit unavailable"); } });
    await expect(command.execute(identity, key, input)).rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    expect(await writes(input.id)).toBe(0);
    expect(await command.lookup(identity, key, input)).toBeNull();
  });

  test("invalid result rolls back and invalid input never enters the handler", async () => {
    const input = await fixture(), key = crypto.randomUUID();
    const command = createTransactionalCommand({
      store: createPostgresCommandStore(createBunCommandDatabase(sql)), inputCodec: plaintextCommandInput,
      name: "invalid.result.v1", input: decodeInput, result: decodeResult,
      authorize: () => "allow", execute: async (tx, value) => { await update(tx, value); return { secret: "invalid" }; },
      audit: { event: "changed", details: () => ({}) },
    });
    await expect(command.execute(identity, key, null)).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    await expect(command.execute(identity, key, input)).rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    expect(await writes(input.id)).toBe(0);
  });

  test("input conflicts and revoked authorization never replay cached receipts", async () => {
    const input = await fixture(), key = crypto.randomUUID();
    let denied = false;
    const command = transactionCommand({ denied: () => denied });
    await command.execute(identity, key, input);
    await expect(command.execute(identity, key, { ...input, enabled: false }))
      .rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_CONFLICT" });
    denied = true;
    await expect(command.execute(identity, key, input)).rejects.toMatchObject({ code: "COMMAND_REJECTED" });
    await expect(command.lookup(identity, key, input)).rejects.toMatchObject({ code: "COMMAND_REJECTED" });
    await expect(command.lookupByReference(identity, key)).rejects.toMatchObject({ code: "COMMAND_REJECTED" });
    expect(await writes(input.id)).toBe(1);
  });

  test("keys are scoped to actor and tenant, and receipt lookup cannot cross either", async () => {
    const input = await fixture(), key = crypto.randomUUID(), command = transactionCommand();
    const receipt = await command.execute(identity, key, input);
    expect(await command.lookup({ ...identity, actorId: "other" }, key, input)).toBeNull();
    expect(await command.lookup({ ...identity, tenantId: "other" }, key, input)).toBeNull();
    expect(await command.lookupByReference({ ...identity, tenantId: "other" }, key)).toBeNull();
    const next = await command.execute({ ...identity, actorId: "other" }, key, input);
    expect(next.dispatchKey).not.toBe(receipt.dispatchKey);
    expect(await writes(input.id)).toBe(2);
  });

  test("lost COMMIT acknowledgement recovers from the same durable receipt without repeating the write", async () => {
    const database = createBunCommandDatabase(sql);
    let lose = true;
    const command = createTransactionalCommand({
      store: createPostgresCommandStore({ transaction: async (run) => {
        const value = await database.transaction(run);
        if (lose) { lose = false; throw new Error("Commit response lost"); }
        return value;
      } }), inputCodec: plaintextCommandInput,
      name: "lost.commit.v1", input: decodeInput, result: decodeResult, authorize: () => "allow", execute: update,
      audit: { event: "changed", details: () => ({}) },
    });
    const input = await fixture(), key = crypto.randomUUID();
    await expect(command.execute(identity, key, input)).rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    expect((await command.execute(identity, key, input)).status).toBe("confirmed");
    expect(await writes(input.id)).toBe(1);
  });

  test("remote success with audit failure remains confirmed and audit recovery never resends", async () => {
    const input = await fixture(), key = crypto.randomUUID();
    let sends = 0, audits = 0, failAudit = true;
    const command = createExternalCommand({
      store: createPostgresCommandStore(createBunCommandDatabase(sql)), inputCodec: plaintextCommandInput,
      name: "remote.update.v1", input: decodeInput, result: decodeResult,
      authorize: () => "allow",
      send: async (_input, dispatch) => { sends++; expect(dispatch.idempotencyKey).not.toBe(key); throw new Error("401 after effect"); },
      lookup: async () => input, matches: (request, state) => request.id === state.id && request.enabled === state.enabled,
      audit: { event: "changed", details: () => ({}), write: async () => {
        if (failAudit) throw new Error("Audit unavailable"); audits++;
      } },
    });
    expect(await command.execute(identity, key, input)).toMatchObject({ status: "confirmed", audit: "pending" });
    expect(await command.execute(identity, key, input)).toMatchObject({ status: "confirmed", audit: "pending" });
    failAudit = false;
    expect(await command.reconcileByReference(identity, key)).toMatchObject({ status: "confirmed", audit: "complete" });
    expect(await command.flushAuditByReference(identity, key)).toMatchObject({ status: "confirmed", audit: "complete" });
    expect([sends, audits]).toEqual([1, 1]);
  });

  test("unknown remote outcomes and missing lookups never permit automatic redispatch", async () => {
    let sends = 0;
    const command = createExternalCommand({
      store: createPostgresCommandStore(createBunCommandDatabase(sql)), inputCodec: plaintextCommandInput,
      name: "remote.unknown.v1", input: decodeInput, result: decodeResult,
      authorize: () => "allow", send: async () => { sends++; throw new Error("Lost"); },
      lookup: async () => null, matches: () => true, audit: { event: "changed", details: () => ({}) },
    });
    const input = await fixture(), key = crypto.randomUUID();
    expect(await command.execute(identity, key, input)).toMatchObject({ status: "unknown", audit: "pending" });
    expect(await command.reconcile(identity, key, input)).toMatchObject({ status: "unknown" });
    expect(await command.execute(identity, key, input)).toMatchObject({ status: "unknown" });
    expect(sends).toBe(1);
  });

  test("authorization failure after remote send is unknown, never a definitive rejection", async () => {
    let deny = false;
    const command = createExternalCommand({
      store: createPostgresCommandStore(createBunCommandDatabase(sql)), inputCodec: plaintextCommandInput,
      name: "remote.revoked.v1", input: decodeInput, result: decodeResult,
      authorize: () => deny ? "deny" : "allow",
      send: async () => { deny = true; }, lookup: async (input) => input,
      matches: () => true, audit: { event: "changed", details: () => ({}) },
    });
    const input = await fixture(), key = crypto.randomUUID();
    await expect(command.execute(identity, key, input)).rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    deny = false;
    expect(await command.lookup(identity, key, input)).toMatchObject({ status: "pending" });
    expect(await command.reconcile(identity, key, input)).toMatchObject({ status: "confirmed" });
  });

  test("concurrent external calls see committed intent while only its owner sends", async () => {
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    let sends = 0;
    const command = createExternalCommand({
      store: createPostgresCommandStore(createBunCommandDatabase(sql)), inputCodec: plaintextCommandInput,
      name: "remote.concurrent.v1", input: decodeInput, result: decodeResult,
      authorize: () => "allow",
      send: async () => { sends++; started.resolve(); await finish.promise; },
      lookup: async (input) => input, matches: () => true,
      audit: { event: "changed", details: () => ({}) },
    });
    const input = await fixture(), key = crypto.randomUUID();
    const first = command.execute(identity, key, input);
    await started.promise;
    try {
      const duplicates = await Promise.all(Array.from({ length: 6 }, () => command.execute(identity, key, input)));
      expect(duplicates.every((receipt) => receipt.status === "pending")).toBe(true);
      expect(sends).toBe(1);
    } finally { finish.resolve(); }
    expect(await first).toMatchObject({ status: "confirmed", audit: "complete" });
  });

  test("crash after intent commit but before send cannot be recovered by an unsafe redispatch", async () => {
    const database = createBunCommandDatabase(sql);
    let lose = true, sends = 0;
    const command = createExternalCommand({
      store: createPostgresCommandStore({ transaction: async (run) => {
        const value = await database.transaction(run);
        if (lose) { lose = false; throw new Error("Process died after intent commit"); }
        return value;
      } }), inputCodec: plaintextCommandInput,
      name: "remote.intent.crash.v1", input: decodeInput, result: decodeResult, authorize: () => "allow",
      send: async () => { sends++; }, lookup: async () => null, matches: () => true,
      audit: { event: "changed", details: () => ({}) },
    });
    const input = await fixture(), key = crypto.randomUUID();
    await expect(command.execute(identity, key, input)).rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    expect(await command.execute(identity, key, input)).toMatchObject({ status: "pending" });
    expect(await command.reconcile(identity, key, input)).toMatchObject({ status: "unknown" });
    expect(sends).toBe(0);
  });

  async function rpc(name: "get" | "submit" | "claim" | "complete" | "retry" | "fail", request: object): Promise<unknown> {
    const fn = name === "get" || name === "submit" ? `supacloud_command_${name}` : `supacloud_workflow_${name}`;
    const rows: unknown = await sql.unsafe<unknown>(`SELECT public.${fn}($1::text::jsonb) AS result`, [JSON.stringify(request)]);
    if (!Array.isArray(rows)) throw new Error("Invalid RPC rows");
    const row: unknown = rows[0];
    if (!row || typeof row !== "object" || !("result" in row)) throw new Error("Invalid RPC result");
    return row.result;
  }
  const workflows: CommandWorkflowPort = {
    complete: (request) => rpc("complete", request),
    retry: (request) => rpc("retry", request),
    fail: (request) => rpc("fail", request),
  };
  async function selectRun(runId: string) {
    // Isolate delivery visibility inside this disposable test database only.
    await sql.unsafe(`SELECT pgmq.set_vt('supacloud_internal_workflows',queue_message_id,
      CASE WHEN run_id=$1::uuid THEN 0 ELSE 3600 END) FROM supacloud_workflows.steps
      WHERE status IN ('queued','running')`, [runId]);
  }
  function submissionBinding(raw: unknown): CommandSubmissionBinding {
    if (!raw || typeof raw !== "object" || !("runId" in raw) || typeof raw.runId !== "string"
      || !("stepId" in raw) || typeof raw.stepId !== "string"
      || !("messageId" in raw) || typeof raw.messageId !== "string"
      || !("workerId" in raw) || typeof raw.workerId !== "string"
      || !("attempt" in raw) || typeof raw.attempt !== "number") throw new Error("Invalid test claim");
    return { commandId: raw.runId, stepId: raw.stepId, messageId: raw.messageId, workerId: raw.workerId, attempt: raw.attempt };
  }
  test("submitted external execution reuses its command ID and advances the existing workflow to reconciliation", async () => {
    const commandId = crypto.randomUUID(), input = await fixture();
    const actor = { tenantId: crypto.randomUUID(), actorId: crypto.randomUUID() };
    const request = { commandId, commandType: "submitted.remote", targetType: "webhook", targetId: input.id, ...actor, payload: input };
    await rpc("submit", request);
    await selectRun(commandId);
    const submission = submissionBinding(await rpc("claim", { workerId: "worker", visibilityTimeoutSeconds: 60 }));
    const database = createBunCommandDatabase(sql);
    const store = createPostgresCommandStore(database, { submission });
    let sends = 0, ready = false;
    const definition = {
      inputCodec: plaintextCommandInput, name: "submitted.remote", input: decodeInput, result: decodeResult,
      authorize: (): "allow" => "allow", authorizeRecovery: (): "allow" => "allow",
      send: async () => { sends++; }, lookup: async (value: ReturnType<typeof decodeInput>) => ready ? value : null,
      matches: () => true, audit: { event: "changed", details: () => ({}) },
    };
    const command = createExternalCommand({ ...definition, store });
    await expect(command.execute({ ...actor, tenantId: "foreign" }, commandId, input)).rejects.toThrow();
    await expect(command.execute(actor, commandId, { ...input, enabled: false })).rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_CONFLICT" });
    expect(sends).toBe(0);
    const receipt = await command.execute(actor, commandId, input);
    expect(receipt).toMatchObject({ operationId: commandId, dispatchKey: commandId, status: "unknown" });
    expect(decodeCommandStatus(await rpc("submit", request))).toMatchObject({ kind: "execution", commandId, execution: { status: "unknown" } });
    ready = true;
    const handler = createCommandRecoveryHandler({
      workflows, tenantId: actor.tenantId, principal: { subject: "worker" }, authorize: () => "allow", retryDelaySeconds: 0,
      commands: { "submitted.remote": createExternalCommand({ ...definition, store: createPostgresCommandStore(database) }) },
    });
    const recovery = await rpc("claim", { workerId: "worker", visibilityTimeoutSeconds: 60 });
    expect(recovery).toMatchObject({ runId: commandId, stepKey: "reconcile" });
    expect(await handler.run(recovery)).toBe("completed");
    expect(decodeCommandStatus(await rpc("get", { commandId }))).toMatchObject({
      kind: "execution", commandId, execution: { status: "confirmed", audit: "complete" }, workflow: { status: "completed" },
    });
    expect(sends).toBe(1);
  });
  test("submitted database execution commits business, audit and workflow completion together", async () => {
    const commandId = crypto.randomUUID(), input = await fixture();
    const actor = { tenantId: crypto.randomUUID(), actorId: crypto.randomUUID() };
    await rpc("submit", { commandId, commandType: "submitted.db", targetType: "webhook", targetId: input.id, ...actor, payload: input });
    await selectRun(commandId);
    const submission = submissionBinding(await rpc("claim", { workerId: "worker", visibilityTimeoutSeconds: 60 }));
    let auditAvailable = false;
    const command = createTransactionalCommand({
      store: createPostgresCommandStore(createBunCommandDatabase(sql), { submission }),
      inputCodec: plaintextCommandInput, name: "submitted.db", input: decodeInput, result: decodeResult,
      authorize: () => "allow", execute: update,
      audit: { event: "changed", details: () => ({}), write: async () => { if (!auditAvailable) throw new Error("audit unavailable"); } },
    });
    await expect(command.execute(actor, commandId, input)).rejects.toThrow();
    expect(await writes(input.id)).toBe(0);
    expect(decodeCommandStatus(await rpc("get", { commandId }))).toMatchObject({ kind: "submission", workflow: { status: "running" } });
    auditAvailable = true;
    expect(await command.execute(actor, commandId, input)).toMatchObject({ dispatchKey: commandId, status: "confirmed" });
    expect(await command.execute(actor, commandId, input)).toMatchObject({ dispatchKey: commandId, status: "confirmed" });
    expect(await writes(input.id)).toBe(1);
    expect(decodeCommandStatus(await rpc("get", { commandId }))).toMatchObject({ kind: "execution", workflow: { status: "completed" } });
  });
  test("native Workflow recovery uses independent authorization and never dispatches again", async () => {
    const store = createPostgresCommandStore(createBunCommandDatabase(sql));
    const actor = { tenantId: crypto.randomUUID(), actorId: "original-actor" };
    let ready = false, allowed = true, sends = 0, recoveryAllowed = true;
    const command = createExternalCommand({
      store, inputCodec: plaintextCommandInput, name: "worker.test", input: decodeInput, result: decodeResult,
      authorize: () => allowed ? "allow" : "deny",
      authorizeRecovery: (principal, reference) =>
        recoveryAllowed && principal.subject === "worker" && reference.tenantId === actor.tenantId ? "allow" : "deny",
      send: async () => { sends++; }, lookup: async (input) => ready ? input : null, matches: () => true,
      audit: { event: "changed", details: () => ({}) },
    });
    const input = await fixture();
    const original = await command.execute(actor, "recover", input);
    await selectRun(original.dispatchKey);
    allowed = false; ready = true; recoveryAllowed = false;
    const handler = createCommandRecoveryHandler({
      workflows, tenantId: actor.tenantId, principal: { subject: "worker" }, authorize: () => "allow",
      commands: { "worker.test": command }, retryDelaySeconds: 0,
    });
    const first = await rpc("claim", { workerId: "worker", visibilityTimeoutSeconds: 60 });
    expect(await handler.run(first)).toBe("retry");
    recoveryAllowed = true;
    const second = await rpc("claim", { workerId: "worker", visibilityTimeoutSeconds: 60 });
    expect(await handler.run(second)).toBe("completed");
    expect(decodeCommandStatus(await rpc("get", { commandId: original.dispatchKey })))
      .toMatchObject({ kind: "execution", execution: { status: "confirmed", audit: "complete" }, workflow: { status: "completed" } });
    expect(await rpc("claim", { workerId: "worker", visibilityTimeoutSeconds: 60 })).toBeNull();
    await expect(command.lookupByReference(actor, "recover")).rejects.toMatchObject({ code: "COMMAND_REJECTED" });
    expect(sends).toBe(1);
  });

  test("Workflow redelivery rejects stale acknowledgement while audit remains exactly once", async () => {
    const store = createPostgresCommandStore(createBunCommandDatabase(sql));
    const actor = { tenantId: crypto.randomUUID(), actorId: "actor" };
    let sends = 0, audits = 0, ready = false;
    const command = createExternalCommand({
      store, inputCodec: plaintextCommandInput, name: "stale.test", input: decodeInput, result: decodeResult,
      authorize: () => "allow", authorizeRecovery: () => "allow",
      send: async () => { sends++; }, lookup: async (input) => ready ? input : null, matches: () => true,
      audit: { event: "changed", details: () => ({}), write: async () => { audits++; } },
    });
    const original = await command.execute(actor, "stale", await fixture());
    await selectRun(original.dispatchKey);
    const first = await rpc("claim", { workerId: "worker", visibilityTimeoutSeconds: 60 });
    expect(await rpc("claim", { workerId: "worker", visibilityTimeoutSeconds: 60 })).toBeNull();
    await selectRun(original.dispatchKey);
    const second = await rpc("claim", { workerId: "worker", visibilityTimeoutSeconds: 60 });
    ready = true;
    const handler = createCommandRecoveryHandler({ workflows, tenantId: actor.tenantId, principal: { subject: "worker" },
      authorize: () => "allow", commands: { "stale.test": command }, retryDelaySeconds: 0 });
    await expect(handler.run(first)).rejects.toThrow();
    expect(await handler.run(second)).toBe("completed");
    expect([sends, audits]).toEqual([1, 1]);
  });

  test("enqueue failure rolls back intent and prevents all external sending", async () => {
    let sends = 0;
    await expect(sql.begin(async (tx) => {
      await tx.unsafe(`CREATE FUNCTION supacloud_commands.reject_test_enqueue() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'enqueue unavailable'; END $$;
        CREATE TRIGGER reject_test_enqueue BEFORE INSERT ON supacloud_workflows.runs
        FOR EACH ROW EXECUTE FUNCTION supacloud_commands.reject_test_enqueue()`);
      const store = createPostgresCommandStore({ transaction: (run) => run({
        query: async (query, parameters) => {
          const result: unknown = await tx.unsafe<unknown>(query, parameters === undefined ? [] : [...parameters]);
          return result;
        },
      }) });
      const command = createExternalCommand({
        store, inputCodec: plaintextCommandInput, name: "enqueue.fail", input: decodeInput, result: decodeResult,
        authorize: () => "allow", send: async () => { sends++; }, lookup: async () => null, matches: () => true,
        audit: { event: "changed", details: () => ({}) },
      });
      await command.execute(identity, "enqueue.fail", { id: "test", enabled: true });
    })).rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    expect(sends).toBe(0);
    expect(await rpc("get", { ...identity, command: "enqueue.fail", operationId: "enqueue.fail" })).toBeNull();
  });

  test("legacy submissions and executions share a validated lookup without confusing queue and effect state", async () => {
    const commandId = crypto.randomUUID();
    expect(decodeCommandStatus(await rpc("submit", {
      commandId, commandType: "legacy.test", targetType: "test", targetId: "one", payload: {},
    }))).toMatchObject({ kind: "submission", commandId, execution: null, workflow: { status: "queued" } });
    const command = transactionCommand(), input = await fixture(), key = crypto.randomUUID();
    const execution = await command.execute(identity, key, input);
    const byId = decodeCommandStatus(await rpc("get", { commandId: execution.dispatchKey }));
    const byReference = decodeCommandStatus(await rpc("get", { ...identity, command: "webhook.update.v1", operationId: key }));
    expect(byId).toEqual(byReference);
    expect(decodeCommandStatus(await rpc("get", { commandId: execution.dispatchKey.toUpperCase() }))).toEqual(byId);
    expect(byId).toMatchObject({ kind: "execution", workflow: null, execution: { status: "confirmed", audit: "complete" } });
    expect(await rpc("get", { ...identity, tenantId: "other", command: "webhook.update.v1", operationId: key })).toBeNull();
    for (const invalid of [{}, { commandId: execution.dispatchKey, tenantId: identity.tenantId },
      { ...identity, command: "webhook.update.v1", operationId: key, unexpected: true }]) {
      await expect(rpc("get", invalid)).rejects.toThrow();
    }
    await expect(rpc("submit", {
      commandId: execution.dispatchKey, commandType: "different", targetType: "test", targetId: "one", payload: {},
    })).rejects.toMatchObject({ errno: "23505" });
    await expect(sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE authenticated");
      await tx.unsafe("SELECT public.supacloud_command_get($1::text::jsonb)", [JSON.stringify({ commandId })]);
    })).rejects.toThrow();
  });

  test("exhausted Workflow retries leave the business outcome unknown and never resend", async () => {
    const actor = { tenantId: crypto.randomUUID(), actorId: "actor" };
    let sends = 0;
    const command = createExternalCommand({
      store: createPostgresCommandStore(createBunCommandDatabase(sql)), inputCodec: plaintextCommandInput,
      name: "exhausted", input: decodeInput, result: decodeResult, authorize: () => "allow", authorizeRecovery: () => "allow",
      send: async () => { sends++; }, lookup: async () => null, matches: () => true,
      audit: { event: "changed", details: () => ({}) },
    });
    const receipt = await command.execute(actor, "exhausted", await fixture());
    await sql.unsafe("UPDATE supacloud_workflows.steps SET max_attempts=1 WHERE run_id=$1::uuid", [receipt.dispatchKey]);
    await selectRun(receipt.dispatchKey);
    const handler = createCommandRecoveryHandler({
      workflows, tenantId: actor.tenantId, principal: { subject: "worker" }, authorize: () => "allow",
      commands: { exhausted: command }, retryDelaySeconds: 0,
    });
    expect(await handler.run(await rpc("claim", { workerId: "worker", visibilityTimeoutSeconds: 60 }))).toBe("retry");
    expect(decodeCommandStatus(await rpc("get", { commandId: receipt.dispatchKey })))
      .toMatchObject({ kind: "execution", execution: { status: "unknown", audit: "pending" }, workflow: { status: "failed" } });
    expect(sends).toBe(1);
  });

  test("retention removes only completed input, preserving conflict detection and duplicate receipts", async () => {
    const store = createPostgresCommandStore(createBunCommandDatabase(sql));
    const actor = { tenantId: crypto.randomUUID(), actorId: "actor" };
    const command = transactionCommand(), input = await fixture();
    const key = crypto.randomUUID();
    const receipt = await command.execute(actor, key, input);
    const remote = createExternalCommand({
      store, inputCodec: plaintextCommandInput, name: "retention.pending", input: decodeInput, result: decodeResult,
      authorize: () => "allow", send: async () => {}, lookup: async () => null, matches: () => true,
      audit: { event: "changed", details: () => ({}) },
    });
    await remote.execute(actor, "pending", input);
    expect(await store.redactCompleted({
      tenantId: actor.tenantId, commands: ["webhook.update.v1", "retention.pending"], before: Date.now() + 1000, limit: 10,
    })).toBe(1);
    await expect(command.lookupByReference(actor, key)).rejects.toMatchObject({ code: "COMMAND_INPUT_EXPIRED" });
    expect(await command.execute(actor, key, input)).toEqual(receipt);
    await expect(command.execute(actor, key, { ...input, enabled: false }))
      .rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_CONFLICT" });
    expect(await remote.lookupByReference(actor, "pending")).toMatchObject({ status: "unknown" });
    expect(await writes(input.id)).toBe(1);
  });

  test("input codec stores authenticated ciphertext and recovery rejects tampering", async () => {
    const store = createPostgresCommandStore(createBunCommandDatabase(sql));
    const encryptionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const command = createTransactionalCommand({
      store, name: "encrypted.input", input: decodeInput, result: decodeResult, authorize: () => "allow", execute: update,
      inputCodec: {
        encode: async (plaintext) => {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encryptionKey, new TextEncoder().encode(plaintext)));
          return Buffer.from(new Uint8Array([...iv, ...encrypted])).toString("base64");
        },
        decode: async (payload) => {
          const bytes = new Uint8Array(Buffer.from(payload, "base64"));
          const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, encryptionKey, bytes.slice(12));
          return new TextDecoder().decode(plain);
        },
      },
      audit: { event: "changed", details: () => ({}) },
    });
    const input = await fixture(), key = crypto.randomUUID();
    const receipt = await command.execute(identity, key, input);
    const stored = await store.transaction((tx) => tx.read({ ...identity, command: "encrypted.input", operationId: key }));
    expect(stored?.inputPayload).not.toContain(input.id);
    expect(await command.lookupByReference(identity, key)).toEqual(receipt);
    await sql.unsafe("UPDATE supacloud_commands.execution_receipts SET input_payload='tampered' WHERE operation_key=$1", [key]);
    await expect(command.lookupByReference(identity, key)).rejects.toMatchObject({ code: "COMMAND_UNAVAILABLE" });
  });
  test("completed input retention does not break a delayed recovery acknowledgement", async () => {
    const store = createPostgresCommandStore(createBunCommandDatabase(sql));
    const actor = { tenantId: crypto.randomUUID(), actorId: "actor" };
    const command = createExternalCommand({
      store, inputCodec: plaintextCommandInput, name: "retention.ack", input: decodeInput, result: decodeResult,
      authorize: () => "allow", authorizeRecovery: () => "allow",
      send: async () => {}, lookup: async (input) => input, matches: () => true, audit: { event: "changed", details: () => ({}) },
    });
    const receipt = await command.execute(actor, "retained", await fixture());
    await selectRun(receipt.dispatchKey);
    expect(await store.redactCompleted({ tenantId: actor.tenantId, commands: ["retention.ack"], before: Date.now() + 1000, limit: 10 })).toBe(1);
    const handler = createCommandRecoveryHandler({ workflows, tenantId: actor.tenantId, principal: { subject: "worker" },
      authorize: () => "allow", commands: { "retention.ack": command }, retryDelaySeconds: 0 });
    expect(await handler.run(await rpc("claim", { workerId: "worker", visibilityTimeoutSeconds: 60 }))).toBe("completed");
  });

  test("v1 upgrade preserves operation identity, canonical input and fingerprint constraints", async () => {
    // All schema changes and fixture cleanup roll back on this isolated test connection.
    await expect(sql.begin(async (tx) => {
      await tx.unsafe("TRUNCATE supacloud_commands.execution_receipts, supacloud_commands.execution_audit");
      await tx.unsafe("ALTER TABLE supacloud_commands.execution_receipts DROP COLUMN input_fingerprint");
      await tx.unsafe("ALTER TABLE supacloud_commands.execution_receipts RENAME COLUMN input_payload TO input_key");
      await tx.unsafe(`ALTER TABLE supacloud_commands.execution_receipts
        ADD COLUMN lease_id uuid, ADD COLUMN lease_until timestamptz,
        ADD COLUMN next_attempt_at timestamptz DEFAULT now(),
        ADD COLUMN recovery_attempts integer DEFAULT 7`);
      await tx.unsafe("DROP TRIGGER execution_recovery_enqueue ON supacloud_commands.execution_receipts");
      await tx.unsafe(`INSERT INTO supacloud_commands.execution_receipts
        (tenant_id,actor_id,command,operation_key,kind,input_key,status,audit_state)
        VALUES ('migration','actor','remote.v1','original-key','external','{"enabled":true}','pending','pending')`);
      const before: unknown = await tx.unsafe<unknown>(`SELECT w.id FROM supacloud_workflows.runs w
        JOIN supacloud_commands.execution_receipts r ON r.dispatch_key=w.id`);
      expect(before).toHaveLength(0);
      await tx.unsafe(COMMAND_PERSISTENCE_UPGRADE_SQL);
      await tx.unsafe(COMMAND_PERSISTENCE_UPGRADE_SQL);
      const records: unknown = await tx.unsafe<unknown>(`SELECT operation_key,input_payload,
        input_fingerprint=encode(sha256(convert_to('{"enabled":true}','UTF8')),'hex') AS valid
        FROM supacloud_commands.execution_receipts`);
      if (!Array.isArray(records)) throw new Error("Invalid migration rows");
      const migrated: unknown = records[0];
      expect(migrated).toEqual({ operation_key: "original-key", input_payload: '{"enabled":true}', valid: true });
      const constraints: unknown = await tx.unsafe<unknown>(`SELECT conname FROM pg_constraint
        WHERE conrelid='supacloud_commands.execution_receipts'::regclass AND conname='execution_receipts_input_fingerprint_check'`);
      if (!Array.isArray(constraints)) throw new Error("Invalid constraints");
      const constraint: unknown = constraints[0];
      expect(constraint).toEqual({ conname: "execution_receipts_input_fingerprint_check" });
      const workflows: unknown = await tx.unsafe<unknown>(`SELECT count(*)::integer AS count FROM supacloud_workflows.runs w
        JOIN supacloud_commands.execution_receipts r ON w.id=r.dispatch_key`);
      if (!Array.isArray(workflows)) throw new Error("Invalid workflow rows");
      const workflowCount: unknown = workflows[0];
      expect(workflowCount).toEqual({ count: 1 });
      const oldColumns: unknown = await tx.unsafe<unknown>(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='supacloud_commands' AND table_name='execution_receipts'
        AND column_name IN ('lease_id','lease_until','next_attempt_at','recovery_attempts')`);
      expect(oldColumns).toHaveLength(0);
      throw new Error("Rollback migration test");
    })).rejects.toThrow("Rollback migration test");
  });
});
