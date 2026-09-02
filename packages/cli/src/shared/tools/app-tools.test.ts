import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionMode } from "../execution-policy";
import { registerAppTools, type AppToolArguments } from "./app-tools";

type AppCallback = (args: Partial<AppToolArguments>) => Promise<{
    isError: boolean;
    content: Array<{ type: "text"; text: string }>;
}>;

function captureAppCallback(): AppCallback {
    let callback: AppCallback | undefined;
    registerAppTools({
        tool(_name, _description, _schema, registered) {
            callback = registered as AppCallback;
        },
    });
    if (!callback) throw new Error("app tool was not registered");
    return callback;
}

const FIXTURE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "experimentalDecorators": true,
    "strict": true
  }
}
`;

/** @supacloud/app 的本地 noop 替身：AST 分析只按装饰器名匹配。 */
const RUNTIME_SOURCE = `export class InjectionToken<T = unknown> {
  readonly name: string;
  constructor(name: string) { this.name = name; }
}
export function Injectable(_options: Record<string, unknown> = {}) { return () => {}; }
export function Inject(_token: unknown) { return () => {}; }
export function Module(_options: Record<string, unknown>) { return () => {}; }
export function Command(_options: Record<string, unknown>) { return () => {}; }
export function Query(_options: Record<string, unknown>) { return () => {}; }
export function Controller(_path: string) { return () => {}; }
export function Get(_path: string, _options?: Record<string, unknown>) { return () => {}; }
export function Post(_path: string, _options?: Record<string, unknown>) { return () => {}; }
`;

const FIXTURE_FILES: Record<string, string> = {
    "tsconfig.json": FIXTURE_TSCONFIG,
    "src/runtime.ts": RUNTIME_SOURCE,

    "src/features/shared/tokens.ts": `import { InjectionToken } from "../../runtime";

export const DB_CLIENT = new InjectionToken("supacloud.db-client");
export const AUDIT_SERVICE = new InjectionToken("supacloud.audit-service");
`,

    "src/features/audit/audit.service.ts": `import { Injectable } from "../../runtime";

@Injectable()
export class AuditService {
  record(event: string): string {
    return event;
  }
}
`,

    "src/features/audit/audit.module.ts": `import { Module } from "../../runtime";
import { AUDIT_SERVICE } from "../shared/tokens";
import { AuditService } from "./audit.service";

@Module({
  name: "audit",
  providers: [{ provide: AUDIT_SERVICE, useClass: AuditService }],
  exports: [AUDIT_SERVICE],
})
export class AuditModule {}
`,

    "src/features/case/case.service.ts": `import { Inject, Injectable } from "../../runtime";
import { AUDIT_SERVICE, DB_CLIENT } from "../shared/tokens";

@Injectable()
export class CaseService {
  constructor(
    @Inject(AUDIT_SERVICE) readonly audit: unknown,
    @Inject(DB_CLIENT) readonly db: unknown,
  ) {}
}
`,

    "src/features/case/accept-case.command.ts": `import { Command, Inject, Injectable } from "../../runtime";
import { CaseService } from "./case.service";

@Injectable()
@Command({
  name: "case.accept",
  permission: "case.accept",
  transaction: "required",
  audit: "case.accepted",
})
export class AcceptCaseCommand {
  constructor(@Inject(CaseService) readonly cases: unknown) {}
}
`,

    "src/features/case/case.controller.ts": `import { Controller, Get, Inject } from "../../runtime";
import { CaseService } from "./case.service";

@Controller("/cases")
export class CaseController {
  constructor(@Inject(CaseService) readonly cases: unknown) {}

  @Get("/:caseId")
  detail(): { ok: boolean } {
    return { ok: true };
  }
}
`,

    "src/features/case/case.module.ts": `import { Module } from "../../runtime";
import { AuditModule } from "../audit/audit.module";
import { CaseService } from "./case.service";
import { AcceptCaseCommand } from "./accept-case.command";
import { CaseController } from "./case.controller";

