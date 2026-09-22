import { requireValue } from "../../test-helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionMode } from "../execution-policy";
import { registerAppAliases, registerAppTools, type AppToolArguments } from "./app-tools";

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

function captureAliasCallbacks(): Record<string, AppCallback> {
    const callbacks: Record<string, AppCallback> = {};
    registerAppAliases({
        tool(name, _description, _schema, registered) {
            callbacks[name] = registered as AppCallback;
        },
    });
    return callbacks;
}

const FIXTURE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "paths": { "@supacloud/app": ["./src/runtime.ts"] },
    "experimentalDecorators": true,
    "strict": true
  }
}
`;

/** Local noop stand-in for @supacloud/app: AST analysis matches by decorator name only. */
const RUNTIME_SOURCE = `export class InjectionToken<T = unknown> {
  readonly name: string;
  constructor(name: string) { this.name = name; }
}
export function Injectable(_options: Record<string, unknown> = {}): ClassDecorator { return () => {}; }
export function Inject(_token: unknown): ParameterDecorator { return () => {}; }
export function Module(_options: Record<string, unknown>): ClassDecorator { return () => {}; }
export function Command(_options: Record<string, unknown>): ClassDecorator { return () => {}; }
export function Job(_options: Record<string, unknown>): ClassDecorator { return () => {}; }
export function Query(_options: Record<string, unknown>): ClassDecorator { return () => {}; }
export function Controller(_path: string): ClassDecorator { return () => {}; }
export function Body(): ParameterDecorator { return () => {}; }
export function Get(_path: string, _options?: Record<string, unknown>): MethodDecorator { return () => {}; }
export function Post(_path: string, _options?: Record<string, unknown>): MethodDecorator { return () => {}; }
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
  idempotency: "required",
})
export class AcceptCaseCommand {
  constructor(@Inject(CaseService) readonly cases: unknown) {}
}
`,

    "src/features/case/case.controller.ts": `import { Body, Controller, Get, Inject, Post } from "../../runtime";
import { CaseService } from "./case.service";
import { AcceptCaseCommand } from "./accept-case.command";

const AcceptCaseBody = { type: "object" } as const;
const AcceptCaseParams = { type: "object" } as const;
const AcceptCaseQuery = { type: "object" } as const;
const DetailParams = {
  type: "object", properties: { caseId: { type: "string" } }, required: ["caseId"],
} as const;
const CaseResponse = {
  type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"],
} as const;

@Controller("/cases")
export class CaseController {
  constructor(@Inject(CaseService) readonly cases: unknown) {}

  @Get("/:caseId", { params: DetailParams, response: CaseResponse })
  detail(): { ok: boolean } {
    return { ok: true };
  }

