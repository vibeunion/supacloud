import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./runtime-source";

/**
 * Bad fixture: circular dependency (CYCLE_A <-> CYCLE_B), scope violation (application depends on
 * request provider), provider reference from unimported module, duplicate token,
 * command missing permission, dependency cannot be statically resolved.
 * marker:xxx comments are used by tests to locate diagnostic line numbers.
 */
export const BAD_PROJECT_FILES: Record<string, string> = {
  "tsconfig.json": FIXTURE_TSCONFIG,
  "src/runtime.ts": RUNTIME_SOURCE,

  "src/cycle.ts": `import { Inject, Injectable, InjectionToken, Module } from "./runtime";

export const CYCLE_A = new InjectionToken("bad.cycle-a");
export const CYCLE_B = new InjectionToken("bad.cycle-b");

@Injectable()
export class CycleServiceA {
  constructor(@Inject(CYCLE_B) readonly b: unknown) {}
}

@Injectable()
export class CycleServiceB {
  constructor(@Inject(CYCLE_A) readonly a: unknown) {}
}

@Module({
  name: "cycle",
  providers: [
    { provide: CYCLE_A, useClass: CycleServiceA }, // marker:circular
    { provide: CYCLE_B, useClass: CycleServiceB },
  ],
})
export class CycleModule {}
`,

  "src/scope.ts": `import { Inject, Injectable, InjectionToken, Module } from "./runtime";

export const SESSION = new InjectionToken("bad.session", { scope: "request" });

@Injectable()
export class SessionService {}

@Injectable()
export class AppConfigService {
  constructor(@Inject(SESSION) readonly session: unknown) {}
}

@Module({
  name: "scope",
  providers: [
    { provide: SESSION, useClass: SessionService },
    AppConfigService, // marker:scope-violation
  ],
})
export class ScopeModule {}
`,

  "src/boundary.ts": `import { Inject, Injectable, InjectionToken, Module } from "./runtime";

export const HIDDEN_TOKEN = new InjectionToken("bad.hidden");

@Injectable()
export class HiddenService {}

@Module({
  name: "hidden",
  providers: [{ provide: HIDDEN_TOKEN, useClass: HiddenService }],
  exports: [HIDDEN_TOKEN],
})
export class HiddenModule {}

@Injectable()
export class BoundaryService {
  constructor(@Inject(HIDDEN_TOKEN) readonly hidden: unknown) {}
}

@Module({
  name: "boundary",
  providers: [
    BoundaryService, // marker:module-boundary
  ],
})
export class BoundaryModule {}
`,

  "src/misc.ts": `import { Command, Injectable, Module } from "./runtime";

interface MysteryConfig {
  retries: number;
}

@Injectable()
export class DupService {}

@Injectable()
@Command({ name: "bad.noperm" })
export class NoPermCommand {}

@Injectable()
export class MysteryService {
  constructor(readonly config: MysteryConfig) {}
}

@Module({
  name: "misc",
  providers: [
    DupService,
    { provide: DupService, useClass: DupService }, // marker:duplicate-token
    NoPermCommand,
    MysteryService, // marker:missing-deps
  ],
})
export class MiscModule {}
`,

  "src/routes.ts": `import { Command, Controller, Module, Post } from "./runtime";

@Command({ name: "bad.duplicate", permission: "bad.write" })
export class FirstCommand {}

@Command({ name: "bad.duplicate", permission: "bad.write" })
export class SecondCommand {}

export class MissingCommand {}

@Controller("/duplicate")
export class FirstController {
  @Post("/", { command: FirstCommand })
  execute() {}
}

@Controller("/duplicate")
export class SecondController {
  @Post("/", { command: MissingCommand })
  execute() {}
}

@Module({
  name: "route-one",
  providers: [FirstCommand],
  controllers: [FirstController],
})
export class FirstRouteModule {}

@Module({
  name: "route-two",
  providers: [SecondCommand],
  controllers: [SecondController],
})
export class SecondRouteModule {}
`,
};
