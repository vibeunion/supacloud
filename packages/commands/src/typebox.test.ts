import { Type } from "@sinclair/typebox";
import { expect, expectTypeOf, test } from "bun:test";
import type { DurableCommandReceipt } from "@supacloud/contracts";
import { plaintextCommandInput } from "./index";
import { createTypeBoxTransactionalCommand } from "./typebox";
import type { CommandStore, OperationReference, StoredCommand } from "./store";

interface Tx { writes: number }

function fixture() {
  let records = new Map<string, StoredCommand>();
  let writes = 0, audits = 0, transactions = 0;
  const key = (ref: OperationReference) =>
    JSON.stringify([ref.tenantId, ref.actorId, ref.command, ref.operationId]);
  const store: CommandStore<Tx> = {
    async transaction(run) {
      transactions++;
      const pending = structuredClone(records), tx = { writes };
      let pendingAudits = audits;
      const value = await run({
        transaction: tx,
        lock: async () => {},
        read: async (ref) => pending.get(key(ref)) ?? null,
        insert: async (record) => { pending.set(key(record.receipt), record); },
        confirm: async () => { throw new Error("Not a transactional operation"); },
        markUnknown: async () => { throw new Error("Not a transactional operation"); },
        audit: async () => { pendingAudits++; },
        completeAudit: async () => { throw new Error("Not a transactional operation"); },
      });
      records = pending; writes = tx.writes; audits = pendingAudits;
      return value;
    },
  };
  return { store, stats: () => ({ writes, audits, transactions, records: records.size }) };
}

const schemas = {
  input: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
  result: Type.Object({ accepted: Type.Boolean() }, { additionalProperties: false }),
};
const identity = { tenantId: "tenant", actorId: "actor" };
function definition(f = fixture()) {
  return {
    store: f.store, name: "settings.update", schemas,
    inputCodec: plaintextCommandInput,
    authorize: () => "allow" as const,
    audit: { event: "settings.updated", details: () => ({}) },
  };
}

test("one transaction owns policy, business write, receipt and audit; replay does not write", async () => {
  const f = fixture();
  const transactions: Tx[] = [];
  const command = createTypeBoxTransactionalCommand({
    ...definition(f),
    authorize: (_actor, input, tx) => {
      expectTypeOf(input).toEqualTypeOf<{ enabled: boolean }>();
      expectTypeOf(tx).toEqualTypeOf<Tx>();
      transactions.push(tx);
      return "allow";
    },
    execute: async (tx, input, actor) => {
      expect(actor).toMatchObject(identity);
      transactions.push(tx);
      tx.writes++;
      return { accepted: input.enabled };
    },
    audit: {
      event: "settings.updated",
      details: (input, result) => ({ from: input.enabled, to: result.accepted }),
      write: async (tx) => { transactions.push(tx); },
    },
  });
  const receipt = await command.execute(identity, "operation", { enabled: true });
  expectTypeOf(receipt).toEqualTypeOf<DurableCommandReceipt<{ accepted: boolean }>>();
  expect(receipt).toMatchObject({ status: "confirmed", audit: "complete", result: { accepted: true } });
  expect(transactions).toHaveLength(3);
  expect(transactions[0]).toBe(transactions[1]);
  expect(transactions[1]).toBe(transactions[2]);
  expect(await command.executeUnknown(identity, "operation", { enabled: true })).toEqual(receipt);
  expect(await command.lookup(identity, "operation", { enabled: true })).toEqual(receipt);
  expect(await command.lookupUnknown(identity, "operation", { enabled: true })).toEqual(receipt);
  expect(await command.lookupByReference(identity, "operation")).toEqual(receipt);
  expect(f.stats()).toMatchObject({ writes: 1, audits: 1, records: 1 });
  await expect(command.execute(identity, "operation", { enabled: false }))
    .rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_CONFLICT" });
});

test("unknown input is validated without coercion or silently accepting extra fields", async () => {
  const f = fixture();
  const command = createTypeBoxTransactionalCommand({
    ...definition(f), execute: async (tx, input) => {
      tx.writes++;
      return { accepted: input.enabled };
    },
  });
  for (const value of [null, {}, { enabled: "yes" }, { enabled: true, tenantId: "other" }]) {
    await expect(command.executeUnknown(identity, "operation", value))
      .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  }
  expect(f.stats()).toEqual({ writes: 0, audits: 0, records: 0, transactions: 0 });
});

