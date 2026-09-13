import {
  assertInInjectionContext as angularAssertInInjectionContext,
  createEnvironmentInjector as angularCreateEnvironmentInjector,
  inject as angularInject,
  Injector as AngularInjector,
  runInInjectionContext as angularRunInInjectionContext,
  type EnvironmentInjector as AngularEnvironmentInjector,
  type InjectOptions,
  type Provider as AngularProvider,
} from "@angular/core";
import { AsyncLocalStorage } from "node:async_hooks";
import type { EnvironmentProviders, Provider, ProviderDep, ProviderDependency, Token, Type } from "./provider";
import { flattenProviders, isClassProvider, isFactoryProvider } from "./provider";
import {
  APP_INITIALIZER,
  APP_LIFECYCLE,
  createDestroyRef,
  DESTROY_REF,
  ENVIRONMENT_INITIALIZER,
  type LifecycleHooks,
} from "./context";
import {
  getInjectableMeta,
  getInjectParams,
  getOptionalParams,
  getSelfParams,
  getSkipSelfParams,
  getHostParams,
} from "./decorators";
import { resolveForwardRef } from "./forward_ref";
import { InjectionToken } from "./token";

export type InjectFlags = InjectOptions;

export interface InjectorLike {
  get<T>(token: Token<T>, options?: InjectFlags): T | undefined;
  get<T>(token: Token<T>, notFoundValue: T, options?: InjectFlags): T;
  readonly parent?: InjectorLike;
}

const injectorContext = new AsyncLocalStorage<InjectorLike>();
let currentInjector: InjectorLike | null = null;

export function getActiveInjector(): InjectorLike | null {
  return injectorContext.getStore() ?? currentInjector;
}

/**
 * Compatibility token backed by Angular's public Injector token.
 * The compiler does not use this token; it is provided for runtime/TestBed APIs.
 */
export const INJECTOR = new InjectionToken<InjectorLike>("supacloud.injector", {
  scope: "application",
  factory: () => adaptInjector(angularInject(AngularInjector)),
});

export function runInInjectionContext<R>(injector: InjectorLike, fn: () => R): R {
  const previous = currentInjector;
  currentInjector = injector;
  try {
    return injectorContext.run(
      injector,
      () => angularRunInInjectionContext(injector as AngularInjector, fn),
    );
  } finally {
    currentInjector = previous;
  }
}

/**
 * Angular is the source of truth for runtime injection semantics. This
 * wrapper keeps the SupaCloud error contract for calls outside a context.
 */
export function inject<T>(token: Token<T>, options?: InjectFlags & { optional?: false }): T;
export function inject<T>(token: Token<T>, options: InjectFlags | undefined): T | undefined;
export function inject<T>(token: Token<T>, options?: InjectFlags): T | undefined {
  try {
    const resolve = () => options === undefined
      ? angularInject(token as never)
      : angularInject(token as never, options);
    const activeInjector = getActiveInjector();
    const value = activeInjector
      ? angularRunInInjectionContext(activeInjector as AngularInjector, resolve)
      : resolve();
    if (value !== undefined && value !== null) return value as T;
    if (
      token instanceof InjectionToken &&
      token.factory &&
      !options?.self &&
      !options?.skipSelf
    ) {
      return token.factory() as T;
    }
    if (options?.optional) return undefined;
    throw new Error(`NullInjectorError: No provider for ${tokenToString(token)}`);
  } catch (error) {
    if (
      error instanceof Error &&
      /NG0201|No provider found/i.test(error.message) &&
      token instanceof InjectionToken &&
      token.factory &&
      !options?.self &&
      !options?.skipSelf
    ) {
      return token.factory() as T;
    }
    if (error instanceof Error && /NG0203|injection context/i.test(error.message)) {
      throw new Error(
        `inject() can only be used within an active injection context (constructor, factory, guard, or runInInjectionContext). Token: ${tokenToString(token)}`,
      );
    }
    if (error instanceof Error && /NG0201|No provider found/i.test(error.message)) {
      throw new Error(`NullInjectorError: No provider for ${tokenToString(token)}`);
    }
    throw error;
  }
}

