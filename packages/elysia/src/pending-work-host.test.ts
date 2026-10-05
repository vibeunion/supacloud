import { expect, test } from "bun:test";
import { createApplication, createWorker, type CompiledModule } from "./index";
import { PendingWorkRegistry, PendingWorkTimeoutError, PendingWorkCapacityError } from "@supacloud/app/runtime";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function moduleFor(run: () => Promise<unknown>, cleanup: () => Promise<void> = async () => {}): CompiledModule {
  return { name: "pending", createServices: () => ({ controller: { run } }),
    createRequestScope: () => ({}), destroyRequestScope: cleanup,
    controllers: [{ path: "/work", serviceKey: "controller", scope: "application",
      routes: [{ method: "GET", path: "/", handler: "run" }] }] };
}

test("registry capacity has a typed error without changing validation or losing admitted work", async () => {
  const registry = new PendingWorkRegistry({ capacity: 1 });
  const work = { name: "test.work", kind: "job" } as const;
  const complete = registry.add(work);
  try {
    expect(() => registry.add(work)).toThrow(PendingWorkCapacityError);
    expect(() => registry.add(work)).toThrow(RangeError);
    expect(new PendingWorkCapacityError().code).toBe("PENDING_WORK_CAPACITY_EXCEEDED");
    let started = false;
    await expect(registry.run(work, () => { started = true; })).rejects.toBeInstanceOf(PendingWorkCapacityError);
    expect(started).toBe(false);
    expect(registry.snapshot()).toHaveLength(1);
    expect(registry.closed).toBe(false);
    expect(registry.signal.aborted).toBe(false);
    expect(() => new PendingWorkRegistry({ capacity: 0 })).toThrow(RangeError);
    expect(() => registry.add({ ...work, name: "" })).toThrow(TypeError);
  } finally {
    complete();
  }
  expect(await registry.run(work, () => 42)).toBe(42);
  expect(registry.snapshot()).toEqual([]);
});

test("overloaded requests return 503 before context or handler execution and recover after drain", async () => {
  const entered = deferred(), release = deferred();
  let contexts = 0, handlers = 0;
  const signals: AbortSignal[] = [];
  const app = createApplication({
    pendingWork: { capacity: 1 },
    requestContext: (_request, _context, signal) => {
      contexts++;
      if (signal) signals.push(signal);
      return {};
    },
    modules: [moduleFor(async () => {
      handlers++;
      entered.resolve();
      await release.promise;
      return "done";
    })],
  });
  const first = app.handle(new Request("http://localhost/work"));
  try {
    await entered.promise;
    const admitted = app.pendingWork.snapshot().map(({ id, name, kind }) => ({ id, name, kind }));
    const rejected = await app.handle(new Request("http://localhost/work"));
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({
      ok: false,
      code: "PENDING_WORK_CAPACITY_EXCEEDED",
      message: "Application work capacity exceeded",
    });
    expect(contexts).toBe(1);
    expect(handlers).toBe(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(app.pendingWork.snapshot().map(({ id, name, kind }) => ({ id, name, kind }))).toEqual(admitted);
    await expect(app.waitForIdle({ timeoutMs: 0 })).rejects.toBeInstanceOf(PendingWorkTimeoutError);
    release.resolve();
    expect((await first).status).toBe(200);
    await app.waitForIdle();
    expect((await app.handle(new Request("http://localhost/work"))).status).toBe(200);
    expect(contexts).toBe(2);
    expect(handlers).toBe(2);
    expect(app.pendingWork.snapshot()).toEqual([]);
  } finally {
    release.resolve();
    await first;
    await app.destroy();
  }
});

test("capacity errors after admission remain internal errors, not retryable admission failures", async () => {
  for (const failContext of [true, false]) {
    const app = createApplication({
      modules: [moduleFor(async () => { throw new PendingWorkCapacityError(); })],
      requestContext: () => { if (failContext) throw new PendingWorkCapacityError(); return {}; },
    });
    try {
      const response = await app.handle(new Request("http://localhost/work"));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, code: "INTERNAL_ERROR", message: "Internal Server Error" });
      expect(app.pendingWork.snapshot()).toEqual([]);
    } finally {
      await app.destroy();
    }
  }
});

test("custom error mappers retain precedence for admission capacity errors", async () => {
  let mapped = false;
  const app = createApplication({
    pendingWork: { capacity: 1 },
    modules: [moduleFor(async () => { throw new Error("Unexpected handler execution"); })],
    requestContext: () => { throw new Error("Unexpected context execution"); },
    errorMapper: (error, context) => {
      mapped = true;
      expect(error).toMatchObject({ code: "PENDING_WORK_CAPACITY_EXCEEDED", status: 503 });
      expect(context.requestContext).toBeUndefined();
      return Response.json({ code: "CUSTOM_OVERLOAD" }, { status: 503 });
    },
  });
  const complete = app.pendingWork.add({ name: "test.busy", kind: "job" });
  try {
    const response = await app.handle(new Request("http://localhost/work"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "CUSTOM_OVERLOAD" });
    expect(mapped).toBe(true);
    expect(app.pendingWork.snapshot()).toHaveLength(1);
  } finally {
    complete();
    await app.destroy();
  }
});

