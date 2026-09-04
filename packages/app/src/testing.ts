import type { EnvironmentProviders, Provider, Token, Type } from "./provider";
import { flattenProviders, isClassProvider, isExistingProvider, isFactoryProvider, isValueProvider } from "./provider";
import { INJECTOR, injectAll, runInInjectionContext, type InjectFlags, type InjectorLike } from "./inject";
import { resolveForwardRef } from "./forward_ref";
import { InjectionToken } from "./token";

export interface TestModuleMetadata {
  providers?: Array<Provider | EnvironmentProviders>;
  imports?: Array<{ providers?: Array<Provider | EnvironmentProviders> } | any>;
}

/**
 * Unit testing environment for SupaCloud services and controllers.
 * Modeled directly after Angular's TestBed.
 */
export class TestBed {
  private static declaredProviders: Provider[] = [];
  private static overriddenProviders = new Map<Token<unknown>, Provider>();
  private static activeInjector: InjectorLike | null = null;
  private static instances = new Map<Token<unknown> | string, unknown>();

  /**
   * Configures the testing module with providers and imports.
   */
  static configureTestingModule(moduleDef: TestModuleMetadata): typeof TestBed {
    TestBed.resetTestingModule();
    const allProviders: Array<Provider | EnvironmentProviders> = [...(moduleDef.providers ?? [])];
    if (moduleDef.imports) {
      for (const imp of moduleDef.imports) {
        if (imp && typeof imp === "object" && "providers" in imp && Array.isArray(imp.providers)) {
          allProviders.push(...imp.providers);
        }
      }
    }
    TestBed.declaredProviders = flattenProviders(allProviders);
    return TestBed;
  }

  /**
   * Overrides a provider token with a test double or mock.
   */
  static overrideProvider(token: Token<unknown>, provider: Provider): typeof TestBed {
    TestBed.overriddenProviders.set(resolveForwardRef(token), provider);
    TestBed.activeInjector = null;
    return TestBed;
  }

  /**
   * Injects and resolves a dependency from the test environment.
   */
  static inject<T>(token: Token<T>, notFoundValue?: T, flags?: InjectFlags): T {
    const injector = TestBed.getOrCreateInjector();
    return runInInjectionContext(injector, () => {
      const resolved = resolveForwardRef(token);
      const val = injector.get(resolved, flags);
      if (val === undefined) {
        if (notFoundValue !== undefined) return notFoundValue;
        if (flags?.optional) return undefined as unknown as T;
        throw new Error(`TestBed: No provider found for token ${String(resolved)}`);
      }
      return val as T;
    });
  }

  /**
   * Injects all instances registered for a multi-provider token from the test environment.
   */
  static injectAll<T>(token: Token<T>): T[] {
    const injector = TestBed.getOrCreateInjector();
    return runInInjectionContext(injector, () => {
      return injectAll(token);
    });
  }

  /**
   * Runs a function inside the TestBed injection context.
   */
  static run<R>(fn: () => R): R {
    const injector = TestBed.getOrCreateInjector();
    return runInInjectionContext(injector, fn);
  }

  /**
   * Resets the testing environment, clearing providers, mocks, and instantiated singletons.
   */
  static resetTestingModule(): typeof TestBed {
    TestBed.declaredProviders = [];
    TestBed.overriddenProviders.clear();
    TestBed.activeInjector = null;
    TestBed.instances.clear();
    return TestBed;
  }

  private static getOrCreateInjector(): InjectorLike {
    if (TestBed.activeInjector) return TestBed.activeInjector;

    const effectiveProviders = new Map<Token<unknown>, Provider>();
    const multiProviders = new Map<Token<unknown>, Provider[]>();

    for (const p of TestBed.declaredProviders) {
      const token = typeof p === "function" ? resolveForwardRef(p) : resolveForwardRef(p.provide);
      if (typeof p !== "function" && p.multi) {
        const list = multiProviders.get(token) ?? [];
        list.push(p);
        multiProviders.set(token, list);
      } else {
        effectiveProviders.set(token, p);
      }
    }
    for (const [token, p] of TestBed.overriddenProviders) {
      if (typeof p !== "function" && p.multi) {
        const list = multiProviders.get(token) ?? [];
        list.push(p);
        multiProviders.set(token, list);
      } else {
        effectiveProviders.set(token, p);
        multiProviders.delete(token);
      }
    }

    const instances = TestBed.instances;

    const rootInjector: InjectorLike = {
      get<T>(token: Token<T>, flags?: InjectFlags): T | undefined {
        const resolved = resolveForwardRef(token);
        if (instances.has(resolved)) {
          return instances.get(resolved) as T;
        }
        if (resolved instanceof InjectionToken && instances.has(resolved.name)) {
          return instances.get(resolved.name) as T;
        }

        if (multiProviders.has(resolved)) {
          const providers = multiProviders.get(resolved)!;
          const results = providers.map((prov) => {
            if (isValueProvider(prov)) return prov.useValue;
            if (isFactoryProvider(prov)) return runInInjectionContext(rootInjector, () => prov.useFactory());
            if (isClassProvider(prov)) return runInInjectionContext(rootInjector, () => new (prov.useClass as Type<any>)());
            if (isExistingProvider(prov)) return rootInjector.get(prov.useExisting);
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
          if (flags?.optional) return undefined;
          if (resolved instanceof InjectionToken && resolved.factory) {
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
              return undefined;
            }
          }
          return undefined;
        }

        let created: unknown;
        if (typeof provider === "function") {
          created = runInInjectionContext(rootInjector, () => new (provider as Type<any>)());
        } else if (isValueProvider(provider)) {
          created = provider.useValue;
        } else if (isFactoryProvider(provider)) {
          created = runInInjectionContext(rootInjector, () => provider.useFactory());
        } else if (isClassProvider(provider)) {
          created = runInInjectionContext(rootInjector, () => new (provider.useClass as Type<any>)());
        } else if (isExistingProvider(provider)) {
          created = rootInjector.get(provider.useExisting);
        }

        instances.set(resolved, created);
        return created as T;
      },
    };

    TestBed.activeInjector = rootInjector;
    instances.set(INJECTOR, rootInjector);
    return rootInjector;
  }
}