export function injectAll<T>(token: Token<T>): T[] {
  const value = inject<T | T[]>(token, { optional: true });
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function createChildInjector(
  parent: InjectorLike,
  localProviders: Map<Token<unknown> | string, unknown> | Record<string, unknown> = new Map(),
): InjectorLike & { readonly parent: InjectorLike } {
  const entries = localProviders instanceof Map
    ? [...localProviders.entries()]
    : Object.entries(localProviders);
  const child = AngularInjector.create({
    parent: parent as AngularInjector,
    providers: entries.map(([token, value]) => ({ provide: token, useValue: value })),
  });
  return {
    parent,
    get<T>(token: Token<T>, notFoundOrOptions?: T | InjectFlags, maybeOptions?: InjectFlags): T | undefined {
      if (isInjectOptions(notFoundOrOptions)) {
        const value = child.get(token as never, undefined, notFoundOrOptions);
        return (value === null ? undefined : value) as T | undefined;
      }
      const value = child.get(token as never, notFoundOrOptions, maybeOptions);
      return (value === null ? undefined : value) as T | undefined;
    },
  };
}

export function assertInInjectionContext(fnName: string): void {
  if (getActiveInjector()) return;
  try {
    angularAssertInInjectionContext(() => undefined);
  } catch {
    throw new Error(`${fnName} must be called from an active injection context.`);
  }
}

export function injectDestroySignal(): AbortSignal {
  const ref = inject(DESTROY_REF);
  if (ref.signal) return ref.signal;
  throw new Error("Active DestroyRef does not provide an AbortSignal");
}

function tokenToString(token: Token<unknown>): string {
  if (typeof token === "string") return token;
  if (token instanceof InjectionToken) return token.toString();
  if (typeof token === "function") return token.name || "AnonymousClass";
  return String(token);
}

export interface EnvironmentInjector extends InjectorLike {
  get<T>(token: Token<T>, options?: InjectFlags & { optional?: false }): T;
  get<T>(token: Token<T>, options: InjectFlags | undefined): T | undefined;
  get<T>(token: Token<T>, notFoundValue: T, options?: InjectFlags): T;
  runInContext<R>(fn: () => R): R;
  initialize(): Promise<void>;
  destroy(): void;
  destroyAsync(): Promise<void>;
  readonly initialized: boolean;
  readonly destroyed: boolean;
  readonly parent?: InjectorLike;
}

export interface EnvironmentInjectorOptions {
  /** Keep compatibility with the existing eager initializer behavior. */
  initialize?: boolean;
  name?: string;
}

/**
 * Runtime compatibility adapter over Angular's public EnvironmentInjector.
 * SupaCloud EnvironmentProviders are flattened before crossing the boundary;
 * no Angular private API is referenced.
 */
export function createEnvironmentInjector(
  providers: Array<Provider | EnvironmentProviders>,
  parent?: InjectorLike,
  options: EnvironmentInjectorOptions = {},
): EnvironmentInjector {
  let adapter: EnvironmentInjector;
  const destroyRef = createDestroyRef();
  const trackedInstances: unknown[] = [];
  const track = (value: unknown): unknown => {
    if (value && typeof value === "object" && !trackedInstances.includes(value)) {
      trackedInstances.push(value);
    }
    return value;
  };
  const instantiate = (type: Type<unknown>, explicitDeps?: unknown[]): unknown => {
    const dependencies = explicitDeps ?? resolveClassDependencies(type);
    return track(new type(...dependencies));
  };
  const normalizedProviders: AngularProvider[] = flattenProviders(providers).map((provider) => {
    if (typeof provider === "function") {
      const type = resolveForwardRef(provider);
      return {
        provide: type,
        useFactory: () => instantiate(type as Type<unknown>),
      };
    }
    if (isClassProvider(provider)) {
      const type = resolveForwardRef(provider.useClass) as Type<unknown>;
      const dependencies = provider.deps ?? [];
      const hasDescriptors = dependencies.some((dependency) => isProviderDependency(dependency));
      return {
        provide: provider.provide,
        useFactory: (...deps: unknown[]) => instantiate(
          type,
          hasDescriptors
            ? dependencies.map((dependency) => resolveProviderDependency(dependency))
            : deps,
        ),
        ...(hasDescriptors ? {} : { deps: dependencies }),
      };
    }
    if (isFactoryProvider(provider)) {
      const dependencies = provider.deps ?? [];
      const hasDescriptors = dependencies.some((dependency) => isProviderDependency(dependency));
      if (hasDescriptors) {
        return {
          provide: provider.provide,
          useFactory: () => track(provider.useFactory(
            ...dependencies.map((dependency) => resolveProviderDependency(dependency)),
          )),
        };
      }
      return {
        ...provider,
        useFactory: (...deps: unknown[]) => track(provider.useFactory(...deps)),
      } as AngularProvider;
    }
    return provider as AngularProvider;
  });
  const runtime = angularCreateEnvironmentInjector(
    [
      {
        provide: DESTROY_REF,
        useValue: destroyRef,
      },
      {
        provide: INJECTOR,
        useFactory: () => adapter,
      },
      ...normalizedProviders,
    ] as AngularProvider[],
    parent as AngularEnvironmentInjector,
    options.name ?? "supacloud",
  );
  let initialized = false;
  let initializationPromise: Promise<void> | null = null;
  let destructionPromise: Promise<void> | null = null;
  let destroyed = false;
  adapter = {
    ...(parent ? { parent } : {}),
    get destroyed() {
      return destroyed || runtime.destroyed;
    },
    get initialized() {
      return initialized;
    },
    get<T>(token: Token<T>, notFoundOrOptions?: T | InjectFlags, maybeOptions?: InjectFlags): T {
      try {
        if (isInjectOptions(notFoundOrOptions)) {
          const value = runtime.get(token as never, undefined, notFoundOrOptions);
          return (value === null ? undefined : value) as T;
        }
        const value = runtime.get(token as never, notFoundOrOptions, maybeOptions);
        return (value === null ? undefined : value) as T;
      } catch (error) {
        if (error instanceof Error && /NG0201|No provider found/i.test(error.message)) {
          if (
            token instanceof InjectionToken &&
            token.factory &&
            !maybeOptions?.self &&
            !maybeOptions?.skipSelf
          ) {
            return runInInjectionContext(adapter, token.factory) as T;
          }
          throw new Error(`NullInjectorError: No provider for ${tokenToString(token)}`);
        }
        throw error;
      }
    },
    runInContext<R>(fn: () => R): R {
      if (destroyed || runtime.destroyed) {
        throw new Error("EnvironmentInjector has already been destroyed.");
      }
      return runInInjectionContext(adapter, fn);
    },
    initialize(): Promise<void> {
      if (destroyed || runtime.destroyed) {
        return Promise.reject(new Error("EnvironmentInjector has already been destroyed."));
      }
      if (initialized) return Promise.resolve();
      if (initializationPromise) return initializationPromise;

      initializationPromise = (async () => {
        await runInitializers(adapter, ENVIRONMENT_INITIALIZER);
        await runInitializers(adapter, APP_INITIALIZER);
        await runLifecycleInitializers(adapter);
        initialized = true;
      })().catch((error) => {
        initializationPromise = null;
        throw error;
      });
      return initializationPromise;
    },
    destroy(): void {
      void startDestroy().catch(() => undefined);
    },
    destroyAsync(): Promise<void> {
      return startDestroy();
    },
  };

  if (options.initialize !== false) void adapter.initialize().catch(() => undefined);
  return adapter;

  function startDestroy(): Promise<void> {
    if (destructionPromise) return destructionPromise;
    destroyed = true;

    const operations: Array<Promise<void>> = [];
    try {
      runtime.destroy();
    } catch (error) {
      operations.push(Promise.reject(error));
    }

    operations.push(destroyRef.destroy());
    for (const instance of [...trackedInstances].reverse()) {
      if (!instance || typeof instance !== "object") continue;
      const candidate = instance as {
        onDestroy?: () => void | Promise<void>;
      };
      // Angular owns ngOnDestroy; only invoke the Node-specific async hook here.
      const hook = candidate.onDestroy;
      if (!hook) continue;
      try {
        operations.push(Promise.resolve(hook.call(instance)));
      } catch (error) {
        operations.push(Promise.reject(error));
      }
    }

    destructionPromise = Promise.allSettled(operations).then((results) => {
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, "EnvironmentInjector destruction failed");
    });
    return destructionPromise;
  }
}

