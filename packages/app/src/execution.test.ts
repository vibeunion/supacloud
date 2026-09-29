import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  composeAspects, composeExecution, createCommandPipeline, ExecutionPipelineError,
  executionRequestId, observeExecution,
  type CommandPipelineGovernance, type CommandPipelineInvocation,
  type ExecutionEvent, type ExecutionNext,
} from "./execution";
import type { CommandRuntimeGovernance, CommandRuntimeInvocation, CommandRuntimeMiddleware } from "./command_runtime";

const invocation = (command: Partial<CommandPipelineInvocation["command"]> = {}): CommandPipelineInvocation => ({
  command: { name: "update", permission: "orders:write", ...command },
  input: { body: { value: 1 }, params: {}, query: {} },
  requestContext: { projectRef: "project-a", requestId: "request-a" },
  services: {},
});
const code = (expected: string) => (error: unknown) => error instanceof ExecutionPipelineError && error.code === expected;

// Existing HTTP governance ports remain assignable without casts or widening.
function acceptsExistingPorts(governance: CommandRuntimeGovernance): CommandRuntimeMiddleware {
  return createCommandPipeline<CommandRuntimeInvocation>(governance);
}
void acceptsExistingPorts;

describe("portable execution composition", () => {
  test("deterministic onion order and typed return transformation", async () => {
    const trace: string[] = [];
    const run = composeExecution<string, number>(
      async (context, next) => { trace.push(`${context}:outer`); const value = await next(); trace.push("outer:end"); return value + 1; },
      async (_context, next) => { trace.push("inner"); const value = await next(); trace.push("inner:end"); return value * 2; },
    );
    assert.equal(await run("a", () => { trace.push("handler"); return 3; }), 7);
    assert.deepEqual(trace, ["a:outer", "inner", "handler", "inner:end", "outer:end"]);
  });

  test("short circuit never reaches the handler", async () => {
    assert.equal(await composeExecution<null, number>(() => 4)(null, () => { throw new Error("unreachable"); }), 4);
  });

  test("synchronous errors become rejections, including the empty pipeline", async () => {
    const failure = new Error("business");
    await assert.rejects(Promise.resolve(composeExecution()({}, () => { throw failure; })), error => error === failure);
    await assert.rejects(Promise.resolve(composeExecution<unknown, number>(() => { throw failure; })({}, () => 1)), error => error === failure);
  });

  test("an awaited failure can be recovered explicitly", async () => {
    const run = composeExecution<null, number>(async (_context, next) => {
      try { return await next(); } catch { return 5; }
    });
    assert.equal(await run(null, () => { throw new Error("expected"); }), 5);
  });

  test("next is single-use even when called concurrently", async () => {
    let calls = 0;
    const run = composeExecution(async (_context, next) => {
      const first = next();
      await assert.rejects(Promise.resolve(next()), code("EXECUTION_CONTINUATION_REUSED"));
      return await first;
    });
    assert.equal(await run({}, () => ++calls), 1);
    assert.equal(calls, 1);
  });

  test("captured next is closed after a short circuit", async () => {
    let saved: ExecutionNext | undefined;
    let calls = 0;
    const run = composeExecution((_context, next) => { saved = next; return "cached"; });
    assert.equal(await run({}, () => ++calls), "cached");
    assert.ok(saved);
    await assert.rejects(Promise.resolve(saved()), code("EXECUTION_CONTINUATION_CLOSED"));
    assert.equal(calls, 0);
  });

  test("inner next closes even while an outer middleware remains active", async () => {
    let saved: ExecutionNext | undefined;
    const run = composeExecution(
      async (_context, next) => {
        const value = await next();
        assert.ok(saved);
        await assert.rejects(Promise.resolve(saved()), code("EXECUTION_CONTINUATION_CLOSED"));
        return value;
      },
      (_context, next) => { saved = next; return 2; },
    );
    assert.equal(await run({}, () => { throw new Error("unreachable"); }), 2);
  });

  test("detached work is drained before reporting an unawaited continuation", async () => {
    let release!: () => void;
    let finished = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const run = composeExecution((_context, next) => { void next(); return 0; });
    const result = Promise.resolve(run({}, async () => { await gate; finished = true; return 1; }));
    const rejection = assert.rejects(result, code("EXECUTION_CONTINUATION_UNAWAITED"));
    await Promise.resolve();
    assert.equal(finished, false);
    release();
    await rejection;
    assert.equal(finished, true);
  });

  test("parallel invocations do not share continuation state", async () => {
    const run = composeExecution<number, number>(async (context, next) => context + await next());
    assert.deepEqual(await Promise.all([run(1, async () => 10), run(2, async () => 20)]), [11, 22]);
  });

  test("invalid middleware fails at construction instead of silently disappearing", () => {
    // @ts-expect-error JavaScript consumers can pass invalid values.
    assert.throws(() => composeExecution(undefined), TypeError);
  });

  for (const kind of ["route", "command", "job"] as const) {
    test(`existing AspectContext works for ${kind} without a Request`, async () => {
      const run = composeAspects(async (context, next) => {
        assert.equal(context.kind, kind);
        assert.equal(context.request, undefined);
        return await next();
      });
      assert.equal(await run({ kind, name: "portable", input: 1 }, () => 2), 2);
    });
  }
});

