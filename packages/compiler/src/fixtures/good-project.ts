import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./runtime-source";

/**
 * Valid three-layer module fixture:
 * - tokens.ts: DB_CLIENT (platform injection), AUDIT_CONFIG, LOGGER, AUDIT_SERVICE,
 *   CASE_REPOSITORY, CASE_SERVICE
 * - audit module: value provider + factory provider + class provider, exports AUDIT_SERVICE
 * - case module: imports audit; CaseRepository class provider, CaseService deps
 *   [CASE_REPOSITORY, AUDIT_SERVICE], CASE_SERVICE existing alias, AcceptCaseCommand
 *   with full @Command metadata, CaseController @Controller("/cases") + @Post with schema,
 *   constructor depends on CASE_REPOSITORY and REQUEST_CONTEXT (request scope)
 * - health module: defineModule format
 */
export const GOOD_PROJECT_FILES: Record<string, string> = {
  "tsconfig.json": FIXTURE_TSCONFIG,
  "src/runtime.ts": RUNTIME_SOURCE,

  "src/features/shared/tokens.ts": `import { InjectionToken } from "../../runtime";

export const DB_CLIENT = new InjectionToken("supacloud.db-client");
export const AUDIT_CONFIG = new InjectionToken("supacloud.audit-config");
export const LOGGER = new InjectionToken("supacloud.logger");
export const AUDIT_SERVICE = new InjectionToken("supacloud.audit-service");
export const CASE_REPOSITORY = new InjectionToken("supacloud.case-repository");
export const CASE_SERVICE = new InjectionToken("supacloud.case-service");
`,

  "src/features/audit/logger.ts": `export function createLogger(config: { level: string }) {
  return { level: config.level };
}
`,

  "src/features/audit/audit.service.ts": `import { Inject, Injectable } from "../../runtime";
import { AUDIT_CONFIG, LOGGER } from "../shared/tokens";

@Injectable()
export class AuditService {
  constructor(
    @Inject(AUDIT_CONFIG) readonly config: { level: string },
    @Inject(LOGGER) readonly logger: { level: string },
  ) {}

  record(event: string): string {
    return event;
  }
}
`,

  "src/features/audit/audit.module.ts": `import { Module } from "../../runtime";
import { AUDIT_CONFIG, AUDIT_SERVICE, LOGGER } from "../shared/tokens";
import { AuditService } from "./audit.service";
import { createLogger } from "./logger";

@Module({
  name: "audit",
  providers: [
    { provide: AUDIT_CONFIG, useValue: { level: "info" } },
    { provide: LOGGER, useFactory: createLogger, deps: [AUDIT_CONFIG] },
    { provide: AUDIT_SERVICE, useClass: AuditService },
  ],
  exports: [AUDIT_SERVICE],
})
export class AuditModule {}
`,

  "src/features/case/contracts.ts": `export const CreateCaseBody = {
  type: "object",
  properties: { title: { type: "string" } },
};
export const AcceptParams = {
  type: "object",
  properties: { caseId: { type: "string" } },
};
export const AcceptResult = {
  type: "object",
  properties: { ok: { type: "boolean" } },
};
`,

  "src/features/case/case.repository.ts": `import { Inject, Injectable } from "../../runtime";
import { DB_CLIENT } from "../shared/tokens";

@Injectable()
export class DrizzleCaseRepository {
  constructor(@Inject(DB_CLIENT) readonly db: unknown) {}
}
`,

  "src/features/case/case.service.ts": `import { Inject, Injectable } from "../../runtime";
import { AUDIT_SERVICE, CASE_REPOSITORY } from "../shared/tokens";

@Injectable()
export class CaseService {
  constructor(
    @Inject(CASE_REPOSITORY) readonly repository: unknown,
    @Inject(AUDIT_SERVICE) readonly audit: unknown,
  ) {}
}
`,

  "src/features/case/accept-case.command.ts": `import { Command, Inject, Injectable } from "../../runtime";
import { CASE_SERVICE } from "../shared/tokens";

@Injectable()
@Command({
  name: "case.accept",
  permission: "case.accept",
  transaction: "required",
  audit: "case.accepted",
  idempotency: "required",
})
export class AcceptCaseCommand {
  constructor(@Inject(CASE_SERVICE) readonly caseService: unknown) {}
}
`,

  "src/features/case/case.controller.ts": `import { Controller, Inject, Post, REQUEST_CONTEXT } from "../../runtime";
import { AUDIT_SERVICE, CASE_REPOSITORY } from "../shared/tokens";
import { AcceptCaseCommand } from "./accept-case.command";
import { AcceptParams, AcceptResult, CreateCaseBody } from "./contracts";

@Controller("/cases")
export class CaseController {
  constructor(
    @Inject(CASE_REPOSITORY) readonly repository: unknown,
    @Inject(AUDIT_SERVICE) readonly audit: unknown,
    @Inject(REQUEST_CONTEXT) readonly ctx: unknown,
  ) {}

  @Post("/:caseId/accept", {
    body: CreateCaseBody,
    params: AcceptParams,
    response: AcceptResult,
    command: AcceptCaseCommand,
  })
  accept(): { ok: boolean } {
    return { ok: true };
  }
}
`,

  "src/features/case/case.module.ts": `import { Module } from "../../runtime";
import { CASE_REPOSITORY, CASE_SERVICE } from "../shared/tokens";
import { AuditModule } from "../audit/audit.module";
import { DrizzleCaseRepository } from "./case.repository";
import { CaseService } from "./case.service";
import { AcceptCaseCommand } from "./accept-case.command";
import { CaseController } from "./case.controller";

@Module({
  name: "case",
  imports: [AuditModule],
  providers: [
    { provide: CASE_REPOSITORY, useClass: DrizzleCaseRepository },
    CaseService,
    { provide: CASE_SERVICE, useExisting: CaseService },
    AcceptCaseCommand,
  ],
  controllers: [CaseController],
})
export class CaseModule {}
`,

  "src/features/health/health.module.ts": `import { Injectable, defineModule } from "../../runtime";

@Injectable()
export class HealthService {
  status(): string {
    return "ok";
  }
}

export const HealthModule = defineModule({
  name: "health",
  providers: [HealthService],
  exports: [HealthService],
});
`,
};
