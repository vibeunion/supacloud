import { expect, test } from "bun:test";
import { CommandError } from "@supacloud/contracts";
import { createPersistentCommandAdapter } from "./persistent-command";
import { executeCompiledCommand, type CompiledModule } from "./index";

const identity = { tenantId: "tenant", actorId: "actor" };
const module: Pick<CompiledModule, "name" | "commands"> = {
  name: "test", commands: [{
    className: "Update", name: "update.v1", permission: "update", rpc: "update",
    idempotency: "required", transaction: "none", audit: "updated",
  }],
};
test("persistent adapters own execution and expose truthful external capabilities", async () => {
  let writes = 0;
  const adapter = createPersistentCommandAdapter({
    kind: "external",
    execute: async (actor, key, input) => {
      writes++;
      expect(actor).toEqual(identity);
      expect(input).toEqual({ enabled: true });
      return { ...actor, command: "update.v1", operationId: key, dispatchKey: "dispatch", status: "unknown", audit: "pending" };
    },
  }, { identity: () => identity, input: (inv) => inv.input.body });
  expect(adapter.capabilities).toEqual({ boundary: "external", transaction: false, audit: true, idempotency: true });
  const result = await executeCompiledCommand({
    module, command: "Update", input: { enabled: true }, requestContext: identity,
    request: new Request("https://example.test", { headers: { "idempotency-key": "operation" } }),
    governance: { authorize: () => {}, rpc: { update: adapter } },
    handler: (): unknown => { throw new Error("Duplicate handler"); },
    decode: (value) => value,
  });
  expect(result).toMatchObject({ status: "unknown" });
  expect(writes).toBe(1);
});
test("persistence failures have stable sanitized HTTP semantics", async () => {
  for (const [code, status] of [
    ["COMMAND_INPUT_INVALID", 400], ["COMMAND_REJECTED", 403], ["COMMAND_IDEMPOTENCY_CONFLICT", 409],
    ["COMMAND_OUTCOME_UNKNOWN", 503], ["COMMAND_RECEIPT_INVALID", 503],
    ["COMMAND_UNAVAILABLE", 503], ["COMMAND_INPUT_EXPIRED", 410],
  ] as const) {
    const adapter = createPersistentCommandAdapter({
      kind: "transactional", execute: async () => { throw new CommandError(code); },
    }, { identity: () => identity, input: () => ({}) });
    await expect(executeCompiledCommand({
      module, command: "Update", input: {}, requestContext: identity,
      request: new Request("https://example.test", { headers: { "idempotency-key": "operation" } }),
      governance: { authorize: () => {}, rpc: { update: adapter } },
      handler: (): unknown => { throw new Error("Duplicate handler"); }, decode: (value) => value,
    })).rejects.toMatchObject({ code, status, message: code });
  }
});
