import type { InjectionToken } from "./token";
import type { ForwardRefFn } from "./forward_ref";
import { APP_INITIALIZER, ENVIRONMENT_INITIALIZER } from "./context";
import type { Scope } from "./scope";

/** A class usable as a DI token / provider implementation. */
export interface Type<T> {
  new (...args: any[]): T;
}

/** Anything that can identify a provider: an InjectionToken or a class. */
export type Token<T = any> = InjectionToken<T> | Type<T> | ForwardRefFn<InjectionToken<T> | Type<T>>;

export interface ProviderDependency {
  token: Token;
  optional?: boolean;
  self?: boolean;
  skipSelf?: boolean;
  host?: boolean;
}

export type ProviderDep = Token | ProviderDependency;

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
  useClass: Type<T> | ForwardRefFn<Type<T>>;
  /** Explicit dependency tokens, positional (constructor order). */
  deps?: ProviderDep[];
}

export interface ValueProvider<T = any> extends BaseProvider {
  provide: Token<T>;
  useValue: T;
}

export interface FactoryProvider<T = any> extends BaseProvider {
  provide: Token<T>;
  useFactory: (...deps: any[]) => T;
  deps?: ProviderDep[];
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
  ɵproviders: Array<Provider | EnvironmentProviders>;
}

export function makeEnvironmentProviders(
  providers: Array<Provider | EnvironmentProviders>,
): EnvironmentProviders {
  return { ɵproviders: providers };
}

export function isEnvironmentProviders(value: unknown): value is EnvironmentProviders {
  return typeof value === "object" && value !== null && "ɵproviders" in value && Array.isArray((value as EnvironmentProviders).ɵproviders);
}

export function flattenProviders(providers: Array<Provider | EnvironmentProviders>): Provider[] {
  const result: Provider[] = [];
  for (const p of providers) {
    if (isEnvironmentProviders(p)) {
      result.push(...flattenProviders(p.ɵproviders));
    } else {
      result.push(p);
    }
  }
  return result;
}

/**
 * Configures an application initializer function that executes during startup before accepting requests.
 * Modeled after Angular's provideAppInitializer.
 */
export function provideAppInitializer(
  initializerFn: () => void | Promise<void>,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: APP_INITIALIZER,
      useValue: initializerFn,
      multi: true,
    },
  ]);
}

/**
 * Configures an environment/application initializer that executes during startup before accepting requests.
 * Modeled directly after Angular 15+ provideEnvironmentInitializer.
 */
export function provideEnvironmentInitializer(
  initializerFn: () => void | Promise<void>,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: ENVIRONMENT_INITIALIZER,
      useValue: initializerFn,
      multi: true,
    },
  ]);
}

/**
 * Functional provider helper to register an InjectionToken with a static value or factory.
 * Modeled after Angular's provideToken pattern.
 */
export function provideToken<T>(token: Token<T>, value: T): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: token,
      useValue: value,
    },
  ]);
}
