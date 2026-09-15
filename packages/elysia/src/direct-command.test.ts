import { expect, test } from "bun:test";
import { ApplicationError, executeCompiledCommand, previewCompiledCommand, type CompiledModule, type CommandGovernance } from "./index";

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

function preview(governance: Pick<CommandGovernance, "authorize">, previewFn: (input: number) => unknown,
  rpc = async () => { throw new Error("rpc executed"); },
  handler = async () => { throw new Error("handler executed"); }) {
  const stages: string[] = [];
  return {
    stages,
    result: previewCompiledCommand({
      module, command: "Approve", input: 4,
      request: new Request("https://app.example/"), requestContext: { requestId: "r1" },
      governance: {
        authorize: governance.authorize,
        rpc: { approve_review: { capabilities: { audit: true, transaction: true, idempotency: true }, execute: rpc } },
      },
      preview: previewFn,
    }),
    execute: () => execute({
      authorize: governance.authorize,
      rpc: { approve_review: { capabilities: { audit: true, transaction: true, idempotency: true }, execute: rpc } },
    }, handler, module, stages),
  };
}

test("denied authorization returns a blocked preview and never runs preview, RPC or writes", async () => {
  let previews = 0;
  const denied = preview({
    authorize: () => { throw new ApplicationError("Denied", { status: 403, code: "COMMAND_FORBIDDEN" }); },
  }, () => { previews++; return { command: "approve", allowed: true, blockers: [] }; });
  await expect(denied.result).resolves.toEqual({
    command: "approve", allowed: false,
    blockers: [{ code: "COMMAND_FORBIDDEN", message: "Denied" }],
  });
  expect(previews).toBe(0);
  await expect(denied.execute()).rejects.toMatchObject({ status: 403, code: "COMMAND_FORBIDDEN" });
});

test("allowed authorization runs preview without RPC or the write handler", async () => {
  let previews = 0;
  let writes = 0;
  let rpcs = 0;
  const allowed = await previewCompiledCommand({
    module, command: "Approve", input: 4,
    request: new Request("https://app.example/"), requestContext: { requestId: "r1" },
    governance: {
      authorize: () => {},
      rpc: { approve_review: {
        capabilities: { audit: true, transaction: true, idempotency: true },
        execute: async () => { rpcs++; throw new Error("rpc executed"); },
      } },
    },
    preview: (input) => {
      previews++;
      return { command: "approve", allowed: input === 4, blockers: [] };
    },
  });
  expect(allowed).toEqual({ command: "approve", allowed: true, blockers: [] });
  expect(previews).toBe(1);
  expect(rpcs).toBe(0);
  expect(writes).toBe(0);
});

test("domain blockers disable the command without RPC or writes", async () => {
  let rpcs = 0;
  let writes = 0;
  const blocked = await previewCompiledCommand({
    module, command: "Approve", input: 4,
    request: new Request("https://app.example/"), requestContext: { requestId: "r1" },
    governance: {
      authorize: () => {},
      rpc: { approve_review: {
        capabilities: { audit: true, transaction: true, idempotency: true },
        execute: async () => { rpcs++; throw new Error("rpc executed"); },
      } },
    },
    preview: () => ({
      command: "approve", allowed: false,
      blockers: [{ code: "CASE_FROZEN", message: "案件已冻结", correction: "解冻后再提交" }],
    }),
  });
  expect(blocked).toEqual({
    command: "approve", allowed: false,
    blockers: [{ code: "CASE_FROZEN", message: "案件已冻结", correction: "解冻后再提交" }],
  });
  expect(rpcs).toBe(0);
  expect(writes).toBe(0);
});

test("preview identity must match the compiled command", async () => {
  await expect(previewCompiledCommand({
    module, command: "Approve", input: 4,
    request: new Request("https://app.example/"), requestContext: { requestId: "r1" },
    governance: { authorize: () => {} },
    preview: () => ({ command: "other.command", allowed: true, blockers: [] }),
  })).rejects.toThrow("Mismatched command identity");
});
