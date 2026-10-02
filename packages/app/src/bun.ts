import type { EnvironmentProviders, Provider } from "./provider";
import { withCleanup } from "./lifecycle-cleanup";
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

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    // Publish the promise before calling host code, which may request stop again.
    stopPromise = Promise.resolve().then(() => {
      detachSignalHandlers();
      return withCleanup(
        () => server?.stop(true),
        () => injector.destroyAsync(),
        "Bun application shutdown failed",
      );
    });
    return stopPromise;
  };

  try {
    await injector.initialize();
    server = options.serve ? await options.serve(injector) : undefined;

    if (options.installSignalHandlers ?? true) {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const handler = () => {
          void stop().catch(() => {
            // A signal has no caller to observe a rejection. Keep the failure
            // status, but do not print arbitrary resource errors or credentials.
            if (process.exitCode === undefined || Number(process.exitCode) === 0) {
              process.exitCode = 1;
            }
            console.error("Bun application shutdown failed; await app.stop() for the error.");
          });
        };
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
    return withCleanup(
      () => { throw error; },
      stop,
      "Bun application startup and cleanup failed",
    );
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

  return withCleanup(
    async () => {
      await injector.initialize();
      return runInInjectionContext(injector, () => work(injector));
    },
    () => injector.destroyAsync(),
    "Scoped work and cleanup failed",
  );
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
