import type { Token } from "./provider";
import { DESTROY_REF } from "./context";
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
