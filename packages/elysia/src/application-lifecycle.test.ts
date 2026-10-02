import { describe, expect, test } from "bun:test";
import { createApplication, type CompiledModule } from "./index";

function lifecycleModule(
  name: string,
  events: string[],
  options: { initError?: Error; destroyError?: Error } = {},
): CompiledModule {
  const service = {};
  return {
    name,
    createServices: () => ({ service }),
    initializeServices: async () => {
      events.push(`${name}:init`);
      if (options.initError) throw options.initError;
    },
    destroyServices: async () => {
      events.push(`${name}:destroy`);
      if (options.destroyError) throw options.destroyError;
    },
    controllers: [],
    commands: [],
    jobs: [],
  };
}

describe("application lifecycle controls", () => {
  test("initializes in module order and destroys in reverse order exactly once", async () => {
    const events: string[] = [];
    const app = createApplication({
      modules: [lifecycleModule("dependency", events), lifecycleModule("consumer", events)],
    });

    expect(app.initialized).toBe(false);
    expect(app.destroyed).toBe(false);
    await Promise.all([app.initialize(), app.initialize()]);
    expect(events).toEqual(["dependency:init", "consumer:init"]);
    expect(app.initialized).toBe(true);

    await Promise.all([app.destroy(), app.destroy()]);
    expect(events).toEqual([
      "dependency:init", "consumer:init", "consumer:destroy", "dependency:destroy",
    ]);
    expect(app.destroyed).toBe(true);
  });

  test("rolls back already initialized modules when startup fails", async () => {
    const events: string[] = [];
    const failure = new Error("consumer unavailable");
    const app = createApplication({
      modules: [
        lifecycleModule("dependency", events),
        lifecycleModule("consumer", events, { initError: failure }),
      ],
    });

    await expect(app.initialize()).rejects.toBe(failure);
    expect(events).toEqual([
      "dependency:init", "consumer:init", "consumer:destroy", "dependency:destroy",
    ]);
    expect(app.initialized).toBe(false);
    expect(app.destroyed).toBe(true);
  });

  test("preserves all shutdown failures and rejects use after destroy", async () => {
    const events: string[] = [];
    const first = new Error("consumer close failed");
    const second = new Error("dependency close failed");
    const app = createApplication({
      modules: [
        lifecycleModule("dependency", events, { destroyError: second }),
        lifecycleModule("consumer", events, { destroyError: first }),
      ],
    });

    await expect(app.destroy()).rejects.toBeInstanceOf(AggregateError);
    const shutdown = await app.destroy().catch((error: unknown) => error);
    expect(shutdown).toBeInstanceOf(AggregateError);
    if (!(shutdown instanceof AggregateError)) throw new Error("Expected shutdown AggregateError");
    expect(shutdown.errors).toHaveLength(2);
    await expect(app.initialize()).rejects.toThrow("already been destroyed");
  });
});
