import { expect, test } from "bun:test";
import type { CommandAuthorization } from "@supacloud/contracts";
import { createExternalCommand, createTransactionalCommand, plaintextCommandInput } from "./index";
import type { CommandStore, OperationReference, StoredCommand } from "./store";

interface MemoryTransaction { writes: number }
function memoryStore() {
  let records = new Map<string, StoredCommand>();
  let writes = 0, audits = 0;
  const key = (ref: OperationReference) => JSON.stringify([ref.tenantId, ref.actorId, ref.command, ref.operationId]);
  const store: CommandStore<MemoryTransaction> = {
    async transaction(run) {
      const pending = structuredClone(records), tx = { writes };
      let pendingAudits = audits;
      const value = await run({
        transaction: tx, lock: async () => {},
        read: async (ref) => pending.get(key(ref)) ?? null,
        insert: async (record) => { pending.set(key(record.receipt), record); },
        confirm: async (ref, result) => {
          const record = pending.get(key(ref));
          if (!record) throw new Error("Missing intent");
          record.receipt = { ...ref, dispatchKey: record.receipt.dispatchKey, status: "confirmed", audit: "pending", result };
        },
        markUnknown: async (ref) => {
          const record = pending.get(key(ref));
          if (record && record.receipt.status !== "confirmed") record.receipt.status = "unknown";
        },
        audit: async () => { pendingAudits++; },
        completeAudit: async (ref) => {
          const record = pending.get(key(ref));
          if (record?.receipt.status === "confirmed") record.receipt.audit = "complete";
        },
      });
      records = pending; writes = tx.writes; audits = pendingAudits;
      return value;
    },
  };
  return { store, stats: () => ({ writes, audits, records: records.size }) };
}
function input(value: unknown): { enabled: boolean } {
  if (value === null || typeof value !== "object" || !("enabled" in value) || typeof value.enabled !== "boolean") {
    throw new TypeError("Invalid input");
  }
  return { enabled: value.enabled };
}
const identity = { tenantId: "tenant", actorId: "actor" };

test("explicit denial, thrown failure and malformed decisions are distinct and cannot write", async () => {
  for (const policy of [
    { authorize: (): CommandAuthorization => "deny", code: "COMMAND_REJECTED" },
    { authorize: (): CommandAuthorization => { throw new Error("Policy database unavailable"); }, code: "COMMAND_UNAVAILABLE" },
  ]) {
    const f = memoryStore();
    const command = createTransactionalCommand({
      store: f.store, name: "update", input, result: input, inputCodec: plaintextCommandInput,
      authorize: policy.authorize, execute: async (tx, value) => { tx.writes++; return value; },
      audit: { event: "changed", details: () => ({}) },
    });
    await expect(command.execute(identity, "key", { enabled: true })).rejects.toMatchObject({ code: policy.code });
    expect(f.stats()).toEqual({ writes: 0, audits: 0, records: 0 });
  }
});

test("untrusted authorization return fails closed without a type assertion", async () => {
  const { checkAuthorization } = await import("./context");
  const result: unknown = Reflect.apply(checkAuthorization, undefined, [() => undefined]);
  expect(result).toBeInstanceOf(Promise);
  if (!(result instanceof Promise)) throw new Error("Expected async authorization");
  await expect(result).rejects.toMatchObject({ code: "COMMAND_UNAVAILABLE" });
});

test("runtime snapshot isolates caller input and identity while awaiting encoding", async () => {
  const f = memoryStore(), started = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const original = { enabled: true }, actor = { ...identity };
  const command = createTransactionalCommand({
    store: f.store, name: "snapshot", input, result: input,
    inputCodec: { encode: async (value) => { started.resolve(); await resume.promise; return value; }, decode: (v) => v },
    authorize: () => "allow",
    execute: async (tx, value, verified) => { expect(verified).toMatchObject(identity); tx.writes++; return value; },
    audit: { event: "changed", details: () => ({}) },
  });
  const pending = command.execute(actor, "key", original);
  await started.promise;
  original.enabled = false; actor.tenantId = "changed";
  resume.resolve();
  expect(await pending).toMatchObject({ tenantId: "tenant", result: { enabled: true } });
});

test("rollback and retained receipts work through the store port without SQL", async () => {
  const f = memoryStore();
  let available = false, allowed = true;
  const command = createTransactionalCommand({
    store: f.store, name: "update", input, result: input, inputCodec: plaintextCommandInput,
    authorize: () => allowed ? "allow" : "deny",
    execute: async (tx, value) => { tx.writes++; return value; },
    audit: { event: "changed", details: () => ({}), write: async () => { if (!available) throw new Error("offline"); } },
  });
  await expect(command.execute(identity, "key", { enabled: true })).rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
  expect(f.stats()).toEqual({ writes: 0, audits: 0, records: 0 });
  available = true;
  const receipt = await command.execute(identity, "key", { enabled: true });
  expect(await command.execute(identity, "key", { enabled: true })).toEqual(receipt);
  await expect(command.execute(identity, "key", { enabled: false })).rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_CONFLICT" });
  allowed = false;
  await expect(command.lookupByReference(identity, "key")).rejects.toMatchObject({ code: "COMMAND_REJECTED" });
  expect(f.stats()).toEqual({ writes: 1, audits: 1, records: 1 });
});

test("preflight failure never sends; independent recovery can outlive interactive permission", async () => {
  const f = memoryStore();
  let allowed = false, ready = false, sends = 0;
  const command = createExternalCommand({
    store: f.store, name: "remote", input, result: input, inputCodec: plaintextCommandInput,
    authorize: () => allowed ? "allow" : "deny",
    authorizeRecovery: (principal, reference) => principal.subject === "worker" && reference.tenantId === "tenant" ? "allow" : "deny",
    send: async () => { sends++; }, lookup: async () => ready ? { enabled: true } : null,
    matches: (request, result) => request.enabled === result.enabled,
    audit: { event: "changed", details: () => ({}) },
  });
  await expect(command.execute(identity, "key", { enabled: true })).rejects.toMatchObject({ code: "COMMAND_REJECTED" });
  expect(sends).toBe(0);
  allowed = true;
  expect(await command.execute(identity, "key", { enabled: true })).toMatchObject({ status: "unknown" });
  allowed = false; ready = true;
  const reference = { ...identity, command: "remote", operationId: "key" };
  await expect(command.recover({ subject: "untrusted" }, reference)).rejects.toMatchObject({ code: "COMMAND_REJECTED" });
  expect(await command.recover({ subject: "worker" }, reference)).toMatchObject({ status: "confirmed", audit: "complete" });
  expect(sends).toBe(1);
});

test("invalid input, unstable schemas and codec failures never enter a transaction", async () => {
  let transactions = 0;
  const store: CommandStore<null> = { transaction: async () => { transactions++; throw new Error("unexpected"); } };
  const base = {
    store, name: "invalid", input, result: input, inputCodec: plaintextCommandInput,
    authorize: (): CommandAuthorization => "allow", execute: async () => ({ enabled: true }),
    audit: { event: "changed", details: () => ({}) },
  };
  await expect(createTransactionalCommand(base).execute(identity, "key", null))
    .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  await expect(createTransactionalCommand({ ...base, input: (value) => ({ enabled: !input(value).enabled }) })
    .execute(identity, "key", { enabled: true })).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  await expect(createTransactionalCommand({ ...base, inputCodec: {
    encode: () => { throw new Error("Key unavailable"); }, decode: (v) => v,
  } }).execute(identity, "key", { enabled: true })).rejects.toMatchObject({ code: "COMMAND_UNAVAILABLE" });
  expect(transactions).toBe(0);
});
