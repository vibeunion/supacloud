import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAppAliases, registerAppTools, runAppTool, type ToolResult } from "./app-tools";

const roots: string[] = [];
const require = createRequire(import.meta.url);
const { compileProject } = require("../../../../compiler/dist/index.js") as typeof import("@supacloud/compiler");
const feature = {
    action: "generate", kind: "feature", name: "case-approval",
    permission: "cases:approve", read_permission: "cases:read", rpc: "approveCase",
    database_source: "db/schema.ts", database_table: "public.reviews", database_type: "ReviewRow",
    format: "json",
} as const;
type Plan = { ok: boolean; written?: boolean; code?: string; changes: { path: string; content: string }[] };
function data(result: ToolResult): Plan {
    return JSON.parse(result.content.map(part => part.text).join("\n")) as Plan;
}
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "feature-generation-"));
    roots.push(root);
    return root;
}
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("feature preview and apply share a complete, non-overwriting plan", async () => {
    const root = await fixture();
    const preview = data(await runAppTool({ ...feature, root, dry_run: true }));
    expect(preview).toMatchObject({ ok: true, written: false });
    expect(preview.changes).toHaveLength(9);
    expect(await readdir(root)).toEqual([]);
    const applied = data(await runAppTool({ ...feature, root }));
    expect(applied).toMatchObject({ ok: true, written: true });
    for (const change of preview.changes) {
        expect(await readFile(join(root, change.path), "utf8")).toBe(change.content);
    }
    expect(data(await runAppTool({ ...feature, root })).code).toBe("SCAFFOLD_EXISTS");
    expect(await readdir(root)).toEqual(["src"]);
});

test("feature generation refuses guessed governance and overwrites", async () => {
    const root = await fixture();
    for (const args of [
        { permission: undefined }, { read_permission: undefined }, { rpc: undefined }, { database_source: undefined },
        { database_table: undefined }, { database_type: undefined }, { permission: " " },
        { rpc: "../unsafe" }, { permission: 'bad"permission' }, { force: true }, { module: "existing" },
    ]) {
        expect(data(await runAppTool({ ...feature, root, ...args }))).toMatchObject({
            ok: false, code: "SCAFFOLD_OPTION_INVALID",
        });
    }
    expect(data(await runAppTool({ ...feature, root, kind: "resource" }))).toMatchObject({
        ok: false, code: "SCAFFOLD_OPTION_INVALID",
    });
    expect(await readdir(root)).toEqual([]);
});