test("invalid handler output is checked before commit even when static types are bypassed", async () => {
  const f = fixture();
  const command = createTypeBoxTransactionalCommand({
    ...definition(f),
    // @ts-expect-error Result schema, not the handler, determines the output type.
    execute: async (tx, input) => {
      expectTypeOf(tx).toEqualTypeOf<Tx>();
      expectTypeOf(input).toEqualTypeOf<{ enabled: boolean }>();
      tx.writes++;
      return { accepted: "private invalid result" };
    },
  });
  await expect(command.execute(identity, "operation", { enabled: true }))
    .rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
  expect(f.stats()).toMatchObject({ writes: 0, audits: 0, records: 0 });
});

test("denial and failed audit cannot commit business writes", async () => {
  for (const allowed of [false, true]) {
    const f = fixture();
    const command = createTypeBoxTransactionalCommand({
      ...definition(f),
      authorize: () => allowed ? "allow" : "deny",
      execute: async (tx, input) => { tx.writes++; return { accepted: input.enabled }; },
      audit: {
        event: "settings.updated", details: () => ({}),
        write: async () => { throw new Error("private audit failure"); },
      },
    });
    await expect(command.execute(identity, "operation", { enabled: true }))
      .rejects.toMatchObject({ code: allowed ? "COMMAND_OUTCOME_UNKNOWN" : "COMMAND_REJECTED" });
    expect(f.stats()).toMatchObject({ writes: 0, audits: 0, records: 0 });
  }
});

test("receipt replay reauthorizes and never mixes tenant identities", async () => {
  const f = fixture();
  let allowed = true;
  const command = createTypeBoxTransactionalCommand({
    ...definition(f),
    authorize: () => allowed ? "allow" : "deny",
    execute: async (tx, input) => { tx.writes++; return { accepted: input.enabled }; },
  });
  await command.execute(identity, "same-key", { enabled: true });
  expect(await command.lookup({ ...identity, tenantId: "other" }, "same-key", { enabled: true })).toBeNull();
  allowed = false;
  await expect(command.execute(identity, "same-key", { enabled: true }))
    .rejects.toMatchObject({ code: "COMMAND_REJECTED" });
  expect(f.stats()).toMatchObject({ writes: 1, audits: 1, records: 1 });
});

test("contract snapshot preserves constraints despite caller schema mutations", async () => {
  const input = Type.Object({ count: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
  const result = Type.Object({ count: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
  const f = fixture();
  const command = createTypeBoxTransactionalCommand({
    ...definition(f), schemas: { input, result },
    execute: async (tx, value) => { tx.writes++; return value; },
  });
  input.properties.count.minimum = -10;
  result.properties.count.minimum = -10;
  await expect(command.execute(identity, "bad", { count: 0 }))
    .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  expect(f.stats().transactions).toBe(0);
  expect(await command.execute(identity, "good", { count: 1 }))
    .toMatchObject({ result: { count: 1 } });
});

test("transactional execution policy forwards cancellation and rolls back before receipts", async () => {
  const f = fixture();
  const command = createTypeBoxTransactionalCommand({
    ...definition(f), executionPolicy: { timeoutMs: 5 },
    execute: async (tx, input, _identity, signal) => {
      tx.writes++;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { accepted: input.enabled };
    },
  });
  await expect(command.execute(identity, "timed-out", { enabled: true }))
    .rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
  expect(f.stats()).toMatchObject({ writes: 0, records: 0, audits: 0 });
});

// Checked by TypeScript; application calls must not widen the schema contract.
function typeSafety() {
  const base = definition();
  const command = createTypeBoxTransactionalCommand({
    ...base, execute: async (_tx, input) => ({ accepted: input.enabled }),
  });
  // @ts-expect-error Wrong input must be rejected by TypeScript.
  command.execute(identity, "key", { enabled: "yes" });
  // @ts-expect-error Lookup uses the same inferred input contract.
  command.lookup(identity, "key", { enabled: 1 });
  // @ts-expect-error Receipt type cannot be asserted by a caller.
  command.execute<{ accepted: string }>(identity, "key", { enabled: true });
  createTypeBoxTransactionalCommand({
    ...base,
    // @ts-expect-error NoInfer prevents a handler from replacing the input shape.
    execute: async (_tx, input: { enabled: string }) => ({ accepted: input.enabled === "yes" }),
  });
  createTypeBoxTransactionalCommand({
    ...base, execute: async (_tx, input) => ({ accepted: input.enabled }),
    // @ts-expect-error Authorization inputs are also schema-owned.
    authorize: (_actor, input: { enabled: string }) => input.enabled ? "allow" : "deny",
  });
}
void typeSafety;