test("request context, handler and scope cleanup remain registered until completed", async () => {
  const entered = deferred(), release = deferred(), cleaning = deferred(), cleaned = deferred();
  const app = createApplication({ modules: [moduleFor(async () => { entered.resolve(); await release.promise; return "done"; },
    async () => { cleaning.resolve(); await cleaned.promise; })] });
  const other = createApplication({ modules: [] });
  const response = app.handle(new Request("http://localhost/work"));
  await entered.promise;
  expect(app.pendingWork.snapshot().map(work => work.kind)).toEqual(["request"]);
  expect(other.pendingWork.snapshot()).toEqual([]);
  release.resolve();
  await cleaning.promise;
  await expect(app.waitForIdle({ timeoutMs: 0 })).rejects.toBeInstanceOf(PendingWorkTimeoutError);
  cleaned.resolve(); await response; await app.waitForIdle(); await app.destroy();
});

test("context errors and handler errors release request accounting", async () => {
  for (const failContext of [true, false]) {
    const app = createApplication({ modules: [moduleFor(async () => { throw new Error("handler"); })],
      requestContext: () => { if (failContext) throw new Error("context"); return {}; } });
    expect((await app.handle(new Request("http://localhost/work"))).status).toBe(500);
    await app.waitForIdle();
    expect(app.pendingWork.snapshot()).toEqual([]);
    await app.destroy();
  }
});

test("shutdown cancels context work, rejects new requests and preserves resources on timeout", async () => {
  const entered = deferred(), release = deferred();
  let signal: AbortSignal | undefined, destroyed = 0;
  const module = moduleFor(async () => { entered.resolve(); await release.promise; return "done"; });
  module.destroyServices = async () => { destroyed++; };
  const app = createApplication({ modules: [module], pendingWork: { shutdownTimeoutMs: 0 },
    requestContext: (_request, _context, cancellation) => { signal = cancellation; return {}; } });
  const response = app.handle(new Request("http://localhost/work"));
  await entered.promise;
  await expect(app.destroy()).rejects.toBeInstanceOf(PendingWorkTimeoutError);
  expect(signal?.aborted).toBe(true);
  expect(destroyed).toBe(0);
  expect(app.pendingWork.snapshot()).toHaveLength(1);
  expect((await app.handle(new Request("http://localhost/work"))).status).toBe(503);
  release.resolve(); await response; await app.waitForIdle(); await app.destroy();
  expect(destroyed).toBe(1);
});

test("request disconnect reaches only that request's cancellation signal", async () => {
  const a = new AbortController(), started = deferred(), release = deferred();
  const signals: AbortSignal[] = [];
  const app = createApplication({ modules: [moduleFor(async () => { started.resolve(); await release.promise; return "ok"; })],
    requestContext: (_request, _ctx, signal) => { if (!signal) throw new Error("Missing host signal"); signals.push(signal); return {}; } });
  const request = app.handle(new Request("http://localhost/work", { signal: a.signal }));
  await started.promise; a.abort();
  expect(signals[0]?.aborted).toBe(true);
  expect(app.pendingWork.signal.aborted).toBe(false);
  release.resolve(); await request; await app.waitForIdle(); await app.destroy();
});

test("worker counts direct claims through receipt confirmation and safely retries drain", async () => {
  const entered = deferred(), release = deferred();
  let cancellation: AbortSignal | undefined, destroyed = 0, acknowledgements = 0;
  const worker = createWorker<{ id: string; jobName: string; input: unknown }, string>({ shutdownTimeoutMs: 0,
    modules: [{ name: "jobs", createServices: () => ({ job: { run: async () => {
      entered.resolve(); await release.promise; return 7;
    } } }), controllers: [], jobs: [{ name: "test", className: "Job", serviceKey: "job", scope: "application" }] }],
    requestContext: (_claim, signal) => { cancellation = signal; return { signal }; },
    destroyServices: () => { destroyed++; },
    transport: { claim: async () => null, ack: async () => { acknowledgements++; return "receipt"; }, fail: async () => "failure" } });
  await worker.start();
  const result = worker.processClaim({ id: "1", jobName: "test", input: {} });
  await entered.promise;
  await expect(worker.stop()).rejects.toBeInstanceOf(PendingWorkTimeoutError);
  expect(cancellation?.aborted).toBe(true); expect(destroyed).toBe(0);
  expect(worker.pendingWork.snapshot().some(work => work.name === "worker.job")).toBe(true);
  release.resolve(); expect((await result).receipt).toBe("receipt");
  await worker.stop(); expect(destroyed).toBe(1); expect(acknowledgements).toBe(1);
  expect(worker.pendingWork.snapshot()).toEqual([]);
});

test("shutdown publishes its completion before cancellation listeners can reenter", async () => {
  let destroyed = 0, nested: Promise<void> | undefined;
  const app = createApplication({ modules: [{ name: "reentrant", createServices: () => ({}),
    controllers: [], destroyServices: async () => { destroyed++; } }] });
  app.pendingWork.signal.addEventListener("abort", () => { nested = app.destroy(); });
  const shutdown = app.destroy();
  await shutdown; await nested;
  expect(nested).toBe(shutdown); expect(destroyed).toBe(1);

  let released = 0, stopped: Promise<void> | undefined;
  const worker = createWorker({ modules: [{ name: "reentrant", createServices: () => ({ value: {} }), controllers: [] }],
    destroyServices: () => { released++; },
    transport: { claim: async () => null, ack: async () => null, fail: async () => null } });
  await worker.start();
  worker.pendingWork.signal.addEventListener("abort", () => { stopped = worker.stop(); });
  await worker.stop(); await stopped;
  expect(released).toBe(1); expect(worker.state).toBe("stopped");
});
