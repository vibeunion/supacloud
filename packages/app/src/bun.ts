import type { EnvironmentProviders, Provider } from "./provider";
import {
  createEnvironmentInjector,
  runInInjectionContext,
  type EnvironmentInjector,
  type InjectorLike,
} from "./inject";

export interface BunServerLike {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export interface BunBootstrapOptions {
  providers: Array<Provider | EnvironmentProviders>;
  parent?: InjectorLike;
  name?: string;
  serve?: (injector: EnvironmentInjector) => BunServerLike | Promise<BunServerLike>;
  installSignalHandlers?: boolean;
}

export interface BunApplication {
  readonly injector: EnvironmentInjector;
  readonly server?: BunServerLike;
  stop(): Promise<void>;
}

export async function bootstrapBun(options: BunBootstrapOptions): Promise<BunApplication> {
  const injector = createEnvironmentInjector(options.providers, options.parent, {
    initialize: false,
    name: options.name ?? "bun-root",
  });
  let server: BunServerLike | undefined;
  let stopPromise: Promise<void> | null = null;
  const signalHandlers: Array<["SIGINT" | "SIGTERM", () => void]> = [];

  const detachSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    signalHandlers.length = 0;
  };

  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      detachSignalHandlers();
      if (server) await server.stop(true);
      await injector.destroyAsync();
    })();
    return stopPromise;
  };

  try {
    await injector.initialize();
    server = options.serve ? await options.serve(injector) : undefined;

    if (options.installSignalHandlers ?? true) {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const handler = () => void stop();
        signalHandlers.push([signal, handler]);
        process.once(signal, handler);
      }
    }

    return {
      injector,
      ...(server ? { server } : {}),
      stop,
    };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

export async function runInScope<T>(
  parent: EnvironmentInjector,
  providers: Array<Provider | EnvironmentProviders>,
  work: (injector: EnvironmentInjector) => T | Promise<T>,
  name = "scope",
): Promise<T> {
  const injector = createEnvironmentInjector(providers, parent, {
    initialize: false,
    name,
  });

  try {
    await injector.initialize();
    return await runInInjectionContext(injector, () => work(injector));
  } finally {
    await injector.destroyAsync();
  }
}

export function runInRequestContext<T>(
  parent: EnvironmentInjector,
  providers: Array<Provider | EnvironmentProviders>,
  work: (injector: EnvironmentInjector) => T | Promise<T>,
): Promise<T> {
  return runInScope(parent, providers, work, "request");
}

export function runInTransactionContext<T>(
  parent: EnvironmentInjector,
  providers: Array<Provider | EnvironmentProviders>,
  work: (injector: EnvironmentInjector) => T | Promise<T>,
): Promise<T> {
  return runInScope(parent, providers, work, "transaction");
}
