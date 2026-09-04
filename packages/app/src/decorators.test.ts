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
  getCommandMeta,
  getControllerMeta,
  getInjectParams,
  getOptionalParams,
  getInjectableMeta,
  getModuleMeta,
  getQueryMeta,
  getRoutes,
} from "./decorators";
import { InjectionToken } from "./token";

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
});

describe("Provider multi flag", () => {
  test("provider interfaces accept multi: true", () => {
    const provider = { provide: DB_CLIENT, useClass: class Fake {}, multi: true };
    expect(provider.multi).toBe(true);
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
});
