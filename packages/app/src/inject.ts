import type { EnvironmentProviders, Provider, Token, Type } from "./provider";
import { flattenProviders, isClassProvider, isExistingProvider, isFactoryProvider, isValueProvider } from "./provider";
import { APP_INITIALIZER, DESTROY_REF, ENVIRONMENT_INITIALIZER, createDestroyRef } from "./context";
import { resolveForwardRef } from "./forward_ref";
import { InjectionToken } from "./token";

export interface InjectFlags {
  /** If true, returns undefined instead of throwing when token is not found. */
  optional?: boolean;
  /** If true, requires token to be resolved from current local injector. */
  self?: boolean;
  /** If true, skips current local injector and resolves from parent. */
  skipSelf?: boolean;
  /** If true, resolves from host injector. */
  host?: boolean;
}

export interface InjectorLike {
  get<T>(token: Token<T>, options?: InjectFlags): T | undefined;
  readonly parent?: InjectorLike;
}

let currentInjector: InjectorLike | null = null;

/**
 * Returns the current active Injector context, or null if not inside an injection context.
 */
export function getActiveInjector(): InjectorLike | null {
  return currentInjector;
}

/**
 * Executes a function within the scope of a specific injector.
 * Modeled directly after Angular's `runInInjectionContext(injector, fn)`.
 */
export function runInInjectionContext<R>(injector: InjectorLike, fn: () => R): R {
  const prev = currentInjector;
  currentInjector = injector;
  try {
    return fn();
  } finally {
    currentInjector = prev;
  }
}

/**
 * Resolves a token from the currently active injection context.
 * Modeled directly after Angular's `inject(token)`.
 *
 * Can be used in:
 * 1. Property initializers of classes
 * 2. Constructors
 * 3. Functional route guards (CanActivateFn)
 * 4. Route resolvers (ResolveFn)
 * 5. Factory providers
 * 6. Code executed inside `runInInjectionContext`
 */
export function inject<T>(token: Token<T>, options?: InjectFlags): T {
  if (!currentInjector) {
    throw new Error(
      `inject() can only be used within an active injection context (constructor, factory, guard, or runInInjectionContext). Token: ${tokenToString(token)}`,
    );
  }

  const resolved = resolveForwardRef(token);
  let value: unknown;

  if (options?.skipSelf) {
    if (!currentInjector.parent) {
      if (options.optional) return undefined as unknown as T;
      throw new Error(`NullInjectorError: No parent provider found for skipSelf token ${tokenToString(resolved)}`);
    }
    value = currentInjector.parent.get(resolved, options);
  } else {
    value = currentInjector.get(resolved, options);
  }

  if (value === undefined) {
    if (options?.optional) {
      return undefined as unknown as T;
    }
    if (resolved instanceof InjectionToken && resolved.factory && !options?.self && !options?.skipSelf) {
      return resolved.factory();
    }
    throw new Error(`NullInjectorError: No provider for ${tokenToString(resolved)}`);
  }
  return value as T;
}

/**
 * Injects all instances registered for a multi-provider token.
 * Modeled after Angular's multi-provider injection.
 */
