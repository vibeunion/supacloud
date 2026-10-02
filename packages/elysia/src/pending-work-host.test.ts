import { expect, test } from "bun:test";
import { createApplication, createWorker, type CompiledModule } from "./index";
import { PendingWorkTimeoutError } from "@supacloud/app/runtime";

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