async function runInitializers(
  injector: EnvironmentInjector,
  token: Token<() => void | Promise<void>>,
): Promise<void> {
  const initializers = injector.get(token, { optional: true }) as unknown;
  if (!Array.isArray(initializers)) return;
  for (const initializer of initializers) {
    if (typeof initializer === "function") {
      await injector.runInContext(() => initializer());
    }
  }
}

async function runLifecycleInitializers(injector: EnvironmentInjector): Promise<void> {
  const lifecycles = injector.get(APP_LIFECYCLE, { optional: true });
  if (!Array.isArray(lifecycles)) return;
  for (const lifecycle of lifecycles) {
    if (isLifecycleHooks(lifecycle) && lifecycle.onInit) {
      await injector.runInContext(() => lifecycle.onInit?.());
    }
  }
}

function isLifecycleHooks(value: unknown): value is LifecycleHooks {
  return typeof value === "object" && value !== null
    && ("onInit" in value || "onDestroy" in value);
}

function resolveClassDependencies(type: Type<unknown>): unknown[] {
  const metadata = getInjectableMeta(type);
  const indexed = new Map<number, ProviderDep>();
  if (metadata?.deps) {
    metadata.deps.forEach((dependency, index) => {
      indexed.set(index, dependency);
    });
  }
  for (const [index, token] of Object.entries(getInjectParams(type))) {
    indexed.set(Number(index), token);
  }
  if (indexed.size === 0) return [];
  const optional = new Set(getOptionalParams(type));
  const self = new Set(getSelfParams(type));
  const skipSelf = new Set(getSkipSelfParams(type));
  const host = new Set(getHostParams(type));
  const maxIndex = Math.max(...indexed.keys());
  return Array.from({ length: maxIndex + 1 }, (_, index) => {
    const dependency = indexed.get(index);
    if (!dependency) return undefined;
    const token = isProviderDependency(dependency) ? dependency.token : dependency;
    const descriptor = isProviderDependency(dependency) ? dependency : undefined;
    const options: InjectFlags = {
      optional: descriptor?.optional ?? optional.has(index),
      self: descriptor?.self ?? self.has(index),
      skipSelf: descriptor?.skipSelf ?? skipSelf.has(index),
      host: descriptor?.host ?? host.has(index),
    };
    const resolved = resolveForwardRef(token);
    return options.optional || options.self || options.skipSelf || options.host
      ? angularInject(resolved as never, options)
      : angularInject(resolved as never);
  });
}

