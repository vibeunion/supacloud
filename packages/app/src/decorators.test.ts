import { describe, expect, test } from "bun:test";
import {
  Command,
  Controller,
  Delete,
  Get,
  Head,
  Inject,
  Injectable,
  Module,
  Optional,
  Options,
  Patch,
  Post,
  Put,
  Query,
  Host,
  Self,
  SkipSelf,
  UseGuards,
  getCommandMeta,
  getControllerMeta,
  getGuards,
  getHostParams,
  getInjectParams,
  getOptionalParams,
  getSelfParams,
  getSkipSelfParams,
  getInjectableMeta,
  getModuleMeta,
  getQueryMeta,
  getRoutes,
} from "./decorators";
import { InjectionToken } from "./token";
import { makeEnvironmentProviders } from "./provider";
import { APP_INITIALIZER } from "./context";
import { assertInInjectionContext, inject, runInInjectionContext } from "./inject";

const DB_CLIENT = new InjectionToken<{ query: (sql: string) => unknown }>("db.client");

describe("@Injectable", () => {
  test("defaults to application scope", () => {
    @Injectable()
    class Service {}
    expect(getInjectableMeta(Service)).toEqual({ scope: "application", deps: [] });
  });

  test("accepts explicit scope and deps", () => {
    @Injectable({ scope: "request", deps: [DB_CLIENT] })
    class Service {}
    expect(getInjectableMeta(Service)).toEqual({ scope: "request", deps: [DB_CLIENT] });
  });

  test("accepts providedIn: 'root'", () => {
    @Injectable({ providedIn: "root" })
    class RootService {}
    expect(getInjectableMeta(RootService)).toEqual({ scope: "application", providedIn: "root", deps: [] });
  });
});

describe("@Inject", () => {
  test("records constructor parameter tokens by index", () => {
    const AUDIT = new InjectionToken("audit");

    @Injectable()
    class Service {
      constructor(
        @Inject(DB_CLIENT) private readonly db: unknown,
        @Inject(AUDIT) private readonly audit: unknown,
      ) {}
    }

    expect(getInjectParams(Service)).toEqual({ 0: DB_CLIENT, 1: AUDIT });
  });

  test("rejects usage on non-constructor parameters", () => {
    expect(() => {
      class Service {
        method(@Inject(DB_CLIENT) _value: unknown) {}
      }
      return Service;
    }).toThrow("@Inject() is only supported on constructor parameters");
  });

  test("records optional constructor parameters", () => {
    const OPTIONAL_LOG = new InjectionToken("log");

    @Injectable()
    class ServiceWithOptional {
      constructor(
        @Inject(DB_CLIENT) private readonly db: unknown,
        @Optional() @Inject(OPTIONAL_LOG) private readonly log?: unknown,
      ) {}
    }

    expect(getInjectParams(ServiceWithOptional)).toEqual({ 0: DB_CLIENT, 1: OPTIONAL_LOG });
    expect(getOptionalParams(ServiceWithOptional)).toEqual([1]);
  });

  test("rejects @Optional() usage on non-constructor parameters", () => {
    expect(() => {
      class Service {
        method(@Optional() _value: unknown) {}
      }
      return Service;
    }).toThrow("@Optional() is only supported on constructor parameters");
  });

  test("records @Self, @SkipSelf, and @Host parameter modifiers", () => {
    const TOKEN_A = new InjectionToken("A");
    const TOKEN_B = new InjectionToken("B");
    const TOKEN_C = new InjectionToken("C");

    @Injectable()
    class ServiceWithModifiers {
      constructor(
        @Self() @Inject(TOKEN_A) private readonly a: unknown,
        @SkipSelf() @Inject(TOKEN_B) private readonly b: unknown,
        @Host() @Inject(TOKEN_C) private readonly c: unknown,
      ) {}
    }

    expect(getSelfParams(ServiceWithModifiers)).toEqual([0]);
    expect(getSkipSelfParams(ServiceWithModifiers)).toEqual([1]);
    expect(getHostParams(ServiceWithModifiers)).toEqual([2]);
  });
});

