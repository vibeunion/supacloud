import { expect, test } from "bun:test";
import { CommandError } from "@supacloud/contracts";
import { createPostgresCommandStore, type CommandDatabase } from "./command-adapter";
import { COMMAND_PERSISTENCE_SQL, COMMAND_PERSISTENCE_UPGRADE_SQL } from "./command-schema";

const reference = { tenantId: "tenant", actorId: "actor", command: "update", operationId: "key" };
function database(result: unknown): CommandDatabase {
  return { transaction: (run) => run({ query: async () => result }) };
}
test("Postgres port rejects malformed, sparse, duplicate and impossible receipt rows", async () => {
  for (const result of [null, {}, [null], Array(1), [{}, {}], [{
    ...reference, dispatchKey: "key", kind: "external", input_fingerprint: "a".repeat(64),
    input_payload: "{}", status: "pending", audit: "complete", result_json: null,
  }]]) {
    const store = createPostgresCommandStore(database(result));
    await expect(store.transaction((tx) => tx.read(reference))).rejects.toMatchObject({ code: "COMMAND_RECEIPT_INVALID" });
  }
});
test("connection acquisition failure differs from an uncertain transaction completion", async () => {
  const offline = createPostgresCommandStore({ transaction: async () => { throw new Error("offline"); } });
  await expect(offline.transaction(async () => true)).rejects.toMatchObject({ code: "COMMAND_UNAVAILABLE" });
  const ambiguous = createPostgresCommandStore({
    transaction: async (run) => { await run({ query: async () => [] }); throw new Error("lost commit"); },
  });
  await expect(ambiguous.transaction(async () => true)).rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
  const store = createPostgresCommandStore(database([]));
  await expect(store.transaction(async () => { throw new CommandError("COMMAND_REJECTED"); }))
    .rejects.toMatchObject({ code: "COMMAND_REJECTED" });
});
test("retention SQL is bounded and tenant scoped before executing", async () => {
  let queries = 0;
  const store = createPostgresCommandStore({
    transaction: (run) => run({ query: async () => { queries++; return []; } }),
  });
  for (const limit of [0, 1001, 1.2]) {
    await expect(store.redactCompleted({ tenantId: "tenant", commands: ["remote"], before: 1000, limit }))
      .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  }
  await expect(store.redactCompleted({ tenantId: "tenant", commands: [], before: 1000, limit: 1 }))
    .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  expect(queries).toBe(0);
});

test("Postgres decodes rejected receipts without a result and rejects incomplete rejection", async () => {
  const row = { ...reference, dispatchKey: "dispatch", kind: "external", input_fingerprint: "a".repeat(64),
    input_payload: null, status: "rejected", audit: "complete", result_json: null };
  expect(await createPostgresCommandStore(database([row])).transaction((tx) => tx.read(reference)))
    .toMatchObject({ receipt: { status: "rejected", audit: "complete" }, inputPayload: null });
  for (const invalid of [{ ...row, audit: "pending" }, { ...row, result_json: "null" }]) {
    await expect(createPostgresCommandStore(database([invalid])).transaction((tx) => tx.read(reference)))
      .rejects.toMatchObject({ code: "COMMAND_RECEIPT_INVALID" });
  }
});

test("rejection and competing updates are identity scoped and preserve terminal states", async () => {
  const queries: { sql: string; parameters: readonly (string | number | boolean | null)[] }[] = [];
  const store = createPostgresCommandStore({ transaction: (run) => run({
    query: async (sql, parameters = []) => { queries.push({ sql, parameters }); return []; },
  }) });
  await store.transaction(async (session) => {
    if (!session.reject) throw new Error("Missing rejection support");
    await session.reject(reference);
    await session.confirm(reference, true);
    await session.markUnknown(reference);
  });
  expect(queries).toHaveLength(3);
  for (const query of queries) {
    expect(query.sql).toContain("tenant_id=$1 AND actor_id=$2 AND command=$3 AND operation_key=$4");
    expect(query.sql).toContain("status IN ('pending','unknown')");
    expect(query.parameters.slice(0, 4)).toEqual(["tenant", "actor", "update", "key"]);
  }
  expect(queries[0]?.sql).toContain("status='rejected',audit_state='complete'");
  expect(queries[0]?.sql).toContain("kind='external'");
  await store.redactCompleted({ tenantId: "tenant", commands: ["remote"], before: 1000, limit: 1 });
  expect(queries[3]?.sql).toContain("status IN ('confirmed','rejected') AND audit_state='complete'");
  expect(queries[3]?.parameters).toEqual(["tenant", '["remote"]', 1000, 1]);
});

test("schema guards terminal writes, requires rejection audit and excludes rejected recovery", () => {
  expect(COMMAND_PERSISTENCE_SQL).toContain("OLD.status IN ('confirmed','rejected')");
  expect(COMMAND_PERSISTENCE_SQL).toContain("NEW.status IS DISTINCT FROM OLD.status");
  expect(COMMAND_PERSISTENCE_SQL).toContain("DEFERRABLE INITIALLY DEFERRED");
  expect(COMMAND_PERSISTENCE_SQL).toContain("SUPACLOUD_COMMAND_REJECTION_AUDIT_REQUIRED");
  expect(COMMAND_PERSISTENCE_SQL).toContain("NEW.status <> 'rejected'");
  expect(COMMAND_PERSISTENCE_UPGRADE_SQL).toContain("DROP CONSTRAINT IF EXISTS execution_receipts_status_check");
  expect(COMMAND_PERSISTENCE_UPGRADE_SQL).toContain("DROP CONSTRAINT IF EXISTS execution_receipts_check1");
  expect(COMMAND_PERSISTENCE_UPGRADE_SQL).toContain("kind='external' AND status<>'rejected'");
});
