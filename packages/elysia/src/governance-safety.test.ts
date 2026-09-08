import { expect, test } from "bun:test";
import { ApplicationError, createApplication, createCommandExecutor, executeJob, type CompiledModule, type CommandInvocation, type ExecutionEvent } from "./index";

const invocation: CommandInvocation = {
  command: { className: "Approve", name: "review.approve", permission: "review.approve", transaction: "required", idempotency: "required", audit: "review.approved" },
  input: { body: { secret: "never-log" }, params: {}, query: {} },
  request: new Request("https://example.test", { headers: { authorization: "Bearer never-log" } }),
  requestContext: {}, services: {},
};

test("transaction and idempotency adapters cannot invoke a business operation twice", async () => {
  for (const boundary of ["transaction", "idempotency"] as const) {
    let calls = 0;
    const duplicate = async (_inv: CommandInvocation, next: () => unknown | Promise<unknown>) => {
      await next();
      return next();
    };
    const executor = createCommandExecutor({
      authorize: () => {},
      transaction: (_inv, next) => next(),
      idempotency: (_inv, next) => next(),
      audit: { succeeded: () => {}, failed: () => {} },
      [boundary]: duplicate,
    });
    await expect(executor(invocation, () => { calls++; return "done"; }))
      .rejects.toMatchObject({ code: "COMMAND_CONTINUATION_REUSED" });
    expect(calls).toBe(1);
  }
});

test("trace shows exact governance order without credentials, input, results or error causes", async () => {
  const events: ExecutionEvent[] = [];
  const executor = createCommandExecutor({
    authorize: () => {},
    transaction: (_inv, next) => next(),
    idempotency: (_inv, next) => next(),
    audit: { succeeded: () => {}, failed: () => {} },
  }, (event) => { events.push(event); });
  await executor(invocation, () => ({ secret: "never-log" }));
  expect(events.filter((event) => event.phase === "started").map((event) => event.stage))
    .toEqual(["authorize", "idempotency", "transaction", "handler", "audit"]);
  expect(JSON.stringify(events)).not.toContain("never-log");
});

test("revocation rejects a cached replay before touching idempotency or business state", async () => {
  let allowed = true;
  let calls = 0;
  let replays = 0;
  const executor = createCommandExecutor({
    authorize: () => { if (!allowed) throw new ApplicationError("Denied", { status: 403 }); },
    idempotency: async (_inv, next) => { replays++; return calls ? "receipt" : next(); },
    transaction: (_inv, next) => next(),
    audit: { succeeded: () => {}, failed: () => {} },
  });
  await executor(invocation, () => { calls++; return "receipt"; });
  allowed = false;
  await expect(executor(invocation, () => { calls++; })).rejects.toMatchObject({ status: 403 });
  expect(calls).toBe(1);
  expect(replays).toBe(1);
});

test("telemetry failure cannot replace a successful business outcome", async () => {
  const executor = createCommandExecutor({
    authorize: () => {},
    transaction: (_inv, next) => next(),
    idempotency: (_inv, next) => next(),
    audit: { succeeded: () => {}, failed: () => {} },
  }, async () => { throw new Error("telemetry offline"); });
  expect(await executor(invocation, () => "receipt")).toBe("receipt");
});

test("HTTP aspect trace identifies rejection and cleanup without invoking the handler", async () => {
  let calls = 0;
  let destroyed = 0;
  const cleanup = Promise.withResolvers<void>();
  const events: ExecutionEvent[] = [];
  const module: CompiledModule = {
    name: "review",
    createServices: () => ({}),
    createRequestScope: () => ({ controller: { get: () => { calls++; return "receipt"; } } }),
    destroyRequestScope: async () => { destroyed++; cleanup.resolve(); },
    aspects: [function deny() { throw new ApplicationError("Denied", { status: 403 }); }],
    controllers: [{ path: "", serviceKey: "controller", scope: "request", routes: [{ method: "GET", path: "/review", handler: "get" }] }],
  };
  const app = createApplication({
    modules: [module], onExecution: (event) => { events.push(event); },
    requestContext: () => ({ requestId: "trace-1" }),
  });
  expect((await app.handle(new Request("https://example.test/review"))).status).toBe(403);
  await cleanup.promise;
  expect(calls).toBe(0);
  expect(destroyed).toBe(1);
  expect(events.map((event) => [event.stage, event.phase, event.requestId])).toEqual([
    ["module:review.aspect[0]:deny", "started", "trace-1"],
    ["module:review.aspect[0]:deny", "failed", "trace-1"],
  ]);
});

test("job executors cannot retry handlers implicitly and job scopes are always destroyed", async () => {
  let calls = 0;
  let destroyed = 0;
  const events: ExecutionEvent[] = [];
  const module: CompiledModule = {
    name: "jobs", createServices: () => ({}), controllers: [],
    createJobScope: () => ({ job: { run: () => { calls++; return "receipt"; } } }),
    destroyJobScope: async () => { destroyed++; },
  };
  await expect(executeJob(module, {}, {
    className: "Job", name: "rebuild", serviceKey: "job", scope: "job",
  }, {}, {}, {}, async (_inv, next) => { await next(); return next(); }, (event) => { events.push(event); }))
    .rejects.toMatchObject({ code: "COMMAND_CONTINUATION_REUSED" });
  expect(calls).toBe(1);
  expect(destroyed).toBe(1);
  expect(events.filter((event) => event.phase === "started").map((event) => event.stage)).toEqual(["jobExecutor", "handler"]);
});
