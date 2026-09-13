import { describe, expect, it } from "bun:test";
import {
  bootstrapBun,
  createEnvironmentInjector,
  InjectionToken,
  inject,
  provideLifecycle,
  provideToken,
  runInRequestContext,
  runInTransactionContext,
} from "./index";

describe("Bun application scopes", () => {
  it("awaits application initialization and asynchronous destruction", async () => {
    const events: string[] = [];
    const SERVICE = new InjectionToken<Service>("SERVICE");

    class Service {
      async onInit() {
        await Promise.resolve();
        events.push("init");
      }

      async onDestroy() {
        await Promise.resolve();
        events.push("destroy");
      }
    }

    const injector = createEnvironmentInjector([
      {
        provide: SERVICE,
        useClass: Service,
      },
      provideLifecycle(SERVICE),
    ], undefined, { initialize: false });

    expect(injector.initialized).toBe(false);
    await injector.initialize();
    expect(events).toEqual(["init"]);
    await injector.destroyAsync();
    expect(events).toEqual(["init", "destroy"]);
    expect(injector.destroyed).toBe(true);
  });

  it("creates isolated request and transaction child scopes", async () => {
    const VALUE = new InjectionToken<string>("VALUE");
    const root = createEnvironmentInjector([provideToken(VALUE, "root")]);

    try {
      const requestValue = await runInRequestContext(
        root,
        [provideToken(VALUE, "request")],
        async () => {
          await Promise.resolve();
          return inject(VALUE);
        },
      );
      const transactionValue = await runInTransactionContext(
        root,
        [provideToken(VALUE, "transaction")],
        async () => {
          await Promise.resolve();
          return inject(VALUE);
        },
      );

      expect(requestValue).toBe("request");
      expect(transactionValue).toBe("transaction");
      expect(root.get(VALUE)).toBe("root");
    } finally {
      await root.destroyAsync();
    }
  });

  it("bootstraps and stops a Bun server exactly once", async () => {
    const events: string[] = [];
    let stopped = 0;
    const app = await bootstrapBun({
      providers: [
        {
          provide: new InjectionToken<() => void>("HOOK"),
          useValue: () => events.push("ready"),
        },
      ],
      installSignalHandlers: false,
      serve: () => ({
        stop() {
          stopped += 1;
        },
      }),
    });

    await app.stop();
    await app.stop();
    expect(events).toEqual([]);
    expect(stopped).toBe(1);
    expect(app.injector.destroyed).toBe(true);
  });
});
