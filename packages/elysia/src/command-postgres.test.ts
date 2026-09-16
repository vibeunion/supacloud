import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createBunCommandDatabase } from "@supacloud/db/bun";
import { COMMAND_PERSISTENCE_SQL, COMMAND_PERSISTENCE_UPGRADE_SQL } from "@supacloud/db";
import { createTransactionalCommand, createExternalCommand, createCommandRecoveryJob, plaintextCommandInput } from "@supacloud/commands";
import { createPostgresCommandStore, type CommandTransaction } from "@supacloud/db";

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

  test("recovery leases exclude other workers and stale release cannot clear a newer lease", async () => {
    const store = createPostgresCommandStore(createBunCommandDatabase(sql));
    const actor = { tenantId: crypto.randomUUID(), actorId: "actor" };
    const command = createExternalCommand({
      store, inputCodec: plaintextCommandInput, name: "lease.test", input: decodeInput, result: decodeResult,
      authorize: () => "allow", send: async () => {}, lookup: async () => null, matches: () => true,
      audit: { event: "changed", details: () => ({}) },
    });
    const input = await fixture();
    await command.execute(actor, "one", input);
    await command.execute(actor, "two", input);
    await command.execute({ ...actor, tenantId: crypto.randomUUID() }, "foreign", input);
    const now = Date.now() + 1000;
    const scope = { tenantId: actor.tenantId, commands: ["lease.test"], now, limit: 1, leaseMs: 100 };
    const [a, b] = await Promise.all([store.claim(scope), store.claim(scope)]);
    expect(a).toHaveLength(1); expect(b).toHaveLength(1);
    const first = a[0], second = b[0];
    if (!first || !second) throw new Error("Missing leases");
    expect(first.operationId).not.toBe(second.operationId);
    expect(first.tenantId).toBe(actor.tenantId);
    expect(await store.claim(scope)).toEqual([]);
    const renewed = await store.claim({ ...scope, now: now + 101, limit: 2 });
    expect(renewed).toHaveLength(2);
    await store.release(first, now);
    expect(await store.claim({ ...scope, now: now + 101 })).toEqual([]);
    for (const lease of renewed) await store.release(lease, now + 1000);
    expect(await store.claim({ ...scope, now: now + 500 })).toEqual([]);
    expect(await store.claim({ ...scope, now: now + 1001, limit: 2 })).toHaveLength(2);
  });

  test("native recovery uses independent worker authorization and never dispatches again", async () => {
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
    await command.execute(actor, "recover", input);
    allowed = false; ready = true; recoveryAllowed = false;
    let now = Date.now() + 1000;
    const job = createCommandRecoveryJob({
      store, tenantId: actor.tenantId, principal: { subject: "worker" }, authorize: () => "allow",
      commands: { "worker.test": command }, batchSize: 10, leaseMs: 1000, retryAfterMs: 100,
      alertAfterMs: 100, inputRetentionMs: 60_000, now: () => now,
    });
    expect(await job.run()).toMatchObject({ failed: 1, completed: 0 });
    recoveryAllowed = true; now += 101;
    expect(await job.run()).toMatchObject({ failed: 0, completed: 1 });
    expect(await job.run()).toMatchObject({ claimed: 0 });
    await expect(command.lookupByReference(actor, "recover")).rejects.toMatchObject({ code: "COMMAND_REJECTED" });
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

  test("v1 upgrade preserves operation identity, canonical input and fingerprint constraints", async () => {
    // All schema changes and fixture cleanup roll back on this isolated test connection.
    await expect(sql.begin(async (tx) => {
      await tx.unsafe("TRUNCATE supacloud_commands.execution_receipts, supacloud_commands.execution_audit");
      await tx.unsafe("ALTER TABLE supacloud_commands.execution_receipts DROP COLUMN input_fingerprint");
      await tx.unsafe("ALTER TABLE supacloud_commands.execution_receipts RENAME COLUMN input_payload TO input_key");
      await tx.unsafe(`INSERT INTO supacloud_commands.execution_receipts
        (tenant_id,actor_id,command,operation_key,kind,input_key,status,audit_state)
        VALUES ('migration','actor','remote.v1','original-key','external','{"enabled":true}','pending','pending')`);
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
      throw new Error("Rollback migration test");
    })).rejects.toThrow("Rollback migration test");
  });
});