function resolveProviderDependency(dependency: ProviderDep): unknown {
  const descriptor: ProviderDependency = isProviderDependency(dependency)
    ? dependency
    : { token: dependency };
  const { token, optional, self, skipSelf, host } = descriptor;
  const options: InjectFlags = {
    optional: optional ?? false,
    self: self ?? false,
    skipSelf: skipSelf ?? false,
    host: host ?? false,
  };
  const resolved = resolveForwardRef(token);
  return optional || self || skipSelf || host
    ? angularInject(resolved as never, options)
    : angularInject(resolved as never);
}

function isProviderDependency(value: unknown): value is ProviderDependency {
  return typeof value === "object" && value !== null && "token" in value;
}

function isInjectOptions(value: unknown): value is InjectFlags {
  return typeof value === "object" && value !== null && (
    "optional" in value ||
    "self" in value ||
    "skipSelf" in value ||
    "host" in value
  );
}

function adaptInjector(injector: AngularInjector): InjectorLike {
  return {
    get<T>(token: Token<T>, notFoundOrOptions?: T | InjectFlags, maybeOptions?: InjectFlags): T | undefined {
      if (isInjectOptions(notFoundOrOptions)) {
        const value = injector.get(token as never, undefined, notFoundOrOptions);
        return (value === null ? undefined : value) as T | undefined;
      }
      const value = injector.get(token as never, notFoundOrOptions, maybeOptions);
      return (value === null ? undefined : value) as T | undefined;
    },
  };
}