@Module({
  name: "case",
  imports: [AuditModule],
  providers: [CaseService, AcceptCaseCommand],
  controllers: [CaseController],
})
export class CaseModule {}
`,
};

describe("app tools", () => {
    let root: string;
    const app = captureAppCallback();

    beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), "supacloud-app-tools-"));
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        for (const [relativePath, content] of Object.entries(FIXTURE_FILES)) {
            const absolute = join(root, relativePath);
            await mkdir(dirname(absolute), { recursive: true });
            await writeFile(absolute, content, "utf8");
        }
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    test("generate scaffolds module/command/query/controller files", async () => {
        const moduleResult = await app({ action: "generate", kind: "module", name: "billing", root });
        expect(moduleResult.isError).toBe(false);
        const moduleFile = join(root, "src/features/billing/billing.module.ts");
        expect(existsSync(moduleFile)).toBe(true);
        const moduleSource = readFileSync(moduleFile, "utf8");
        expect(moduleSource).toContain('from "@supacloud/app"');
        expect(moduleSource).toContain('name: "billing"');
        expect(moduleSource).toContain("export class BillingModule");

        const commandResult = await app({
            action: "generate", kind: "command", module: "billing", name: "issue-invoice", root,
        });
        expect(commandResult.isError).toBe(false);
        const commandFile = join(root, "src/features/billing/commands/issue-invoice.command.ts");
        const commandSource = readFileSync(commandFile, "utf8");
        expect(commandSource).toContain("@Command({");
        expect(commandSource).toContain('name: "billing.issueInvoice"');
        expect(commandSource).toContain("TODO");
        expect(commandSource).toContain("export class IssueInvoiceCommand");

        const queryResult = await app({
            action: "generate", kind: "query", module: "billing", name: "list-invoices", root,
        });
        expect(queryResult.isError).toBe(false);
        expect(readFileSync(join(root, "src/features/billing/queries/list-invoices.query.ts"), "utf8"))
            .toContain("export class ListInvoicesQuery");

        const controllerResult = await app({ action: "generate", kind: "controller", module: "billing", root });
        expect(controllerResult.isError).toBe(false);
        expect(readFileSync(join(root, "src/features/billing/billing.controller.ts"), "utf8"))
            .toContain('@Controller("/billing")');
    });

    test("generate refuses to overwrite without --force and rejects duplicate controllers", async () => {
        const moduleFile = join(root, "src/features/billing/billing.module.ts");
        await expect(app({ action: "generate", kind: "module", name: "billing", root }))
            .rejects.toThrow("already exists");

        const forced = await app({ action: "generate", kind: "module", name: "billing", root, force: true });
        expect(forced.isError).toBe(false);
        expect(forced.content[0].text).toContain("overwritten");
        expect(existsSync(moduleFile)).toBe(true);

        // fixture 已有 case.controller.ts → 提示手工合并，--force 也不覆盖
        await expect(app({ action: "generate", kind: "controller", module: "case", root }))
            .rejects.toThrow("手工合并");
        await expect(app({ action: "generate", kind: "controller", module: "case", root, force: true }))
            .rejects.toThrow("手工合并");
    });

    test("check analyzes without writing files", async () => {
        const result = await app({ action: "check", root });
        expect(result.isError).toBe(false);
        expect(result.content[0].text).toContain("no files written");
        expect(existsSync(join(root, "generated"))).toBe(false);
    });

    test("compile writes application.ts and app.manifest.json", async () => {
        const result = await app({ action: "compile", root });
        expect(result.isError).toBe(false);
        expect(existsSync(join(root, "generated", "application.ts"))).toBe(true);
        expect(existsSync(join(root, "generated", "app.manifest.json"))).toBe(true);
    });

    test("graph renders the module tree and json format", async () => {
        const textResult = await app({ action: "graph", root });
        expect(textResult.isError).toBe(false);
        const text = textResult.content[0].text;
        expect(text).toContain("└─ case");
        expect(text).toContain("└─ audit");
        expect(text).toContain("provider: CaseService");
        expect(text).toContain("controller: CaseController /cases");
        expect(text).toContain("route: GET /:caseId -> detail");
        expect(text).toContain("command: case.accept (AcceptCaseCommand)");
        expect(text).toContain("externalTokens: DB_CLIENT");

        const jsonResult = await app({ action: "graph", root, format: "json" });
        const manifest = JSON.parse(jsonResult.content[0].text);
        expect(manifest.version).toBe(1);
        expect(manifest.modules.map((module: { name: string }) => module.name))
            .toEqual(expect.arrayContaining(["audit", "case"]));
    });

    test("explain resolves providers, commands and external tokens", async () => {
        const provider = await app({ action: "explain", root, target: "CaseService" });
        expect(provider.isError).toBe(false);
        expect(provider.content[0].text).toContain("所属模块: case");
        expect(provider.content[0].text).toContain("scope: application");
        expect(provider.content[0].text).toContain("deps: AUDIT_SERVICE, DB_CLIENT");
        expect(provider.content[0].text).toContain("被依赖: case/AcceptCaseCommand, case/CaseController");

        const command = await app({ action: "explain", root, target: "case.accept" });
        expect(command.content[0].text).toContain("类型: command");
        expect(command.content[0].text).toContain("permission: case.accept");
        expect(command.content[0].text).toContain("transaction: required");
        expect(command.content[0].text).toContain("audit: case.accepted");

        const controller = await app({ action: "explain", root, target: "CaseController" });
        expect(controller.content[0].text).toContain("路由: GET /cases/:caseId -> detail");

        const external = await app({ action: "explain", root, target: "DB_CLIENT" });
        expect(external.content[0].text).toContain("externalToken");

        const missing = await app({ action: "explain", root, target: "Nope" });
        expect(missing.isError).toBe(true);
        expect(missing.content[0].text).toContain("未找到对象: Nope");
    });

    test("graph/explain fail with a clear error when the manifest is missing", async () => {
        const emptyRoot = mkdtempSync(join(tmpdir(), "supacloud-app-tools-empty-"));
        try {
            await expect(app({ action: "graph", root: emptyRoot }))
                .rejects.toThrow("Manifest not found");
            await expect(app({ action: "explain", root: emptyRoot, target: "CaseService" }))
                .rejects.toThrow("app compile");
        } finally {
            rmSync(emptyRoot, { recursive: true, force: true });
        }
    });

    test("all app actions are classified as local in the execution policy", () => {
        for (const action of ["generate", "compile", "check", "graph", "explain"]) {
            expect(executionMode("app", action, {})).toBe("local");
        }
    });
});