export function injectAll<T>(token: Token<T>): T[] {
  const value = inject<T | T[]>(token, { optional: true });
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Creates a hierarchical child injector that inherits providers from a parent injector.
 * Modeled directly after Angular's hierarchical injectors.
 */
export function createChildInjector(
  parent: InjectorLike,
  localProviders: Map<Token<unknown> | string, unknown> | Record<string, unknown> = new Map(),
): InjectorLike & { readonly parent: InjectorLike } {
  const providerMap = localProviders instanceof Map
    ? (localProviders as Map<Token<unknown> | string, unknown>)
    : new Map<Token<unknown> | string, unknown>(Object.entries(localProviders));

  return {
    parent,
    get<T>(token: Token<T>, options?: InjectFlags): T | undefined {
      const resolved = resolveForwardRef(token);
      if (providerMap.has(resolved)) {
        return providerMap.get(resolved) as T;
      }
      if (resolved instanceof InjectionToken && providerMap.has(resolved.name)) {
        return providerMap.get(resolved.name) as T;
      }
      if (options?.self) {
        return undefined;
      }
      return parent.get(resolved);
    },
  };
}

/**
 * Asserts that execution is currently within an injection context.
 * Modeled after Angular's `assertInInjectionContext`.
 */
export function assertInInjectionContext(fnName: string): void {
  if (!currentInjector) {
    throw new Error(`${fnName} must be called from an active injection context.`);
  }
}

/**
 * Injects the AbortSignal of the active DestroyRef.
 * Automatically aborted when the active context or service is destroyed.
 * Modeled after Angular's DestroyRef signal pattern.
 */
export function injectDestroySignal(): AbortSignal {
  const ref = inject(DESTROY_REF);
  if (ref.signal) return ref.signal;
  throw new Error("Active DestroyRef does not provide an AbortSignal");
}

function tokenToString(token: Token<any>): string {
  if (typeof token === "string") return token;
  if (token instanceof InjectionToken) return token.toString();
  if (typeof token === "function") return token.name || "AnonymousClass";
  return String(token);
}

export interface EnvironmentInjector extends InjectorLike {
  get<T>(token: Token<T>, options?: InjectFlags): T;
  get<T>(token: Token<T>, notFoundValue: T, options?: InjectFlags): T;
  runInContext<R>(fn: () => R): R;
  destroy(): void;
  readonly destroyed: boolean;
  readonly parent?: InjectorLike;
}

/**
 * Creates an EnvironmentInjector with an isolated dependency scope and lifecycle.
 * Modeled directly after Angular 14+ createEnvironmentInjector.
 * Automatically executes all ENVIRONMENT_INITIALIZER / APP_INITIALIZER hooks upon creation,
 * and executes DestroyRef teardowns and OnDestroy hooks upon destroy().
 */
export function createEnvironmentInjector(
  providers: Array<Provider | EnvironmentProviders>,
  parent?: InjectorLike,
): EnvironmentInjector {
  let isDestroyed = false;
  const flatProviders = flattenProviders(providers);
  const effectiveProviders = new Map<Token<unknown>, Provider>();
  const multiProviders = new Map<Token<unknown>, Provider[]>();
  const instances = new Map<Token<unknown> | string, unknown>();

  // Create isolated destroyRef for this environment injector
  const localDestroyRef = createDestroyRef();
  instances.set(DESTROY_REF, localDestroyRef);

  for (const p of flatProviders) {
    const token = typeof p === "function" ? resolveForwardRef(p) : resolveForwardRef(p.provide);
    if (typeof p !== "function" && p.multi) {
      const list = multiProviders.get(token) ?? [];
      list.push(p);
      multiProviders.set(token, list);
    } else {
      effectiveProviders.set(token, p);
    }
  }

  const injector: EnvironmentInjector = {
    parent,
    get destroyed() {
      return isDestroyed;
    },
    runInContext<R>(fn: () => R): R {
      if (isDestroyed) {
        throw new Error("EnvironmentInjector has already been destroyed.");
      }
      return runInInjectionContext(injector, fn);
    },
    destroy(): void {
      if (isDestroyed) return;
      isDestroyed = true;
      void localDestroyRef.destroy();
      for (const inst of instances.values()) {
        if (inst && typeof inst === "object" && inst !== localDestroyRef) {
          if ("onDestroy" in inst && typeof (inst as any).onDestroy === "function") {
            try {
              (inst as any).onDestroy();
            } catch (err) {
              console.error("Error in onDestroy hook:", err);
            }
          }
          if ("ngOnDestroy" in inst && typeof (inst as any).ngOnDestroy === "function") {
            try {
              (inst as any).ngOnDestroy();
            } catch (err) {
              console.error("Error in ngOnDestroy hook:", err);
            }
          }
        }
      }
      instances.clear();
    },
    get<T>(token: Token<T>, notFoundOrOptions?: T | InjectFlags, maybeOptions?: InjectFlags): T {
      if (isDestroyed) {
        throw new Error("EnvironmentInjector has already been destroyed.");
      }
      let notFoundValue: T | undefined = undefined;
      let flags: InjectFlags | undefined = undefined;

      if (
        notFoundOrOptions !== undefined &&
        (typeof notFoundOrOptions !== "object" ||
          notFoundOrOptions === null ||
          (!("optional" in notFoundOrOptions) &&
            !("skipSelf" in notFoundOrOptions) &&
            !("self" in notFoundOrOptions) &&
            !("host" in notFoundOrOptions)))
      ) {
        notFoundValue = notFoundOrOptions as T;
        flags = maybeOptions;
      } else if (notFoundOrOptions && typeof notFoundOrOptions === "object") {
        flags = notFoundOrOptions as InjectFlags;
      }

      const resolved = resolveForwardRef(token);

      if (flags?.skipSelf) {
        if (!parent) {
          if (flags.optional) return undefined as unknown as T;
          if (notFoundValue !== undefined) return notFoundValue;
          throw new Error(`NullInjectorError: No parent provider found for skipSelf token ${tokenToString(resolved)}`);
        }
        const val = parent.get(resolved, flags);
        if (val === undefined && notFoundValue !== undefined) return notFoundValue;
        return val as T;
      }

      if (instances.has(resolved)) {
        return instances.get(resolved) as T;
      }
      if (resolved instanceof InjectionToken && instances.has(resolved.name)) {
        return instances.get(resolved.name) as T;
      }

      if (multiProviders.has(resolved)) {
        const provs = multiProviders.get(resolved)!;
        const results = provs.map((prov) => {
          if (isValueProvider(prov)) return prov.useValue;
          if (isFactoryProvider(prov)) return runInInjectionContext(injector, () => prov.useFactory());
          if (isClassProvider(prov)) return runInInjectionContext(injector, () => new (prov.useClass as Type<any>)());
          if (isExistingProvider(prov)) return injector.get(prov.useExisting);
          return undefined;
        });
        instances.set(resolved, results);
        if (resolved instanceof InjectionToken) {
          instances.set(resolved.name, results);
        }
        return results as unknown as T;
      }

      const provider = effectiveProviders.get(resolved);
      if (!provider) {
        if (flags?.self) {
          if (flags.optional) return undefined as unknown as T;
          if (notFoundValue !== undefined) return notFoundValue;
          throw new Error(`NullInjectorError: No local provider for ${tokenToString(resolved)}`);
        }
        if (parent) {
          const fromParent = parent.get(resolved, flags);
          if (fromParent !== undefined) return fromParent as T;
        }
        if (flags?.optional) return undefined as unknown as T;
        if (notFoundValue !== undefined) return notFoundValue;
        if (resolved instanceof InjectionToken && resolved.factory && !flags?.self && !flags?.skipSelf) {
          const inst = resolved.factory();
          instances.set(resolved, inst);
          return inst;
        }
        if (typeof resolved === "function") {
          try {
            const inst = new (resolved as Type<T>)();
            instances.set(resolved, inst);
            return inst;
          } catch {
            // not a zero-arg constructor
          }
        }
        throw new Error(`NullInjectorError: No provider for ${tokenToString(resolved)}`);
      }

      let created: unknown;
      if (typeof provider === "function") {
        created = runInInjectionContext(injector, () => new (provider as Type<any>)());
      } else if (isValueProvider(provider)) {
        created = provider.useValue;
      } else if (isFactoryProvider(provider)) {
        created = runInInjectionContext(injector, () => provider.useFactory());
      } else if (isClassProvider(provider)) {
        created = runInInjectionContext(injector, () => new (provider.useClass as Type<any>)());
      } else if (isExistingProvider(provider)) {
        created = injector.get(provider.useExisting);
      }

      instances.set(resolved, created);
      return created as T;
    },
  };

  // Run all ENVIRONMENT_INITIALIZER / APP_INITIALIZER tokens automatically upon creation
  const envInitializers = injector.get(ENVIRONMENT_INITIALIZER, { optional: true });
  const seenInits = new Set<unknown>();
  if (Array.isArray(envInitializers)) {
    for (const init of envInitializers) {
      if (typeof init === "function") {
        seenInits.add(init);
        runInInjectionContext(injector, () => {
          void init();
        });
      }
    }
  }
  const appInitializers = injector.get(APP_INITIALIZER, { optional: true });
  if (Array.isArray(appInitializers)) {
    for (const init of appInitializers) {
      if (typeof init === "function" && !seenInits.has(init)) {
        seenInits.add(init);
        runInInjectionContext(injector, () => {
          void init();
        });
      }
    }
  }

  return injector;
}
