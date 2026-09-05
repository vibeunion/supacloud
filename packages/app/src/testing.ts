import type { EnvironmentProviders, Provider, Token } from "./provider";
import { flattenProviders } from "./provider";
import {
  createEnvironmentInjector,
  injectAll,
  runInInjectionContext,
  type EnvironmentInjector,
  type InjectFlags,
  type InjectorLike,
} from "./inject";
import { resolveForwardRef } from "./forward_ref";

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
  private static activeInjector: EnvironmentInjector | null = null;

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
    TestBed.activeInjector?.destroy();
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
      let val: T | undefined;
      try {
        val = injector.get(resolved, flags);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("NullInjectorError:")) {
          throw error;
        }
        if (notFoundValue !== undefined) return notFoundValue;
        if (flags?.optional) return undefined as unknown as T;
        throw new Error(`TestBed: No provider found for token ${String(resolved)}`);
      }
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
    TestBed.activeInjector?.destroy();
    TestBed.declaredProviders = [];
    TestBed.overriddenProviders.clear();
    TestBed.activeInjector = null;
    return TestBed;
  }

  private static getOrCreateInjector(): EnvironmentInjector {
    if (TestBed.activeInjector) return TestBed.activeInjector;

    const effectiveProviders = [...TestBed.declaredProviders];
    for (const [token, provider] of TestBed.overriddenProviders) {
      for (let index = effectiveProviders.length - 1; index >= 0; index -= 1) {
        const existing = effectiveProviders[index];
        const existingToken = typeof existing === "function"
          ? resolveForwardRef(existing)
          : resolveForwardRef(existing.provide);
        if (existingToken === token) effectiveProviders.splice(index, 1);
      }
      effectiveProviders.push(provider);
    }
    TestBed.activeInjector = createEnvironmentInjector(effectiveProviders);
    return TestBed.activeInjector;
  }
}