describe("Provider multi flag", () => {
  test("provider interfaces accept multi: true", () => {
    const provider = { provide: DB_CLIENT, useClass: class Fake {}, multi: true };
    expect(provider.multi).toBe(true);
  });

  test("makeEnvironmentProviders flattens into module providers", () => {
    const env = makeEnvironmentProviders([
      { provide: DB_CLIENT, useClass: class Fake {} },
    ]);
    @Module({
      name: "env-mod",
      providers: [env],
    })
    class EnvModule {}
    expect(getModuleMeta(EnvModule)?.providers).toHaveLength(1);
  });
});

describe("@Module", () => {
  test("normalizes omitted arrays to empty arrays", () => {
    @Module({ name: "case" })
    class CaseModule {}

    expect(getModuleMeta(CaseModule)).toEqual({
      name: "case",
      tags: [],
      imports: [],
      providers: [],
      controllers: [],
      commands: [],
      queries: [],
      exports: [],
    });
  });

  test("keeps declared providers, controllers and exports", () => {
    @Injectable()
    class CaseService {}

    @Controller("/cases")
    class CaseController {}

    @Module({
      name: "case",
      providers: [CaseService],
      controllers: [CaseController],
      exports: [CaseService],
    })
    class CaseModule {}

    const meta = getModuleMeta(CaseModule);
    expect(meta?.providers).toEqual([CaseService]);
    expect(meta?.controllers).toEqual([CaseController]);
    expect(meta?.exports).toEqual([CaseService]);
  });

  test("records module tags for boundary governance", () => {
    @Module({
      name: "case",
      tags: ["scope:case", "type:feature"],
    })
    class CaseModule {}

    const meta = getModuleMeta(CaseModule);
    expect(meta?.tags).toEqual(["scope:case", "type:feature"]);
  });
});

describe("@Command / @Query", () => {
  test("stores command governance metadata", () => {
    @Command({
      name: "case.accept",
      permission: "case.accept",
      transaction: "required",
      audit: "case.accepted",
      idempotency: "required",
    })
    class AcceptCaseCommand {}

    expect(getCommandMeta(AcceptCaseCommand)).toEqual({
      name: "case.accept",
      permission: "case.accept",
      transaction: "required",
      audit: "case.accepted",
      idempotency: "required",
    });
  });

  test("supports standalone: true on @Command", () => {
    @Command({ name: "case.standalone", permission: "case.standalone", standalone: true })
    class StandaloneCommand {}
    expect(getCommandMeta(StandaloneCommand)?.standalone).toBe(true);
  });

  test("stores query metadata", () => {
    @Query({ name: "case.get" })
    class GetCaseQuery {}
    expect(getQueryMeta(GetCaseQuery)).toEqual({ name: "case.get" });
  });

  test("defaults transaction and idempotency to none", () => {
    @Command({ name: "case.publish", permission: "case.publish" })
    class PublishCaseCommand {}

    expect(getCommandMeta(PublishCaseCommand)).toEqual({
      name: "case.publish",
      permission: "case.publish",
      transaction: "none",
      idempotency: "none",
    });
  });
});

describe("@Controller and route decorators", () => {
  test("accumulates routes in declaration order", () => {
    const CreateCaseInput = { type: "object" };

    @Command({ name: "case.create", permission: "case.create" })
    class CreateCaseCommand {}

    @Controller("/cases")
    class CaseController {
      @Get("/:id")
      get() {}

      @Post("/", { body: CreateCaseInput, command: CreateCaseCommand })
      create() {}
    }

    expect(getControllerMeta(CaseController)).toEqual({ path: "/cases" });
    expect(getRoutes(CaseController)).toEqual([
      { method: "GET", path: "/:id", handler: "get" },
      {
        method: "POST",
        path: "/",
        handler: "create",
        body: CreateCaseInput,
        command: CreateCaseCommand,
      },
    ]);
  });

  test("accumulates Head and Options routes", () => {
    @Controller("/status")
    class StatusController {
      @Head("/")
      head() {}

      @Options("/")
      options() {}
    }

    expect(getRoutes(StatusController)).toEqual([
      { method: "HEAD", path: "/", handler: "head" },
      { method: "OPTIONS", path: "/", handler: "options" },
    ]);
  });

  test("accepts ControllerOptions with standalone: true", () => {
    @Controller({ path: "/api/v2", standalone: true })
    class StandaloneController {}

    expect(getControllerMeta(StandaloneController)).toEqual({
      path: "/api/v2",
      standalone: true,
    });
  });

  test("attaches route guards via @UseGuards", () => {
    const authGuard = () => true;
    const adminGuard = () => true;

    @UseGuards(authGuard)
    @Controller("/admin")
    class AdminController {
      @UseGuards(adminGuard)
      @Get("/dashboard")
      dashboard() {}
    }

    expect(getGuards(AdminController)).toEqual([authGuard]);
    expect(getGuards(AdminController, "dashboard")).toEqual([authGuard, adminGuard]);
  });

  test("supports redirectTo and pathMatch on route decorators", () => {
    @Controller("/cases")
    class RedirectController {
      @Get("/", { redirectTo: "/cases/active", pathMatch: "full" })
      index() {}
    }

    const routes = getRoutes(RedirectController);
    expect(routes[0].redirectTo).toBe("/cases/active");
    expect(routes[0].pathMatch).toBe("full");
  });
});

