import type { Token } from "./provider";
import { InjectionToken } from "./token";

export interface InjectFlags {
  /** If true, returns undefined instead of throwing when token is not found. */
  optional?: boolean;
}

export interface InjectorLike {
  get<T>(token: Token<T>): T | undefined;
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

  const value = currentInjector.get(token);
  if (value === undefined) {
    if (options?.optional) {
      return undefined as unknown as T;
    }
    if (token instanceof InjectionToken && token.factory) {
      return token.factory();
    }
    throw new Error(`NullInjectorError: No provider for ${tokenToString(token)}`);
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
): InjectorLike {
  const providerMap = localProviders instanceof Map
    ? (localProviders as Map<Token<unknown> | string, unknown>)
    : new Map<Token<unknown> | string, unknown>(Object.entries(localProviders));

  return {
    get<T>(token: Token<T>): T | undefined {
      if (providerMap.has(token)) {
        return providerMap.get(token) as T;
      }
      if (token instanceof InjectionToken && providerMap.has(token.name)) {
        return providerMap.get(token.name) as T;
      }
      return parent.get(token);
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

function tokenToString(token: Token<any>): string {
  if (typeof token === "string") return token;
  if (token instanceof InjectionToken) return token.toString();
  if (typeof token === "function") return token.name || "AnonymousClass";
  return String(token);
}