describe("portable command governance", () => {
  test("authorization encloses receipt, transaction, success audit and handler", async () => {
    const trace: string[] = [];
    const run = createCommandPipeline({
      authorize: () => { trace.push("authorize"); },
      idempotency: async (_context, next) => { trace.push("receipt:lookup"); const value = await next(); trace.push("receipt:store"); return value; },
      transaction: async (_context, next) => { trace.push("begin"); const value = await next(); trace.push("commit"); return value; },
      audit: { succeeded: () => { trace.push("audit:success"); }, failed: () => { trace.push("audit:failed"); } },
    });
    assert.equal(await run(invocation({ transaction: "required", idempotency: "required", audit: "update" }), () => {
      trace.push("handler"); return 7;
    }), 7);
    assert.deepEqual(trace, ["authorize", "receipt:lookup", "begin", "handler", "audit:success", "commit", "receipt:store"]);
  });

  test("a denied project never reaches aspects, transaction or a cached receipt", async () => {
    let entered = false;
    const denied = new Error("project mismatch");
    const run = createCommandPipeline({
      authorize: () => { throw denied; },
      idempotency: () => { entered = true; return "cached"; },
      transaction: (_context, next) => { entered = true; return next(); },
    });
    await assert.rejects(Promise.resolve(run(invocation({ transaction: "required", idempotency: "required" }), () => { entered = true; })), error => error === denied);
    assert.equal(entered, false);
  });

  test("authorization runs again on a receipt replay", async () => {
    let checks = 0;
    let writes = 0;
    let cached: unknown;
    const run = createCommandPipeline({
      authorize: () => { checks++; },
      idempotency: async (_context, next) => cached ??= await next(),
    });
    const input = invocation({ idempotency: "required" });
    assert.equal(await run(input, () => ++writes), 1);
    assert.equal(await run(input, () => ++writes), 1);
    assert.equal(checks, 2);
    assert.equal(writes, 1);
  });

  test("required authorization fails at construction", () => {
    // @ts-expect-error Test malformed JavaScript configuration.
    assert.throws(() => createCommandPipeline({}), code("COMMAND_AUTHORIZATION_UNCONFIGURED"));
  });

  for (const required of ["transaction", "idempotency", "audit"] as const) {
    test(`missing required ${required} fails closed`, async () => {
      let calls = 0;
      const run = createCommandPipeline({ authorize: () => { calls++; } });
      await assert.rejects(Promise.resolve(run(invocation({ [required]: required === "audit" ? "change" : "required" }), () => { calls++; })), code(`COMMAND_${required.toUpperCase()}_UNAVAILABLE`));
      assert.equal(calls, 0);
    });
  }

  test("invalid governance modes fail before authorization", async () => {
    const run = createCommandPipeline({ authorize: () => { throw new Error("unreachable"); } });
    await assert.rejects(Promise.resolve(run(invocation({ transaction: "auto" }), () => 0)), code("COMMAND_MODE_INVALID"));
  });

  test("success audit is inside rollback and failure audit follows", async () => {
    const trace: string[] = [];
    const failure = new Error("audit unavailable");
    const run = createCommandPipeline({
      authorize: () => {},
      transaction: async (_context, next) => {
        trace.push("begin");
        try { const value = await next(); trace.push("commit"); return value; }
        catch (error) { trace.push("rollback"); throw error; }
      },
      audit: {
        succeeded: () => { trace.push("audit:success"); throw failure; },
        failed: (_context, error) => { assert.equal(error, failure); trace.push("audit:failed"); },
      },
    });
    await assert.rejects(Promise.resolve(run(invocation({ transaction: "required", audit: "change" }), () => { trace.push("handler"); })), error => error === failure);
    assert.deepEqual(trace, ["begin", "handler", "audit:success", "rollback", "audit:failed"]);
  });

  test("a failure-audit outage preserves the original failure and never retries", async () => {
    const business = new Error("business");
    const audit = new Error("audit");
    let writes = 0;
    const run = createCommandPipeline({
      authorize: () => {},
      audit: { succeeded: () => {}, failed: () => { throw audit; } },
    });
    await assert.rejects(Promise.resolve(run(invocation({ audit: "change" }), () => { writes++; throw business; })), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, business);
      assert.deepEqual(error.errors, [business, audit]);
      return true;
    });
    assert.equal(writes, 1);
  });

  test("transaction middleware cannot retry an external side effect with next", async () => {
    let writes = 0;
    const run = createCommandPipeline({
      authorize: () => {},
      transaction: async (_context, next) => { try { await next(); } catch {} return await next(); },
    });
    await assert.rejects(Promise.resolve(run(invocation({ transaction: "required" }), () => { writes++; throw new Error("unknown outcome"); })), code("EXECUTION_CONTINUATION_REUSED"));
    assert.equal(writes, 1);
  });

  test("a saved transaction continuation cannot run after scope completion", async () => {
    let saved: ExecutionNext | undefined;
    let writes = 0;
    const run = createCommandPipeline({ authorize: () => {}, transaction: (_context, next) => { saved = next; return "cached"; } });
    assert.equal(await run(invocation({ transaction: "required" }), () => ++writes), "cached");
    assert.ok(saved);
    await assert.rejects(Promise.resolve(saved()), code("EXECUTION_CONTINUATION_CLOSED"));
    assert.equal(writes, 0);
  });

  test("RPC capabilities are checked and its continuation is single-use", async () => {
    let calls = 0;
    const run = createCommandPipeline({
      authorize: () => {},
      rpc: { database: { capabilities: { transaction: true }, execute: async (_context, next) => {
        const result = await next();
        await assert.rejects(Promise.resolve(next()), code("EXECUTION_CONTINUATION_REUSED"));
        return result;
      } } },
    });
    assert.equal(await run(invocation({ rpc: "database", transaction: "required" }), () => ++calls), 1);
    await assert.rejects(Promise.resolve(run(invocation({ rpc: "database", audit: "change" }), () => ++calls)), code("COMMAND_AUDIT_UNAVAILABLE"));
    await assert.rejects(Promise.resolve(run(invocation({ rpc: "toString" }), () => ++calls)), code("COMMAND_RPC_UNAVAILABLE"));
    assert.equal(calls, 1);
  });

  test("optional none modes do not enable adapters", async () => {
    const unexpected = () => { throw new Error("unreachable"); };
    const run = createCommandPipeline({ authorize: () => {}, transaction: unexpected, idempotency: unexpected });
    assert.equal(await run(invocation({ transaction: "none", idempotency: "none" }), () => 3), 3);
  });

  test("governance middleware keeps its receiver", async () => {
    const governance: CommandPipelineGovernance & { value: string } = {
      value: "bound",
      authorize() { assert.equal(this.value, "bound"); },
      transaction(_context, next) { assert.equal(this.value, "bound"); return next(); },
    };
    assert.equal(await createCommandPipeline(governance)(invocation({ transaction: "required" }), () => 8), 8);
  });
});