  @Post("/accept", {
    command: AcceptCaseCommand,
    body: AcceptCaseBody,
    params: AcceptCaseParams,
    query: AcceptCaseQuery,
    response: CaseResponse,
  })
  accept(@Body() _body: unknown): { ok: boolean } {
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
        expect(commandSource).toContain("Implement IssueInvoiceCommand.execute before exposing this command");
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

        const jobResult = await app({ action: "generate", kind: "job", module: "billing", name: "sync-orders", root });
        expect(jobResult.isError).toBe(false);
        const jobSource = readFileSync(join(root, "src/features/billing/jobs/sync-orders.job.ts"), "utf8");
        expect(jobSource).toContain("@Job({");
        expect(jobSource).toContain('name: "billing.syncOrders"');
        expect(jobSource).toContain('mode: "task"');
        expect(jobSource).toContain("export class SyncOrdersJob");
        expect(jobSource).toContain("Implement SyncOrdersJob.run");
    });

    test("init creates an isolated, ready-to-run project template", async () => {
        const initRoot = mkdtempSync(join(tmpdir(), "supacloud-init-"));
        try {
            const result = await app({ action: "init", root: initRoot, name: "orders" });
            expect(result.isError).toBe(false);
            expect(readFileSync(join(initRoot, "package.json"), "utf8")).toContain('"@supacloud/app"');
            expect(readFileSync(join(initRoot, ".env.test"), "utf8")).toContain("APP_ENV=test");
            expect(readFileSync(join(initRoot, ".env.production.example"), "utf8")).toContain("APP_ENV=production");
            expect(readFileSync(join(initRoot, "src/application.ts"), "utf8")).toContain("createCompiledModules");
        } finally {
            rmSync(initRoot, { recursive: true, force: true });
        }
    });

    test("generate refuses to overwrite without --force and rejects duplicate controllers", async () => {
        const moduleFile = join(root, "src/features/billing/billing.module.ts");
        await expect(app({ action: "generate", kind: "module", name: "billing", root }))
            .rejects.toThrow("already exists");

        const forced = await app({ action: "generate", kind: "module", name: "billing", root, force: true });
        expect(forced.isError).toBe(false);
        expect(requireValue(forced.content[0]).text).toContain("overwritten");
        expect(existsSync(moduleFile)).toBe(true);

        // Fixture already has case.controller.ts -> prompts manual merge, --force does not overwrite
        await expect(app({ action: "generate", kind: "controller", module: "case", root }))
            .rejects.toThrow("手工合并");
        await expect(app({ action: "generate", kind: "controller", module: "case", root, force: true }))
            .rejects.toThrow("手工合并");
    });

    test("check reports missing generated files without writing them", async () => {
        const result = await app({ action: "check", root });
        expect(result.isError).toBe(true);
        expect(requireValue(result.content[0]).text).toContain("generated artifact mismatch");
        expect(requireValue(result.content[0]).text).toContain("no files written");
        expect(existsSync(join(root, "generated"))).toBe(false);
    });

    test("compile writes application.ts and app.manifest.json", async () => {
        const result = await app({ action: "compile", root });
        expect(result.isError, result.content.map((chunk) => chunk.text).join("\n")).toBe(false);
        expect(existsSync(join(root, "generated", "application.ts"))).toBe(true);
        expect(existsSync(join(root, "generated", "app.manifest.json"))).toBe(true);
        expect(existsSync(join(root, "generated", "graphql.ts"))).toBe(false);
        expect((await app({ action: "check", root })).isError).toBe(false);
    });

    test("default governance rejects missing idempotency without creating or replacing artifacts", async () => {
        const isolatedRoot = mkdtempSync(join(tmpdir(), "supacloud-app-governance-"));
        try {
            const { mkdir, writeFile } = await import("node:fs/promises");
            const { dirname } = await import("node:path");
            for (const [relativePath, content] of Object.entries(FIXTURE_FILES)) {
                const absolute = join(isolatedRoot, relativePath);
                await mkdir(dirname(absolute), { recursive: true });
                await writeFile(absolute, content, "utf8");
            }
            // Exercise the installed compiler's defaults, not a capability override.
            const commandPath = join(isolatedRoot, "src/features/case/accept-case.command.ts");
            const complete = readFileSync(commandPath, "utf8");
            const incomplete = complete.replace('  idempotency: "required",\n', "");
            expect(incomplete).not.toBe(complete);
            const artifacts = ["application.ts", "app.manifest.json"]
                .map((name) => join(isolatedRoot, "generated", name));
            writeFileSync(commandPath, incomplete);
            for (const action of ["check", "compile"] as const) {
                const result = await app({ action, root: isolatedRoot });
                expect(result.isError).toBe(true);
                expect(result.content.map((chunk) => chunk.text).join("\n"))
                    .toContain("command-persistence-required");
                for (const path of artifacts) expect(existsSync(path)).toBe(false);
            }

            writeFileSync(commandPath, complete);
            const compiled = await app({ action: "compile", root: isolatedRoot });
            expect(compiled.isError, compiled.content.map((chunk) => chunk.text).join("\n")).toBe(false);
            const previous = artifacts.map((path) => ({ path, bytes: readFileSync(path) }));
            writeFileSync(commandPath, incomplete);
            for (const action of ["check", "compile"] as const) {
                const result = await app({ action, root: isolatedRoot });
                expect(result.isError).toBe(true);
                expect(result.content.map((chunk) => chunk.text).join("\n"))
                    .toContain("command-persistence-required");
                for (const { path, bytes } of previous) expect(readFileSync(path)).toEqual(bytes);
            }
        } finally {
            rmSync(isolatedRoot, { recursive: true, force: true });
        }
    }, 30_000);

    test("check honors governance capabilities and rejects artifact drift without writing", async () => {
        const configPath = join(root, "supacloud.config.mjs");
        writeFileSync(configPath, 'export default { root: "src", commandCapabilities: { transaction: false } };\n');
        const artifactPath = join(root, "generated/application.ts");
        const original = readFileSync(artifactPath, "utf8");
        try {
            const result = await app({ action: "check", root });
            expect(result.isError).toBe(true);
            expect(requireValue(result.content[0]).text).toContain("command-transaction-unsupported");
            expect(readFileSync(artifactPath, "utf8")).toBe(original);
            const compiled = await app({ action: "compile", root });
            expect(compiled.isError).toBe(true);
            expect(readFileSync(artifactPath, "utf8")).toBe(original);
        } finally {
            rmSync(configPath);
        }
        writeFileSync(artifactPath, original + "\n// drift\n");
        expect((await app({ action: "check", root })).isError).toBe(true);
        writeFileSync(artifactPath, original);
    });
    test("context returns project graph and module neighborhood as structured AI context", async () => {
        const project = await app({ action: "context", root, format: "json" });
        expect(project.isError).toBe(false);
        const pack = JSON.parse(project.content[0].text);
        expect(pack.version).toBe(1);
        expect(pack.root).toBe(root);
        expect(pack.modules.map((module: { name: string }) => module.name))
            .toEqual(expect.arrayContaining(["audit", "case"]));
        expect(pack.externalTokens).toContain("DB_CLIENT");
        expect(pack.commands.doctor).toContain("app doctor");

        const module = await app({ action: "context", root, target: "case", format: "json" });
        const modulePack = JSON.parse(module.content[0].text);
        expect(modulePack.subject).toBe("case");
        expect(modulePack.modules.map((entry: { name: string }) => entry.name))
            .toEqual(expect.arrayContaining(["case", "audit"]));
        expect(modulePack.relatedModules.imports).toEqual(expect.arrayContaining(["audit"]));
    });

    test("doctor reports actionable checks and passes after a clean compile", async () => {
        await app({ action: "compile", root });
        const result = await app({ action: "doctor", root, format: "json" });
        expect(result.isError).toBe(false);
        const doctor = JSON.parse(result.content[0].text);
        expect(doctor.ok).toBe(true);
        expect(doctor.checks.find((check: { name: string }) => check.name === "modules").ok).toBe(true);
        expect(doctor.checks.find((check: { name: string }) => check.name === "generated-artifacts").ok).toBe(true);

        const text = await app({ action: "doctor", root });
        expect(text.isError).toBe(false);
        expect(text.content[0].text).toContain("No blocking issues");
    });

    test("graph renders the module tree and json format", async () => {
        const textResult = await app({ action: "graph", root });
        expect(textResult.isError).toBe(false);
        const text = requireValue(textResult.content[0]).text;
        expect(text).toContain("└─ case");
        expect(text).toContain("└─ audit");
        expect(text).toContain("provider: CaseService");
        expect(text).toContain("controller: CaseController /cases");
        expect(text).toContain("route: GET /:caseId -> detail");
        expect(text).toContain("command: case.accept (AcceptCaseCommand)");
        expect(text).toContain("externalTokens: DB_CLIENT");

        const jsonResult = await app({ action: "graph", root, format: "json" });
        const manifest = JSON.parse(requireValue(jsonResult.content[0]).text);
        expect(manifest.version).toBe(1);
        expect(manifest.modules.map((module: { name: string }) => module.name))
            .toEqual(expect.arrayContaining(["audit", "case"]));
    });

    test("explain resolves providers, commands and external tokens", async () => {
        const provider = await app({ action: "explain", root, target: "CaseService" });
        expect(provider.isError).toBe(false);
        expect(requireValue(provider.content[0]).text).toContain("所属模块: case");
        expect(requireValue(provider.content[0]).text).toContain("scope: application");
        expect(requireValue(provider.content[0]).text).toContain("deps: AUDIT_SERVICE, DB_CLIENT");
        expect(requireValue(provider.content[0]).text).toContain("被依赖: case/AcceptCaseCommand, case/CaseController");

        const command = await app({ action: "explain", root, target: "case.accept" });
        expect(requireValue(command.content[0]).text).toContain("类型: command");
        expect(requireValue(command.content[0]).text).toContain("permission: case.accept");
        expect(requireValue(command.content[0]).text).toContain("transaction: required");
        expect(requireValue(command.content[0]).text).toContain("audit: case.accepted");

        const controller = await app({ action: "explain", root, target: "CaseController" });
        expect(requireValue(controller.content[0]).text).toContain("路由: GET /cases/:caseId -> detail");

        const external = await app({ action: "explain", root, target: "DB_CLIENT" });
        expect(requireValue(external.content[0]).text).toContain("externalToken");

        const missing = await app({ action: "explain", root, target: "Nope" });
        expect(missing.isError).toBe(true);
        expect(requireValue(missing.content[0]).text).toContain("未找到对象: Nope");
    });

    test("export-tools writes OpenAI and MCP definitions from command governance metadata", async () => {
        await app({ action: "compile", root });
        const result = await app({ action: "export-tools", root });
        expect(result.isError).toBe(false);
        expect(requireValue(result.content[0]).text).toContain("case_accept");

        const openai = JSON.parse(readFileSync(join(root, "generated/tool-definitions.openai.json"), "utf8"));
        expect(openai).toHaveLength(1);
        expect(requireValue(openai[0]).function.name).toBe("case_accept");
        expect(requireValue(openai[0]).function.description).toContain("permission case.accept");
        expect(requireValue(openai[0]).function.description).toContain("HTTP POST /cases/accept");
        expect(requireValue(openai[0]).function.parameters.properties).toEqual(expect.objectContaining({
            body: expect.any(Object),
            params: expect.any(Object),
            query: expect.any(Object),
        }));

        const mcp = JSON.parse(readFileSync(join(root, "generated/tool-definitions.mcp.json"), "utf8"));
        expect(requireValue(mcp[0]).annotations).toEqual(expect.objectContaining({
            readOnly: false,
            audited: true,
            permission: "case.accept",
            httpMethod: "POST",
            httpPath: "/cases/accept",
        }));
    });

    test("export-tools json format returns both contracts without writing artifacts", async () => {
        const result = await app({ action: "export-tools", root, format: "json" });
        expect(result.isError).toBe(false);
        const payload = JSON.parse(requireValue(result.content[0]).text);
        expect(requireValue(payload.openai[0]).function.name).toBe("case_accept");
        expect(requireValue(payload.mcp[0]).inputSchema.properties.body.description)
            .toContain("AcceptCaseBody");
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

    test("top-level aliases delegate generate/check/context/doctor to app actions", async () => {
        const aliases = captureAliasCallbacks();
        expect(Object.keys(aliases)).toEqual(expect.arrayContaining([
            "generate", "compile", "check", "graph", "explain", "context", "doctor",
        ]));

        await app({ action: "compile", root });
        const doctor = await aliases.doctor({ root });
        expect(doctor.isError).toBe(false);
        expect(doctor.content[0].text).toContain("No blocking issues");

        const context = await aliases.context({ root, format: "json" });
        const pack = JSON.parse(context.content[0].text);
        expect(pack.version).toBe(1);
        expect(pack.modules.map((module: { name: string }) => module.name))
            .toEqual(expect.arrayContaining(["audit", "case"]));

        const generated = await aliases.generate({ kind: "module", name: "aliased", root });
        expect(generated.isError).toBe(false);
        expect(existsSync(join(root, "src/features/aliased/aliased.module.ts"))).toBe(true);
    });

    test("all app actions are classified as local in the execution policy", () => {
        for (const action of ["generate", "compile", "check", "graph", "explain", "export-tools", "context", "doctor"]) {
            expect(executionMode("app", action, {})).toBe("local");
        }
    });
});
