import { describe, expect, it } from "bun:test";
import { INJECTOR, createEnvironmentInjector, inject, injectAll, runInInjectionContext } from "./inject";
import { InjectionToken } from "./token";
import { DESTROY_REF, type OnDestroy } from "./context";
import {
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
  provideToken,
} from "./provider";

describe("Angular 14+ EnvironmentInjector and createEnvironmentInjector", () => {
  it("resolves basic providers and executes runInContext", () => {
    const API_URL = new InjectionToken<string>("API_URL");
    class GreetingService {
      greet(name: string) {
        return `Hello, ${name}`;
      }
    }

    const env = createEnvironmentInjector([
      provideToken(API_URL, "https://api.test.local"),
      GreetingService,
    ]);

    expect(env.get(API_URL)).toBe("https://api.test.local");
    const greeter = env.get(GreetingService);
    expect(greeter.greet("World")).toBe("Hello, World");

    const result = env.runInContext(() => {
      return inject(API_URL);
    });
    expect(result).toBe("https://api.test.local");
    expect(env.destroyed).toBe(false);
  });

  it("automatically executes provideEnvironmentInitializer hooks on creation", () => {
    let initialized = false;
    let inContext = false;
    const FLAG = new InjectionToken<string>("FLAG");

    const env = createEnvironmentInjector([
      provideToken(FLAG, "ready"),
      provideEnvironmentInitializer(() => {
        initialized = true;
        const f = inject(FLAG);
        if (f === "ready") {
          inContext = true;
        }
      }),
    ]);

    expect(initialized).toBe(true);
    expect(inContext).toBe(true);
    expect(env.get(FLAG)).toBe("ready");
  });

  it("executes DestroyRef teardowns and OnDestroy hooks on destroy()", () => {
    let destroyRefTeardownRan = false;
    let onDestroyHookRan = false;

    class CleanableService implements OnDestroy {
      onDestroy() {
        onDestroyHookRan = true;
      }
    }

    const env = createEnvironmentInjector([
      CleanableService,
      provideEnvironmentInitializer(() => {
        const ref = inject(DESTROY_REF);
        ref.onDestroy(() => {
          destroyRefTeardownRan = true;
        });
      }),
    ]);

    // Instantiate service inside env
    const service = env.get(CleanableService);
    expect(service).toBeDefined();
    expect(destroyRefTeardownRan).toBe(false);
    expect(onDestroyHookRan).toBe(false);

    env.destroy();
    expect(env.destroyed).toBe(true);
    expect(destroyRefTeardownRan).toBe(true);
    expect(onDestroyHookRan).toBe(true);

    // Operations after destroy throw
    expect(() => env.get(CleanableService)).toThrow("already been destroyed");
    expect(() => env.runInContext(() => 42)).toThrow("already been destroyed");
  });

  it("delegates to parent injector when token is not found in child", () => {
    const ROOT_CONFIG = new InjectionToken<string>("ROOT_CONFIG");
    const CHILD_CONFIG = new InjectionToken<string>("CHILD_CONFIG");

    const parent = createEnvironmentInjector([
      provideToken(ROOT_CONFIG, "root-val"),
    ]);

    const child = createEnvironmentInjector([
      provideToken(CHILD_CONFIG, "child-val"),
    ], parent);

    expect(child.get(CHILD_CONFIG)).toBe("child-val");
    expect(child.get(ROOT_CONFIG)).toBe("root-val");
  });

  it("resolves the INJECTOR token within an active injection context", () => {
    const env = createEnvironmentInjector([]);
    const resolvedInjector = env.runInContext(() => {
      return inject(INJECTOR);
    });
    expect(resolvedInjector).toBe(env);
  });

  it("resolves provider deps, aliases, multi providers, and nested environment providers", () => {
    const CONFIG = new InjectionToken<{ prefix: string }>("CONFIG");
    const VALUE = new InjectionToken<string>("VALUE");
    const HOOKS = new InjectionToken<() => string>("HOOKS");
    const HOOK_ALIAS = new InjectionToken<() => string>("HOOK_ALIAS");
    class Service {
      constructor(
        readonly config: { prefix: string },
        readonly value: string,
      ) {}
    }

    const env = createEnvironmentInjector([
      makeEnvironmentProviders([
        provideToken(CONFIG, { prefix: "supacloud" }),
        provideToken(VALUE, "di"),
      ]),
      {
        provide: Service,
        useClass: Service,
        deps: [CONFIG, VALUE],
      },
      {
        provide: HOOKS,
        useFactory: (service: Service) => () => `${service.config.prefix}-${service.value}`,
        deps: [Service],
        multi: true,
      },
      {
        provide: HOOK_ALIAS,
        useValue: () => "di",
      },
      {
        provide: HOOKS,
        useExisting: HOOK_ALIAS,
        multi: true,
      },
    ]);

    expect(env.get(Service).value).toBe("di");
    expect(env.runInContext(() => injectAll(HOOKS).map((hook) => hook()))).toEqual([
      "supacloud-di",
      "di",
    ]);
  });

  it("runs token factories inside the active injection context", () => {
    const CONFIG = new InjectionToken<string>("CONFIG");
    const DERIVED = new InjectionToken<string>("DERIVED", {
      factory: () => `${inject(CONFIG)}:derived`,
    });
    const env = createEnvironmentInjector([provideToken(CONFIG, "context")]);

    expect(env.get(DERIVED)).toBe("context:derived");
  });
});
