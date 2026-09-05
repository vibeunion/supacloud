import {
  assertInInjectionContext as angularAssertInInjectionContext,
  createEnvironmentInjector as angularCreateEnvironmentInjector,
  inject as angularInject,
  Injector as AngularInjector,
  runInInjectionContext as angularRunInInjectionContext,
  DestroyRef as AngularDestroyRef,
  type EnvironmentInjector as AngularEnvironmentInjector,
  type InjectOptions,
  type Provider as AngularProvider,
} from "@angular/core";
import type { EnvironmentProviders, Provider, Token } from "./provider";
import { flattenProviders } from "./provider";
import { APP_INITIALIZER, DESTROY_REF, ENVIRONMENT_INITIALIZER } from "./context";
import { InjectionToken } from "./token";

export type InjectFlags = InjectOptions;

export interface InjectorLike {
  get<T>(token: Token<T>, options?: InjectFlags): T | undefined;
  get<T>(token: Token<T>, notFoundValue: T, options?: InjectFlags): T;
  readonly parent?: InjectorLike;
}

let currentInjector: InjectorLike | null = null;

export function getActiveInjector(): InjectorLike | null {
  return currentInjector;
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
    return angularRunInInjectionContext(injector as AngularInjector, fn);
  } finally {
    currentInjector = previous;
  }
}

/**
 * Angular is the source of truth for runtime injection semantics. This
 * wrapper keeps the SupaCloud error contract for calls outside a context.
 */
export function inject<T>(token: Token<T>, options?: InjectFlags): T {
  try {
    const value = options === undefined
      ? angularInject(token as never)
      : angularInject(token as never, options);
    if (value !== undefined && value !== null) return value as T;
    if (
      token instanceof InjectionToken &&
      token.factory &&
      !options?.self &&
      !options?.skipSelf
    ) {
      return token.factory() as T;
    }
    return undefined as T;
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
  get<T>(token: Token<T>, options?: InjectFlags): T;
  get<T>(token: Token<T>, notFoundValue: T, options?: InjectFlags): T;
  runInContext<R>(fn: () => R): R;
  destroy(): void;
  readonly destroyed: boolean;
  readonly parent?: InjectorLike;
}

/**
 * Runtime compatibility adapter over Angular's public EnvironmentInjector.
 * SupaCloud EnvironmentProviders are flattened before crossing the boundary;
 * no Angular private ɵ API is referenced.
 */
export function createEnvironmentInjector(
  providers: Array<Provider | EnvironmentProviders>,
  parent?: InjectorLike,
): EnvironmentInjector {
  let adapter: EnvironmentInjector;
  const runtime = angularCreateEnvironmentInjector(
    [
      {
        provide: DESTROY_REF,
        useFactory: () => angularInject(AngularDestroyRef),
      },
      {
        provide: INJECTOR,
        useFactory: () => adapter,
      },
      ...flattenProviders(providers),
    ] as AngularProvider[],
    parent as AngularEnvironmentInjector,
    "supacloud",
  );
  adapter = {
    parent,
    get destroyed() {
      return runtime.destroyed;
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
      return runInInjectionContext(adapter, fn);
    },
    destroy(): void {
      runtime.destroy();
    },
  };

  runInitializers(adapter, ENVIRONMENT_INITIALIZER);
  runInitializers(adapter, APP_INITIALIZER);
  return adapter;
}

function runInitializers(
  injector: EnvironmentInjector,
  token: Token<() => void | Promise<void>>,
): void {
  const initializers = injector.get(token, { optional: true }) as unknown;
  if (!Array.isArray(initializers)) return;
  for (const initializer of initializers) {
    if (typeof initializer === "function") {
      void injector.runInContext(() => initializer());
    }
  }
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
