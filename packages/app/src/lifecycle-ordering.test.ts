import { describe, expect, it, spyOn } from "bun:test";
import { bootstrapBun, runInRequestContext, runInTransactionContext } from "./bun";
import { DESTROY_REF } from "./context";
import { createEnvironmentInjector } from "./inject";
import { provideLifecycle } from "./provider";
import { InjectionToken } from "./token";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function expectFailures(error: unknown, primary: unknown, cleanup: unknown): void {
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error("Expected combined failures");
  expect(error.cause).toBe(primary);
  expect(error.errors[0]).toBe(primary);
  const nested: unknown = error.errors[1];
  expect(nested).toBeInstanceOf(AggregateError);
  if (!(nested instanceof AggregateError)) throw new Error("Expected injector failure");
  expect(nested.errors).toEqual([cleanup]);
}

describe("Aponia-inspired lifecycle behavior on the existing runtime API", () => {
  it("initializes and destroys one shared instance once across lifecycle aliases", async () => {
    const events: string[] = [];
    class Service {
      onInit() { events.push("init"); }
      onDestroy() { events.push("destroy"); }
    }
    const alias = new InjectionToken<Service>("alias");
    const root = createEnvironmentInjector([
      Service,
      { provide: alias, useExisting: Service },
      provideLifecycle(Service),
      provideLifecycle(alias),
      provideLifecycle(Service),
    ], undefined, { initialize: false });
    try {
      await root.initialize();
      expect(events).toEqual(["init"]);
    } finally {
      await root.destroyAsync();
    }
    expect(events).toEqual(["init", "destroy"]);
  });

  it("awaits a dependent's asynchronous cleanup before releasing its dependency", async () => {
    const events: string[] = [];
    const entered = deferred();
    const release = deferred();
    class Pool {
      onDestroy() { events.push("pool"); }
    }
    class Service {
      constructor(readonly pool: Pool) {}
      async onDestroy() {
        events.push("service:start");
        entered.resolve();
        await release.promise;
        events.push("service:end");
      }
    }
    const root = createEnvironmentInjector([
      Pool,
      { provide: Service, useClass: Service, deps: [Pool] },
      provideLifecycle(Service),
    ], undefined, { initialize: false });
    await root.initialize();
    const stopping = root.destroyAsync();
    try {
      await entered.promise;
      expect(events).toEqual(["service:start"]);
    } finally {
      release.resolve();
      await stopping;
    }
    expect(events).toEqual(["service:start", "service:end", "pool"]);
  });

  it("continues reverse cleanup after a rejected hook", async () => {
    const failure = new Error("service cleanup");
    const events: string[] = [];
    class Pool {
      onDestroy() { events.push("pool"); }
    }
    class Service {
      constructor(readonly pool: Pool) {}
      async onDestroy() { events.push("service"); throw failure; }
    }
    const root = createEnvironmentInjector([
      Pool,
      { provide: Service, useClass: Service, deps: [Pool] },
      provideLifecycle(Service),
    ], undefined, { initialize: false });
    await root.initialize();
    const error: unknown = await root.destroyAsync().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected cleanup failure");
    expect(error.errors).toEqual([failure]);
    expect(events).toEqual(["service", "pool"]);
  });

  it("contains throwing hook accessors and still releases other instances", async () => {
    const failure = new Error("hook accessor");
    let released = false;
    class Pool {
      onDestroy() { released = true; }
    }
    class Service {
      constructor(readonly pool: Pool) {}
      get onDestroy(): () => void { throw failure; }
    }
    const root = createEnvironmentInjector([
      Pool,
      { provide: Service, useClass: Service, deps: [Pool] },
    ], undefined, { initialize: false });
    await root.initialize();
    root.get(Service);
    const error: unknown = await root.destroyAsync().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected cleanup failure");
    expect(error.errors).toEqual([failure]);
    expect(released).toBe(true);
  });

  it("joins fire-and-forget reentrant injector destruction without releasing twice", async () => {
    let calls = 0;
    let joined: Promise<void> | undefined;
    class Service {
      onDestroy() {
        calls++;
        if (calls === 1) joined = root.destroyAsync();
      }
    }
    const root = createEnvironmentInjector([
      Service, provideLifecycle(Service),
    ], undefined, { initialize: false });
    await root.initialize();
    const stopping = root.destroyAsync();
    await stopping;
    expect(joined).toBe(stopping);
    expect(root.destroyAsync()).toBe(stopping);
    expect(calls).toBe(1);
  });

  it("joins fire-and-forget reentrant server shutdown without stopping twice", async () => {
    let stops = 0;
    let joined: Promise<void> | undefined;
    const app = await bootstrapBun({
      providers: [],
      installSignalHandlers: false,
      serve: () => ({
        stop() {
          stops++;
          if (stops === 1) joined = app.stop();
        },
      }),
    });
    const stopping = app.stop();
    await stopping;
    expect(joined).toBe(stopping);
    expect(app.stop()).toBe(stopping);
    expect(stops).toBe(1);
  });

  it("closes an initialized application that never listened", async () => {
    let destroyed = 0;
    class Service {
      onDestroy() { destroyed++; }
    }
    const app = await bootstrapBun({
      providers: [Service, provideLifecycle(Service)],
      installSignalHandlers: false,
    });
    expect(app.server).toBeUndefined();
    await Promise.all([app.stop(), app.stop()]);
    expect(destroyed).toBe(1);
  });

  it("retains startup and cleanup failures without serving", async () => {
    const primary = new Error("initialization");
    const cleanup = new Error("cleanup");
    let served = false;
    class Service {
      onInit() { throw primary; }
      onDestroy() { throw cleanup; }
    }
    const error: unknown = await bootstrapBun({
      providers: [Service, provideLifecycle(Service)],
      installSignalHandlers: false,
      serve: () => { served = true; return { stop() {} }; },
    }).catch((reason: unknown) => reason);
    expectFailures(error, primary, cleanup);
    expect(served).toBe(false);
  });

  it("retains serve failure and releases the already initialized resources", async () => {
    const primary = new Error("listen failed");
    const cleanup = new Error("cleanup");
    class Service {
      onDestroy() { throw cleanup; }
    }
    const error: unknown = await bootstrapBun({
      providers: [Service, provideLifecycle(Service)],
      installSignalHandlers: false,
      serve: () => { throw primary; },
    }).catch((reason: unknown) => reason);
    expectFailures(error, primary, cleanup);
  });

  for (const [name, run] of [
    ["request", runInRequestContext],
    ["transaction", runInTransactionContext],
  ] as const) {
    it(`keeps ${name} work failure and cleanup failure without destroying the parent`, async () => {
      const primary = new Error("work");
      const cleanup = new Error("cleanup");
      let rootDestroyed = false;
      class RootService {
        onDestroy() { rootDestroyed = true; }
      }
      class ScopedService {
        onDestroy() { throw cleanup; }
      }
      const root = createEnvironmentInjector([
        RootService, provideLifecycle(RootService),
      ], undefined, { initialize: false });
      try {
        await root.initialize();
        const error: unknown = await run(root, [ScopedService, provideLifecycle(ScopedService)], async () => {
          throw primary;
        }).catch((reason: unknown) => reason);
        expectFailures(error, primary, cleanup);
        expect(rootDestroyed).toBe(false);
        expect(root.destroyed).toBe(false);
      } finally {
        await root.destroyAsync();
      }
      expect(rootDestroyed).toBe(true);
    });
  }

  it("does not adopt an externally supplied onDestroy resource on a plain read", async () => {
    let releases = 0;
    const borrowed = { onDestroy() { releases++; } };
    const token = new InjectionToken<typeof borrowed>("borrowed");
    const root = createEnvironmentInjector([
      { provide: token, useValue: borrowed },
    ], undefined, { initialize: false });
    try {
      await root.initialize();
      expect(root.get(token)).toBe(borrowed);
      await runInRequestContext(root, [], (scope) => { expect(scope.get(token)).toBe(borrowed); });
    } finally {
      await root.destroyAsync();
    }
    expect(releases).toBe(0);
  });

  it("aborts the existing destroy signal synchronously", async () => {
    const root = createEnvironmentInjector([], undefined, { initialize: false });
    await root.initialize();
    const signal = root.get(DESTROY_REF).signal;
    root.destroy();
    expect(signal?.aborted).toBe(true);
    await root.destroyAsync();
  });

  for (const initialExitCode of [0, 17]) {
    it(`observes signal shutdown failure with initial exit code ${initialExitCode}`, async () => {
      // Invoke only this application's listener: never send a real process signal.
      const before = new Set(process.listeners("SIGTERM"));
      const exitCode = process.exitCode;
      const failure = new Error("secret connection details");
      const report = spyOn(console, "error").mockImplementation(() => {});
      const app = await bootstrapBun({
        providers: [],
        serve: () => ({ stop() { throw failure; } }),
      });
      try {
        process.exitCode = initialExitCode;
        const listener = process.listeners("SIGTERM").find((entry) => !before.has(entry));
        if (!listener) throw new Error("Expected the application signal listener");
        l
istener("SIGTERM");        const error: unknown = await app.stop().catch((reason: unknown) => reason);
        expect(error).toBe(failure);
        expect(process.exitCode).toBe(initialExitCode || 1);
        expect(report).toHaveBeenCalledTimes(1);
        expect(report).toHaveBeenCalledWith("Bun application shutdown failed; await app.stop() for the error.");
        expect(process.listeners("SIGTERM").filter((entry) => !before.has(entry))).toEqual([]);
      } finally {
        await app.stop().catch(() => undefined);
        process.exitCode = exitCode;
        report.mockRestore();
      }
    });
  }
});
