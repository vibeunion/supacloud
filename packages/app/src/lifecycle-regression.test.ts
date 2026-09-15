import { describe, expect, it, spyOn } from "bun:test";
import { bootstrapBun, runInRequestContext, runInTransactionContext } from "./bun";
import { createEnvironmentInjector } from "./inject";
import { InjectionToken } from "./token";
import {
  provideAppInitializer,
  provideEnvironmentInitializer,
  provideLifecycle,
} from "./provider";

describe("application lifecycle regression", () => {
  it("runs root hooks once while initializing only locally registered scope hooks", async () => {
    const events: string[] = [];
    class RootService {
      onInit() { events.push("root-init"); }
      onDestroy() { events.push("root-destroy"); }
    }
    class LocalService {
      onInit() { events.push("local-init"); }
      onDestroy() { events.push("local-destroy"); }
    }
    const root = createEnvironmentInjector([
      RootService,
      provideLifecycle(RootService),
      provideEnvironmentInitializer(() => { events.push("root-env"); }),
      provideAppInitializer(() => { events.push("root-app"); }),
    ], undefined, { initialize: false });
    try {
      await root.initialize();
      await Promise.all([
        runInRequestContext(root, [], async () => { await Promise.resolve(); }),
        runInRequestContext(root, [], async () => { await Promise.resolve(); }),
      ]);
      await runInTransactionContext(root, [
        LocalService,
        provideLifecycle(LocalService),
        provideEnvironmentInitializer(() => { events.push("local-env"); }),
        provideAppInitializer(() => { events.push("local-app"); }),
      ], () => { events.push("work"); });
      expect(events).toEqual([
        "root-env", "root-app", "root-init",
        "local-env", "local-app", "local-init", "work", "local-destroy",
      ]);
    } finally {
      await root.destroyAsync();
    }
    expect(events.at(-1)).toBe("root-destroy");
  });

  it("reports eager initialization failure and does not retry partial startup", async () => {
    const failure = new Error("startup failed");
    const report = spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    const root = createEnvironmentInjector([
      provideAppInitializer(() => {
        attempts += 1;
        throw failure;
      }),
    ]);
    try {
      await expect(root.initialize()).rejects.toBe(failure);
      await expect(root.initialize()).rejects.toBe(failure);
      expect(root.initialized).toBe(false);
      expect(attempts).toBe(1);
      expect(report).toHaveBeenCalledWith(
        "EnvironmentInjector initialization failed", failure,
      );
    } finally {
      report.mockRestore();
      await root.destroyAsync();
    }
  });

  it("retains asynchronous failures without rerunning earlier initializers", async () => {
    const failure = new Error("async startup failed");
    let attempts = 0;
    const root = createEnvironmentInjector([
      provideAppInitializer(() => { attempts += 1; }),
      provideAppInitializer(async () => {
        await Promise.resolve();
        throw failure;
      }),
    ], undefined, { initialize: false });
    try {
      await expect(root.initialize()).rejects.toBe(failure);
      await expect(root.initialize()).rejects.toBe(failure);
      expect(attempts).toBe(1);
      expect(root.initialized).toBe(false);
    } finally {
      await root.destroyAsync();
    }
  });

  it("never serves after startup failure and cleans up initialized services", async () => {
    const failure = new Error("not ready");
    let served = false;
    let destroyed = false;
    class Service {
      onInit() { throw failure; }
      onDestroy() { destroyed = true; }
    }
    await expect(bootstrapBun({
      providers: [Service, provideLifecycle(Service)],
      installSignalHandlers: false,
      serve: () => {
        served = true;
        return { stop() {} };
      },
    })).rejects.toBe(failure);
    expect(served).toBe(false);
    expect(destroyed).toBe(true);
  });

  it("cleans up exactly once when server shutdown fails", async () => {
    const failure = new Error("server stop failed");
    let stops = 0;
    let destroys = 0;
    const service = new InjectionToken<Service>("service");
    class Service {
      async onDestroy() {
        await Promise.resolve();
        destroys += 1;
      }
    }
    const app = await bootstrapBun({
      providers: [{ provide: service, useClass: Service }, provideLifecycle(service)],
      installSignalHandlers: false,
      serve: () => ({
        async stop() {
          stops += 1;
          throw failure;
        },
      }),
    });
    await expect(app.stop()).rejects.toBe(failure);
    await expect(app.stop()).rejects.toBe(failure);
    expect(stops).toBe(1);
    expect(destroys).toBe(1);
    expect(app.injector.destroyed).toBe(true);
  });

  it("preserves both server and injector shutdown errors", async () => {
    const serverFailure = new Error("server stop failed");
    const hookFailure = new Error("hook failed");
    class Service {
      onDestroy() { throw hookFailure; }
    }
    const app = await bootstrapBun({
      providers: [Service, provideLifecycle(Service)],
      installSignalHandlers: false,
      serve: () => ({ stop() { throw serverFailure; } }),
    });
    const error: unknown = await app.stop().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected shutdown errors");
    expect(error.errors[0]).toBe(serverFailure);
    expect(error.errors[1]).toBeInstanceOf(AggregateError);
    expect(app.injector.destroyed).toBe(true);
  });
});
