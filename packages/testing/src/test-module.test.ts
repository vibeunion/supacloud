import { describe, expect, test } from "bun:test";
import { createTestModule, tokenKey } from "./test-module";
import type { ModuleMetaLike } from "./test-module";

type Class = new (...args: any[]) => unknown;

/** Mimic @Injectable() metadata without importing @supacloud/app. */
function injectable(cls: Class, deps: unknown[] = []): void {
  Object.defineProperty(cls, "supacloud:injectable", {
    value: { scope: "application", deps },
  });
}

/** Mimic @Inject(token) on a constructor parameter. */
function injectParam(cls: Class, index: number, token: unknown): void {
  const existing =
    ((cls as unknown as Record<string, Record<number, unknown>>)["supacloud:inject-params"]) ?? {};
  Object.defineProperty(cls, "supacloud:inject-params", {
    value: { ...existing, [index]: token },
  });
}

const CASE_REPOSITORY = { name: "case.repository" };

class PgCaseRepository {
  findAll(): string[] {
    return ["real"];
  }
}
injectable(PgCaseRepository);

class CaseService {
  readonly repo: unknown;
  constructor(repo: unknown) {
    this.repo = repo;
  }
}
injectable(CaseService, [CASE_REPOSITORY]);

class CreateCaseCommand {
  readonly service: CaseService;
  constructor(service: CaseService) {
    this.service = service;
  }
}
injectable(CreateCaseCommand);
injectParam(CreateCaseCommand, 0, CaseService);

function appMeta(): ModuleMetaLike {
  return {
    name: "case",
    providers: [
      { provide: CASE_REPOSITORY, useClass: PgCaseRepository },
      CaseService,
      CreateCaseCommand,
    ],
  };
}

describe("tokenKey", () => {
  test("camelCases InjectionToken names", () => {
    expect(tokenKey({ name: "case.repository" })).toBe("caseRepository");
    expect(tokenKey({ name: "CASE_REPOSITORY" })).toBe("caseRepository");
  });

  test("lowercases the first letter of class names", () => {
    expect(tokenKey(CaseService)).toBe("caseService");
  });
});

describe("createTestModule", () => {
  test("instantiates a three-layer graph with real providers", () => {
    const container = createTestModule(appMeta());
    const command = container.createCaseCommand as CreateCaseCommand;
    expect(command.service).toBeInstanceOf(CaseService);
    expect((command.service.repo as PgCaseRepository).findAll()).toEqual(["real"]);
    expect(container.caseRepository).toBeInstanceOf(PgCaseRepository);
    expect(container.caseService).toBeInstanceOf(CaseService);
  });

  test("override replaces the repository with a fake across the whole graph", () => {
    const fakeRepo = { findAll: () => ["fake"] };
    const container = createTestModule(appMeta(), [
      { token: CASE_REPOSITORY, useValue: fakeRepo },
    ]);
    const command = container.createCaseCommand as CreateCaseCommand;
    expect(command.service.repo).toBe(fakeRepo);
    expect((command.service.repo as typeof fakeRepo).findAll()).toEqual(["fake"]);
    expect(container.caseRepository).toBe(fakeRepo);
  });

  test("override with useClass receives the original deps", () => {
    class SpyService {
      readonly repo: unknown;
      constructor(repo: unknown) {
        this.repo = repo;
      }
    }
    const container = createTestModule(appMeta(), [
      { token: CaseService, useClass: SpyService },
    ]);
    const command = container.createCaseCommand as CreateCaseCommand;
    expect(command.service).toBeInstanceOf(SpyService);
    expect(command.service.repo).toBeInstanceOf(PgCaseRepository);
  });

  test("reports the ring path on circular dependencies", () => {
    class AlphaService {}
    class BetaService {}
    injectable(AlphaService, [BetaService]);
    injectable(BetaService, [AlphaService]);
    const meta: ModuleMetaLike = {
      name: "cycle",
      providers: [AlphaService, BetaService],
    };
    expect(() => createTestModule(meta)).toThrow(
      /circular dependency detected: alphaService -> betaService -> alphaService/,
    );
  });

  test("resolves providers from imported modules", () => {
    class SharedConfig {
      value = 42;
    }
    injectable(SharedConfig);
    const shared: ModuleMetaLike = { name: "shared", providers: [SharedConfig] };
    class ConsumerService {
      readonly config: SharedConfig;
      constructor(config: SharedConfig) {
        this.config = config;
      }
    }
    injectable(ConsumerService, [SharedConfig]);
    const container = createTestModule({
      name: "app",
      imports: [shared],
      providers: [ConsumerService],
    });
    expect((container.consumerService as ConsumerService).config.value).toBe(42);
  });
});
