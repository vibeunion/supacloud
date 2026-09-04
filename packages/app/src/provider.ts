import type { InjectionToken } from "./token";
import type { Scope } from "./scope";

/** A class usable as a DI token / provider implementation. */
export interface Type<T> {
  new (...args: any[]): T;
}

/** Anything that can identify a provider: an InjectionToken or a class. */
export type Token<T = any> = InjectionToken<T> | Type<T>;

interface BaseProvider {
  /** Overrides the scope derived from @Injectable / token defaults. */
  scope?: Scope;
  /**
   * When true, multiple providers can contribute to this token as an array of instances (Angular multi-providers).
   */
  multi?: boolean;
}

export interface ClassProvider<T = any> extends BaseProvider {
  provide: Token<T>;
  useClass: Type<T>;
  /** Explicit dependency tokens, positional (constructor order). */
  deps?: Token[];
}

export interface ValueProvider<T = any> extends BaseProvider {
  provide: Token<T>;
  useValue: T;
}

export interface FactoryProvider<T = any> extends BaseProvider {
  provide: Token<T>;
  useFactory: (...deps: any[]) => T;
  deps?: Token[];
}

export interface ExistingProvider<T = any> extends BaseProvider {
  provide: Token<T>;
  useExisting: Token<T>;
}

/** Class shorthand registers the class as its own token. */
export type Provider<T = any> =
  | Type<T>
  | ClassProvider<T>
  | ValueProvider<T>
  | FactoryProvider<T>
  | ExistingProvider<T>;

export function isClassProvider<T>(provider: Provider<T>): provider is ClassProvider<T> {
  return typeof provider === "object" && provider !== null && "useClass" in provider;
}

export function isValueProvider<T>(provider: Provider<T>): provider is ValueProvider<T> {
  return typeof provider === "object" && provider !== null && "useValue" in provider;
}

export function isFactoryProvider<T>(provider: Provider<T>): provider is FactoryProvider<T> {
  return typeof provider === "object" && provider !== null && "useFactory" in provider;
}

export function isExistingProvider<T>(provider: Provider<T>): provider is ExistingProvider<T> {
  return typeof provider === "object" && provider !== null && "useExisting" in provider;
}

/**
 * Encapsulates a set of providers created by functional provideXxx APIs.
 * Modeled directly after Angular's EnvironmentProviders.
 */
export interface EnvironmentProviders {
  ɵproviders: Provider[];
}

export function makeEnvironmentProviders(providers: Provider[]): EnvironmentProviders {
  return { ɵproviders: providers };
}

export function isEnvironmentProviders(value: unknown): value is EnvironmentProviders {
  return typeof value === "object" && value !== null && "ɵproviders" in value && Array.isArray((value as EnvironmentProviders).ɵproviders);
}

export function flattenProviders(providers: Array<Provider | EnvironmentProviders>): Provider[] {
  const result: Provider[] = [];
  for (const p of providers) {
    if (isEnvironmentProviders(p)) {
      result.push(...p.ɵproviders);
    } else {
      result.push(p);
    }
  }
  return result;
}
