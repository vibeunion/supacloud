import { expect, test } from "bun:test";
import { CommandError } from "@supacloud/contracts";
import { createPostgresCommandStore, type CommandDatabase } from "./command-adapter";

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