test("explicit parent registration imports the feature factory, not a fabricated module", async () => {
    const root = await fixture();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/app.module.ts"), `import { Module } from "@supacloud/app";
@Module({ name: "app", tags: ["type:app"], imports: [] })
export class AppModule {}
`);
    const result = await runAppTool({ ...feature, root, "register-in": "src/app.module.ts" });
    expect(result.isError, JSON.stringify(data(result))).toBe(false);
    const source = await readFile(join(root, "src/app.module.ts"), "utf8");
    expect(source).toContain("CaseApprovalFeature");
    expect(source).toContain("./features/case-approval/case-approval.feature");
});

test("feature conflicts fail before writing siblings or changing a parent", async () => {
    const root = await fixture();
    const directory = join(root, "src/features/case-approval");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "case-approval.model.ts"), "user source");
    const result = await runAppTool({ ...feature, root });
    expect(data(result)).toMatchObject({ ok: false, code: "SCAFFOLD_EXISTS" });
    expect(await readdir(directory)).toEqual(["case-approval.model.ts"]);
});

test("both CLI tool surfaces expose feature and explicit governance", () => {
    const schemas: Record<string, Record<string, unknown>> = {};
    const server = { tool(name: string, _description: string, schema: Record<string, unknown>) { schemas[name] = schema; } };
    registerAppTools(server);
    registerAppAliases(server);
    for (const name of ["app", "generate"]) {
        expect(JSON.stringify(schemas[name]?.kind)).toContain("feature");
        expect(schemas[name]).toHaveProperty("permission");
        expect(schemas[name]).toHaveProperty("read-permission");
        expect(schemas[name]).toHaveProperty("rpc");
        expect(schemas[name]).toHaveProperty("database_source");
        expect(schemas[name]).toHaveProperty("database_table");
        expect(schemas[name]).toHaveProperty("database_type");
    }
});

test("hyphenated read permission is an equivalent CLI alias", async () => {
    const root = await fixture();
    const result = data(await runAppTool({
        ...feature,
        root,
        read_permission: undefined,
        "read-permission": "cases:read",
    }));
    expect(result).toMatchObject({ ok: true, written: true });
});

async function generatedFixture(options: { bindAdapters?: boolean } = { bindAdapters: true }) {
    const root = await fixture();
    expect((await runAppTool({ ...feature, root })).isError).toBe(false);
    if (options.bindAdapters) {
        const featurePath = join(root, "src/features/case-approval/case-approval.feature.ts");
        const source = await readFile(featurePath, "utf8");
        const bound = source
            .replace(
                'import { CaseApprovalRefresher } from "./case-approval.model";',
                [
                    'import {',
                    '    CaseApprovalJobStatuses, CaseApprovalReader, CaseApprovalReceipts,',
                    '    CaseApprovalRefresher, CaseApprovalWriter,',
                    '} from "./case-approval.model";',
                ].join("\n"),
            )
            .replace(
                "        CaseApprovalService,",
                [
                    "        CaseApprovalService,",
                    '        { provide: CaseApprovalReader, useValue: {}, scope: "request" },',
                    '        { provide: CaseApprovalWriter, useValue: {}, scope: "request" },',
                    '        { provide: CaseApprovalReceipts, useValue: {}, scope: "request" },',
                    '        { provide: CaseApprovalJobStatuses, useValue: {}, scope: "request" },',
                    '        { provide: CaseApprovalRefresher, useValue: {}, scope: "job" },',
                ].join("\n"),
            );
        await writeFile(featurePath, bound);
    }
    await mkdir(join(root, "db"), { recursive: true });
    await writeFile(join(root, "db/schema.ts"), "export type ReviewRow = { id: string; state: string; version: number };\n");
    await symlink(join(import.meta.dir, "../../../node_modules"), join(root, "node_modules"), "dir");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            experimentalDecorators: true, strict: true, skipLibCheck: true,
            module: "ESNext", moduleResolution: "bundler", target: "ES2022", noEmit: true,
            paths: {
                "@supacloud/app/core": [join(import.meta.dir, "../../../../app/src/core.ts")],
                "@supacloud/app": [join(import.meta.dir, "../../../../app/src/core.ts")],
                "@supacloud/contracts/client": [join(import.meta.dir, "../../../../contracts/src/client.ts")],
            },
        },
        include: ["src/**/*.ts"],
    }));
    return root;
}

test("the generated approval compiles only with the explicit persistent capability", async () => {
    const root = await generatedFixture();
    const options = { rootDir: join(root, "src"), outDir: join(root, "generated"), strict: true };
    const blocked = await compileProject(options);
    expect(blocked.diagnostics.some(item => item.severity === "error" && item.code.startsWith("command-"))).toBe(true);
    expect(blocked.written).toEqual([]);
    const compiled = await compileProject({
        ...options,
        commandCapabilities: {
            requirePersistentAdapters: true, permission: true,
            rpc: { approveCase: { boundary: "database", transaction: true, idempotency: true, audit: true } },
        },
    });
    expect(compiled.diagnostics.filter(item => item.severity === "error")).toEqual([]);
    const featureModule = compiled.graph.modules.find(module => module.featureSpec);
    expect(featureModule?.featureSpec?.transitions[0]?.permission).toBe("cases:approve");
    expect((featureModule?.featureSpec?.transitions[0] as { job?: string } | undefined)?.job)
        .toBe("case-approval.refresh");
    expect(featureModule?.commands[0]?.rpc).toBe("approveCase");
    expect(featureModule?.queries).toHaveLength(4);
    const featureSource = await readFile(join(root, "src/features/case-approval/case-approval.feature.ts"), "utf8");
    expect(featureSource).toContain('database: {"source":"db/schema.ts","table":"public.reviews","rowType":"ReviewRow"}');
    const contractsSource = await readFile(join(root, "src/features/case-approval/case-approval.contracts.ts"), "utf8");
    expect(contractsSource).toContain('import type { ReviewRow } from "../../../db/schema";');
    expect(contractsSource).toContain("export type CaseApprovalDatabaseRow = ReviewRow;");
    expect(contractsSource).toContain("Transport projection; the business result type is derived from the database source");
    expect(featureSource).toContain('tenantField: "tenant_id"');
    expect(featureSource).toContain('"CaseApprovalReader"');
    expect(featureSource).toContain('"CaseApprovalRefresher"');
    expect(featureSource).toContain('CaseApprovalRefresher: "job"');
    expect(await readFile(join(root, "src/features/case-approval/case-approval.feature.ts"), "utf8"))
        .toContain('tenantScope: "required"');
    expect(featureSource).toContain('@Query({ name: "case-approval.detail", permission: "cases:read", tenantScope: "required" })');
    expect(featureSource).toContain('@Query({ name: "case-approval.receipt", permission: "cases:read", tenantScope: "required" })');
    expect(featureSource).toContain('@Query({ name: "case-approval.job-status", permission: "cases:read", tenantScope: "required" })');
    expect(featureSource).toContain('permission: "cases:read",\n        query: CaseApprovalListQuery');
    expect(featureSource).toContain('permission: "cases:read",\n        params: CaseApprovalParams');
    expect(featureSource).toContain("DetailCaseApprovalQuery");
    expect(featureSource).toContain("ReceiptCaseApprovalQuery");
    expect(featureSource).toContain("JobStatusCaseApprovalQuery");
    expect(featureSource).toContain("providers: [");
    expect(await readFile(join(root, "src/features/case-approval/case-approval.feature.ts"), "utf8"))
        .toContain('idempotency: "required",\n        effect:');
    expect(await readFile(join(root, "src/features/case-approval/case-approval.feature.ts"), "utf8"))
        .toContain('code: "COMMAND_IDEMPOTENCY_CONFLICT"');
    expect(await readFile(join(root, "src/features/case-approval/case-approval.feature.ts"), "utf8"))
        .toContain('code: "FEATURE_OPERATION_RESULT_MISMATCH"');
    expect(await readFile(join(root, "src/features/case-approval/case-approval.feature.ts"), "utf8"))
        .toContain("type CaseApprovalApproveError =");
    expect(await readFile(join(root, "src/features/case-approval/case-approval.feature.ts"), "utf8"))
        .toContain('Effect.Effect<CaseApprovalResult, CaseApprovalApproveError, never>');
    expect(await readFile(join(root, "src/features/case-approval/case-approval.feature.ts"), "utf8"))
        .toContain('invalidateTags: [\n                "case-approval.list",');
    expect(await readFile(join(root, "src/features/case-approval/case-approval.feature.ts"), "utf8"))
        .toContain('"/:id/operations/:operationId"');
    expect(await readFile(join(root, "src/features/case-approval/case-approval.feature.ts"), "utf8"))
        .toContain('"/:id/operations/:operationId/status"');
    expect(await readFile(join(root, "src/features/case-approval/case-approval.feature.ts"), "utf8"))
        .toContain('tags: ["case-approval.list"]');
    expect(await readFile(join(root, "src/features/case-approval/case-approval.model.ts"), "utf8"))
        .toContain("export interface CaseApprovalReceiptPort");
    expect(await readFile(join(root, "src/features/case-approval/case-approval.model.ts"), "utf8"))
        .toContain("export interface CaseApprovalJobStatusPort");
    expect(await readFile(join(root, "src/features/case-approval/case-approval.contracts.ts"), "utf8"))
        .toContain("export const CaseApprovalReceipt =");
    expect(await readFile(join(root, "src/features/case-approval/case-approval.contracts.ts"), "utf8"))
        .toContain("export const CaseApprovalJobStatus =");
    expect(await readFile(join(root, "src/features/case-approval/case-approval.contracts.ts"), "utf8"))
        .toContain("export const CaseApprovalApproveInvalidateTags");
    const featureClientSource = await readFile(join(root, "src/features/case-approval/case-approval.client.ts"), "utf8");
    expect(featureClientSource).toContain("createFeatureSliceCommandClient");
    expect(featureClientSource).toContain("CaseApprovalApproveInvalidateTags");
    expect(featureClientSource).toContain("FeatureSliceCommandClientOptions");
    expect(await readFile(join(root, "src/features/case-approval/case-approval.feature.ts"), "utf8"))
        .toContain("requireFeatureJobContext(this.jobContext, input.operationId)");
    expect(await readFile(join(root, "src/features/case-approval/case-approval.feature.ts"), "utf8"))
        .toContain("input: CaseApprovalRefreshInput");
    expect(await readFile(join(root, "src/features/case-approval/case-approval.contracts.ts"), "utf8"))
        .toContain("export const CaseApprovalRefreshInput = t.Object");
    expect(await readFile(join(root, "src/features/case-approval/case-approval.contracts.ts"), "utf8"))
        .toContain('operationId: t.String({ minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9._:-]+$" })');
    expect(await readFile(join(root, "src/features/case-approval/case-approval.contracts.ts"), "utf8"))
        .toContain('t.Union([t.Literal("draft"), t.Literal("approved")])');
    const contractsManifest = JSON.parse(
        await readFile(join(root, "generated/contracts.manifest.json"), "utf8"),
    ) as {
        features?: Array<{ transitions?: Array<{
            invalidateTags?: string[];
            jobDetails?: { input?: string };
        }> }>;
    };
    expect(contractsManifest.features?.[0]?.transitions?.[0]?.jobDetails?.input)
        .toBe("CaseApprovalRefreshInput");
    expect(contractsManifest.features?.[0]?.transitions?.[0]?.invalidateTags)
        .toEqual(["case-approval.list", "case-approval.detail", "case-approval.receipt", "case-approval.job-status"]);
    const clientCompilation = await compileProject({
        ...options,
        generateClient: true,
        commandCapabilities: {
            requirePersistentAdapters: true, permission: true,
            rpc: { approveCase: { boundary: "database", transaction: true, idempotency: true, audit: true } },
        },
    });
    expect(clientCompilation.diagnostics.filter(item => item.severity === "error")).toEqual([]);
    const generatedClient = await readFile(join(root, "generated/client.ts"), "utf8");
    expect(generatedClient).toContain("/case-approval/:id/approve");
    expect(generatedClient).toContain("/case-approval/");
    expect(generatedClient).toContain("/case-approval");
    const generatedE2E = await readFile(join(root, "src/features/case-approval/case-approval.e2e.test.ts"), "utf8");
    expect(generatedE2E).toContain('test.skipIf(!enabled)');
    expect(generatedE2E).toContain('expect(replay.status).toBe(first.status)');
    expect(generatedE2E).toContain('expect(replayBody).toEqual(firstBody)');
    expect(generatedE2E).toContain("durable receipt");
    expect(generatedE2E).toContain('conflicting replay');
    expect(generatedE2E).toContain('Promise.all');
    expect(generatedE2E).toContain('SUPACLOUD_FEATURE_E2E_OTHER_AUTHORIZATION');
    expect(generatedE2E).toContain('test.skipIf(!tenantIsolationEnabled)');
    expect(generatedE2E).toContain('cross-tenant access');
    const factoryPath = join(root, "generated/application.ts");
    const before = await readFile(factoryPath, "utf8");
    const missingAdapter = await compileProject(options);
    expect(missingAdapter.diagnostics.some(item => item.severity === "error" && item.code.startsWith("command-"))).toBe(true);
    expect(missingAdapter.written).toEqual([]);
    expect(await readFile(factoryPath, "utf8")).toBe(before);
// Three cold compiles on a CI runner can exceed 30s; let the assertions decide.
}, { timeout: 120_000 });

test("the generated approval blocks missing adapter bindings at compile time", async () => {
    const root = await generatedFixture({ bindAdapters: false });
    const result = await compileProject({
        rootDir: join(root, "src"), outDir: join(root, "generated"), strict: true,
        commandCapabilities: {
            requirePersistentAdapters: true, permission: true,
            rpc: { approveCase: { boundary: "database", transaction: true, idempotency: true, audit: true } },
        },
    });
    expect(result.diagnostics.filter(item => item.code === "feature-adapter-unresolved")).toHaveLength(5);
    expect(result.written).toEqual([]);
}, { timeout: 120_000 });

test("the generated approval tests enforce read and write adapter boundaries", async () => {
    const root = await generatedFixture();
    const child = Bun.spawn([
        process.execPath, "--no-env-file", "test", "src/features/case-approval/case-approval.feature.test.ts",
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ code, errors: code ? stdout + stderr : "" }).toEqual({ code: 0, errors: "" });
// Spawning the generated suite cold can exceed 30s on CI.
}, { timeout: 120_000 });

test("the generated approval passes strict TypeScript checking", async () => {
    const root = await generatedFixture();
    const types = Bun.spawn([
        process.execPath, join(root, "node_modules/typescript/bin/tsc"), "--project", join(root, "tsconfig.json"),
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [typeCode, typeOut, typeErr] = await Promise.all([
        types.exited, new Response(types.stdout).text(), new Response(types.stderr).text(),
    ]);
    expect({ code: typeCode, errors: typeCode ? typeOut + typeErr : "" }).toEqual({ code: 0, errors: "" });
// A cold tsc pass over the generated project can exceed 30s on CI.
}, { timeout: 120_000 });

test("request contract changes flow into the write port and diagnose stale adapters", async () => {
    const root = await generatedFixture();
    const directory = join(root, "src/features/case-approval");
    const contractPath = join(directory, "case-approval.contracts.ts");
    const original = await readFile(contractPath, "utf8");
    const changed = original.replace(
        "reason: t.Optional(t.String({ maxLength: 2000 })),",
        "reason: t.Optional(t.String({ maxLength: 2000 })),\n    reference: t.Optional(t.String()),",
    );
    expect(changed).not.toBe(original);
    await writeFile(contractPath, changed);
    await writeFile(join(directory, "business-adapter.ts"), `import type { CaseApprovalWritePort } from "./case-approval.model";
export const writer: CaseApprovalWritePort = {
    async approve(_context, input) {
        const reference: string | undefined = input.reference;
        void reference;
        return { id: input.id, state: "approved", version: input.expectedVersion + 1 };
    },
};
`);
    async function check() {
        const child = Bun.spawn([
            process.execPath, join(root, "node_modules/typescript/bin/tsc"), "--project", join(root, "tsconfig.json"),
        ], { cwd: root, stdout: "pipe", stderr: "pipe" });
        const [code, stdout, stderr] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        return { code, output: stdout + stderr };
    }
    expect(await check()).toEqual({ code: 0, output: "" });
    await writeFile(contractPath, changed.replace("reference: t.Optional(t.String())", "reference: t.Optional(t.Integer())"));
    const stale = await check();
    expect(stale.code).not.toBe(0);
    expect(stale.output).toContain("business-adapter.ts");
    expect(stale.output).toContain("number");
}, { timeout: 120_000 });