describe("Angular-style functional inject() & injection context", () => {
  const FOO = new InjectionToken<string>("foo");
  const BAR = new InjectionToken<number>("bar", { factory: () => 42 });

  test("inject() throws when called outside injection context", () => {
    expect(() => inject(FOO)).toThrow("inject() can only be used within an active injection context");
  });

  test("assertInInjectionContext asserts active context", () => {
    expect(() => assertInInjectionContext("myGuard")).toThrow("myGuard must be called from an active injection context");
  });

  test("runInInjectionContext resolves tokens via inject()", () => {
    const map = new Map<unknown, unknown>([[FOO, "hello"]]);
    const injector = {
      get: <T>(token: unknown) => map.get(token) as T | undefined,
    };

    const result = runInInjectionContext(injector, () => {
      assertInInjectionContext("testScope");
      return inject(FOO);
    });
    expect(result).toBe("hello");
  });

  test("inject() supports { optional: true }", () => {
    const injector = { get: () => undefined };
    const result = runInInjectionContext(injector, () => inject(FOO, { optional: true }));
    expect(result).toBeUndefined();
  });

  test("inject() falls back to token factory when not in injector", () => {
    const injector = { get: () => undefined };
    const result = runInInjectionContext(injector, () => inject(BAR));
    expect(result).toBe(42);
  });

  test("APP_INITIALIZER has application scope", () => {
    expect(APP_INITIALIZER.scope).toBe("application");
    expect(APP_INITIALIZER.name).toBe("supacloud.app-initializer");
  });

  test("Param, Query, Body, Headers decorators record route parameter bindings", () => {
    const { Param, Query, Body, Headers, getRouteParams } = require("./index");
    class UserController {
      getUser(
        @Param("id") id: string,
        @Query("filter") filter: string,
        @Body() body: any,
        @Headers("authorization") auth: string,
      ) {
        return { id, filter, body, auth };
      }
    }

    const params = getRouteParams(UserController, "getUser");
    expect(params).toHaveLength(4);
    expect(params.find((p: any) => p.type === "param")).toEqual({ index: 0, type: "param", name: "id" });
    expect(params.find((p: any) => p.type === "query")).toEqual({ index: 1, type: "query", name: "filter" });
    expect(params.find((p: any) => p.type === "body")).toEqual({ index: 2, type: "body" });
    expect(params.find((p: any) => p.type === "headers")).toEqual({ index: 3, type: "headers", name: "authorization" });
  });

  test("provideAppInitializer and provideToken produce valid EnvironmentProviders", () => {
    const { provideAppInitializer, provideToken, isEnvironmentProviders } = require("./index");
    const fn = async () => {};
    const initEp = provideAppInitializer(fn);
    expect(isEnvironmentProviders(initEp)).toBe(true);
    expect(initEp.ɵproviders[0]).toMatchObject({
      provide: APP_INITIALIZER,
      useValue: fn,
      multi: true,
    });

    const customToken = new InjectionToken<string>("custom");
    const tokenEp = provideToken(customToken, "custom-val");
    expect(isEnvironmentProviders(tokenEp)).toBe(true);
    expect(tokenEp.ɵproviders[0]).toMatchObject({
      provide: customToken,
      useValue: "custom-val",
    });
  });

  test("createChildInjector resolves child tokens and falls back to parent", () => {
    const { createChildInjector, runInInjectionContext, inject } = require("./index");
    const PARENT_TOKEN = new InjectionToken<string>("parent");
    const CHILD_TOKEN = new InjectionToken<string>("child");

    const parentMap = new Map([[PARENT_TOKEN, "parent-val"]]);
    const parent = { get: <T>(t: any) => parentMap.get(t) as T | undefined };

    const child = createChildInjector(parent, new Map([[CHILD_TOKEN, "child-val"]]));

    runInInjectionContext(child, () => {
      expect(inject(CHILD_TOKEN)).toBe("child-val");
      expect(inject(PARENT_TOKEN)).toBe("parent-val");
    });
  });

  test("Param with transform and default options records metadata", () => {
    const { Param, Query, getRouteParams } = require("./index");
    class SearchController {
      search(
        @Param({ name: "id", transform: "number" }) id: number,
        @Query({ name: "page", transform: "number", default: 1 }) page: number,
      ) {
        return { id, page };
      }
    }

    const params = getRouteParams(SearchController, "search");
    expect(params[0]).toMatchObject({ index: 0, type: "param", name: "id", transform: "number" });
    expect(params[1]).toMatchObject({ index: 1, type: "query", name: "page", transform: "number", default: 1 });
  });

  test("DESTROY_REF has application scope", () => {
    const { DESTROY_REF } = require("./index");
    expect(DESTROY_REF.scope).toBe("application");
    expect(DESTROY_REF.name).toBe("supacloud.destroy-ref");
  });

  test("createDestroyRef runs callbacks in reverse order and supports unregistering", async () => {
    const { createDestroyRef } = require("./index");
    const destroyRef = createDestroyRef();
    const log: string[] = [];

    destroyRef.onDestroy(() => { log.push("first"); });
    const unregisterSecond = destroyRef.onDestroy(() => { log.push("second"); });
    destroyRef.onDestroy(() => { log.push("third"); });

    unregisterSecond();
    expect(destroyRef.destroyed).toBe(false);

    await destroyRef.destroy();
    expect(destroyRef.destroyed).toBe(true);
    expect(log).toEqual(["third", "first"]);

    expect(() => destroyRef.onDestroy(() => {})).toThrow("already destroyed");
  });

  test("inject(DESTROY_REF) resolves default factory when not in injector", () => {
    const { DESTROY_REF, inject, runInInjectionContext } = require("./index");
    const injector = { get: () => undefined };
    runInInjectionContext(injector, () => {
      const ref = inject(DESTROY_REF);
      expect(ref).toBeDefined();
      expect(typeof ref.onDestroy).toBe("function");
    });
  });

  test("forwardRef wraps and resolveForwardRef unwraps lazily evaluated token", () => {
    const { forwardRef, resolveForwardRef, isForwardRef } = require("./index");
    class TargetService {}
    const ref = forwardRef(() => TargetService);
    expect(isForwardRef(ref)).toBe(true);
    expect(resolveForwardRef(ref)).toBe(TargetService);
    expect(resolveForwardRef("plain")).toBe("plain");
  });

  test("DestroyRef.signal aborts when destroyed and injectDestroySignal returns signal", async () => {
    const { createDestroyRef, injectDestroySignal, runInInjectionContext, DESTROY_REF } = require("./index");
    const destroyRef = createDestroyRef();
    expect(destroyRef.signal.aborted).toBe(false);

    let caughtSignal: AbortSignal | undefined;
    const injector = {
      get: (token: any) => token === DESTROY_REF ? destroyRef : undefined,
    };
    runInInjectionContext(injector, () => {
      caughtSignal = injectDestroySignal();
    });

    expect(caughtSignal).toBe(destroyRef.signal);
    await destroyRef.destroy();
    expect(destroyRef.signal.aborted).toBe(true);
  });

  test("Title and Data route metadata can be declared via options and decorators", () => {
    const { Get, Title, Data, getRoutes } = require("./index");
    class MetadataController {
      @Get("/profile", { title: "User Profile", data: { role: "admin" } })
      profile() {}

      @Get("/settings")
      @Title("Settings Page")
      @Data({ flag: "experimental" })
      settings() {}
    }

    const routes = getRoutes(MetadataController);
    expect(routes[0].title).toBe("User Profile");
    expect(routes[0].data).toEqual({ role: "admin" });
    expect(routes[1].title).toBe("Settings Page");
    expect(routes[1].data).toEqual({ flag: "experimental" });
  });
});