describe("shared execution telemetry", () => {
  test("metadata is immutable and excludes bodies, identity and results", async () => {
    const events: Readonly<ExecutionEvent>[] = [];
    const run = createCommandPipeline({ authorize: () => {} }, event => { events.push(event); });
    assert.equal(await run(invocation(), () => "private-result"), "private-result");
    assert.deepEqual(events.map(event => `${event.stage}:${event.phase}`), ["authorize:started", "authorize:succeeded", "handler:started", "handler:succeeded"]);
    for (const event of events) {
      assert.ok(Object.isFrozen(event));
      assert.equal(event.requestId, "request-a");
      assert.equal("input" in event || "result" in event || "requestContext" in event || "error" in event, false);
    }
  });

  test("observer exceptions do not change results or the original error", async () => {
    const failure = new Error("business");
    const event = { kind: "job", operation: "work", stage: "handler" } as const;
    assert.equal(await observeExecution(() => { throw new Error("telemetry"); }, event, () => 4), 4);
    await assert.rejects(observeExecution(async () => { throw new Error("telemetry"); }, event, () => { throw failure; }), error => error === failure);
    assert.equal(executionRequestId({ requestId: "bad\nheader" }), undefined);
    assert.equal(executionRequestId({ requestId: "trace:1" }), "trace:1");
  });
});
