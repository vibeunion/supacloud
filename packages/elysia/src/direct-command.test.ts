import { expect, test } from "bun:test";
import { executeCompiledCommand, type CompiledModule, type CommandGovernance } from "./index";

const module: Pick<CompiledModule, "name" | "commands" | "aspects"> = {
  name: "review", commands: [{ className: "Approve", name: "approve", permission: "approve",
    transaction: "required", audit: "approved", idempotency: "required", rpc: "approve_review" }],
};
function execute(governance: CommandGovernance, handler = async (input: number) => input + 1,
  target = module, stages: string[] = []) {
  return executeCompiledCommand({
    module: target, command: "Approve", input: 4,
    request: new Request("https://app.example/"), requestContext: { requestId: "r1" },
    governance, handler, observer: (event) => { if (event.phase === "started") stages.push(event.stage); },
    decode: (value) => { if (typeof value !== "number") throw Error("invalid result"); return value; },
  });
}
test("direct command uses descriptor, one RPC adapter and explicit aspects after authorization", async () => {
  const order: string[] = [], stages: string[] = [];
  const result = await execute({
    authorize: () => { order.push("authorize"); },
    rpc: { approve_review: {
      capabilities: { audit: true, transaction: true, idempotency: true },
      execute: async (_inv, next) => { order.push("rpc"); return next(); },
    } },
    audit: { succeeded: () => { throw Error("second audit"); }, failed: () => {} },
  }, async () => { order.push("handler"); return 5; },
  { ...module, aspects: [(_ctx, next) => { order.push("aspect"); return next(); }] }, stages);
  expect(result).toBe(5);
  expect(order).toEqual(["authorize", "rpc", "aspect", "handler"]);
  expect(stages).toContain("rpc:approve_review");
});
test("missing RPC, missing capability and denied authorization never execute", async () => {
  let calls = 0;
  const handler = async () => { calls++; return 1; };
  await expect(execute({ authorize: () => {} }, handler)).rejects.toMatchObject({ code: "COMMAND_RPC_UNAVAILABLE" });
  await expect(execute({ authorize: () => {}, rpc: { approve_review: {
    capabilities: {}, execute: (_inv, next) => next(),
  } } }, handler)).rejects.toMatchObject({ code: "COMMAND_AUDIT_UNAVAILABLE" });
  await expect(execute({ authorize: () => { throw Error("denied"); }, rpc: { approve_review: {
    capabilities: { audit: true, transaction: true, idempotency: true }, execute: (_inv, next) => next(),
  } } }, handler, { ...module, aspects: [() => { calls++; }] })).rejects.toThrow("denied");
  expect(calls).toBe(0);
});
test("RPC cannot invoke the write continuation twice", async () => {
  let writes = 0;
  await expect(execute({ authorize: () => {}, rpc: { approve_review: {
    capabilities: { audit: true, transaction: true, idempotency: true },
    execute: async (_inv, next) => { await next(); return next(); },
  } } }, async () => ++writes)).rejects.toMatchObject({ code: "COMMAND_CONTINUATION_REUSED" });
  expect(writes).toBe(1);
});
test("replayed RPC outcomes are decoded and never execute the handler", async () => {
  let writes = 0;
  await expect(execute({ authorize: () => {}, rpc: { approve_review: {
    capabilities: { audit: true, transaction: true, idempotency: true }, execute: () => ({ bad: true }),
  } } }, async () => ++writes)).rejects.toThrow("invalid result");
  expect(writes).toBe(0);
});
