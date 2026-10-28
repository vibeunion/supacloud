/**
 * Candidate-package acceptance, not a source-import shortcut. The only reused
 * starter helpers manage subprocess lifetime and frozen consumer installation.
 * Application/resource generation is performed by the installed, packed CLI.
 */
import { strict as assert } from "node:assert";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { installStarterConsumer, runStarterCommand, starterInstallArgs } from "./check_app_starter";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "supacloud-packed-generation-"));
const runner = join(temporary, "runner");
const project = join(temporary, "project");
const interruption = new AbortController();
const interrupt = () => interruption.abort(new Error("Packed generation verification interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const environment: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(SUPACLOUD_|SUPABASE_|APP_ENV$|NODE_ENV$|PORT$|NODE_PATH$)/.test(key)) environment[key] = value;
}
// No developer context or credentials should participate in a local generator test.
environment["HOME"] = join(temporary, "home");
environment["USERPROFILE"] = environment["HOME"];
environment["XDG_CONFIG_HOME"] = join(environment["HOME"], ".config");
environment["BUN_TMPDIR"] = join(temporary, "bun-tmp");
async function run(args: string[], cwd = project, success = true): Promise<string> {
    return runStarterCommand(args, { cwd, env: environment, signal: interruption.signal, success, timeoutMs: 180_000 });
}

try {
    await mkdir(runner, { recursive: true });
    await mkdir(environment["HOME"], { recursive: true });
    await mkdir(environment["BUN_TMPDIR"], { recursive: true });
    const overrides: Record<string, string> = {};
    // Pack every project-owned package the generated template can resolve. The
    // template pins caret ranges such as @supacloud/js ^0.40.0 whose candidate
    // version may not be published yet; registry resolution would hang or fail.
    const candidates: [name: string, directory: string][] = [
        ["contracts", "contracts"], ["commands", "commands"], ["delivery", "delivery"],
        ["compiler", "compiler"], ["db", "db"], ["app", "app"], ["elysia", "elysia"],
        // @supacloud/js depends on the locally linked @supacloud/query package.
        ["query", "query"], ["js", "supacloud-js"], ["cli", "cli"],
    ];
    for (const [name, packageDirectory] of candidates) {
        const directory = join(repo, "packages", packageDirectory);
        await run(starterInstallArgs("workspace"), directory);
        await run(["run", "build"], directory);
        await run(["pm", "pack", "--ignore-scripts", "--destination", temporary], directory);
        const filename = (await readdir(temporary)).find(file => file.startsWith(`supacloud-${name}-`) && file.endsWith(".tgz"));
        assert.ok(filename, `Missing packed ${name}`);
        overrides[`@supacloud/${name}`] = `file:${join(temporary, filename)}`;
    }
    await writeFile(join(runner, "package.json"), JSON.stringify({
        name: "packed-cli-runner", private: true, type: "module",
        dependencies: { "@supacloud/cli": overrides["@supacloud/cli"] }, overrides,
    }, null, 2));
    await installStarterConsumer(runner, run);
    const cli = join(runner, "node_modules/@supacloud/cli/dist/index.js");
    await run([cli, "app", "init", "--root", project, "--name", "generation-acceptance", "--template", "http"], runner);
    const generatedManifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    assert.equal(generatedManifest.dependencies.elysia, "2.0.0-rc.0");
    // Candidate tarballs replace only project-owned packages; third-party versions
    // and the generated template otherwise remain exactly as the CLI emitted them.
    for (const group of ["dependencies", "devDependencies"]) {
        for (const name of Object.keys(generatedManifest[group] ?? {})) {
            if (overrides[name]) generatedManifest[group][name] = overrides[name];
        }
    }
    generatedManifest.overrides = overrides;
    await writeFile(join(project, "package.json"), JSON.stringify(generatedManifest, null, 2));
    await installStarterConsumer(project, run);

    // Use the composition root shipped by the packed CLI, never a test-only root.
    const starterRoot = await readFile(join(project, "src/app.module.ts"), "utf8");
    assert.ok(starterRoot.includes("OrdersFeature"));
    assert.ok(starterRoot.includes('tags: ["type:app"]'));
    const generation = [cli, "app", "generate", "--kind", "resource", "--name", "inventory", "--register-in", "src/app.module.ts", "--format", "json"];
    const parent = await readFile(join(project, "src/app.module.ts"), "utf8");
    const preview = JSON.parse(await run([...generation, "--dry-run"]));
    assert.equal(preview.written, false);
    assert.equal(preview.changes.length, 7);
    assert.equal(await readFile(join(project, "src/app.module.ts"), "utf8"), parent);
    await assert.rejects(readFile(join(project, "src/features/inventory/inventory.module.ts")), { code: "ENOENT" });
    const generated = JSON.parse(await run(generation));
    assert.equal(generated.written, true);
    for (const change of preview.changes) assert.equal(await readFile(join(project, change.path), "utf8"), change.content);
    const conflict = JSON.parse(await run(generation, project, false));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "SCAFFOLD_EXISTS");

    // Validate the actual CLI alias/flag parser, not only runAppTool's direct API.
    const alias = JSON.parse(await run([cli, "generate", "--kind", "module", "--name", "preview-only", "--dry-run", "--format", "json"]));
    assert.equal(alias.written, false);
    const compile = JSON.parse(await run([cli, "app", "compile", "--format", "json"]));
    assert.equal(compile.ok, true);
    assert.ok(compile.written.length > 0);
    const check = JSON.parse(await run([cli, "app", "check", "--format", "json"]));
    assert.equal(check.ok, true);
    assert.deepEqual(check.written, []);
    assert.ok(check.modules.includes("inventory"));
    const context = JSON.parse(await run([cli, "app", "context", "--target", "InventoryService", "--format", "json"]));
    assert.ok(context.files.some((file: string) => file.endsWith("inventory.service.ts")));
    await run(["run", "typecheck"]);
    // Include the starter's own tests; an added root must not orphan its feature.
    await run(["run", "test"]);
    await run(["run", "build"]);

    await writeFile(join(project, "scripts/verify-generated-resource.ts"), `import { strict as assert } from "node:assert";
import { Elysia } from "elysia";
import { createModulePlugin } from "@supacloud/elysia";
import { createCompiledModules } from "../generated/application";
import type { InventoryReadPort, InventoryResult } from "../src/features/inventory/inventory.model";

const typedResult: InventoryResult = { id: "example" };
// @ts-expect-error Response fields come from the schema, not an unknown/any cast.
const invalidResult: InventoryResult = { id: 1 };
void typedResult; void invalidResult;

const version = await Bun.file("node_modules/elysia/package.json").json();
assert.equal(version.version, "2.0.0-rc.0");
const module = createCompiledModules().find(value => value.name === "inventory");
assert.ok(module);
const unavailableApp = new Elysia().use(createModulePlugin(module, module.createServices({}, {})));
const unavailable = await unavailableApp.handle(new Request("http://localhost/inventory/example"));
assert.equal(unavailable.status, 500);
assert.ok(!(await unavailable.text()).includes("Bind InventoryReader"));
let calls = 0;
const reader: InventoryReadPort = { readAuthorized: async id => { calls++; return { id }; } };
const services = module.createServices({ inventoryReader: reader }, {});
const app = new Elysia().use(createModulePlugin(module, services));
// Elysia 2 seals registration on its first request; mount every route first.
app.get("/native-generation-probe", {}, () => ({ native: true }));
const invalid = await app.handle(new Request("http://localhost/inventory/%20"));
assert.equal(invalid.status, 422);
assert.equal(calls, 0);
const accepted = await app.handle(new Request("http://localhost/inventory/example"));
assert.equal(accepted.status, 200);
assert.deepEqual(await accepted.json(), { id: "example" });
assert.equal(calls, 1);
reader.readAuthorized = async () => { calls++; throw new Error("private async read failure"); };
const failed = await app.handle(new Request("http://localhost/inventory/example"));
assert.equal(failed.status, 500);
assert.ok(!(await failed.text()).includes("private async read failure"));
assert.equal(calls, 2);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => app.handle(request) });
try {
    const response = await fetch(new URL("/native-generation-probe", server.url), { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(await response.json(), { native: true });
} finally { await server.stop(true); }
console.log("Packed resource: real compiled DI/routes, fail-closed placeholder, input validation, test-double read and Elysia 2 listener passed");
`);
    await run(["run", "typecheck"]);
    console.log(await run(["scripts/verify-generated-resource.ts"]));
    // Verify the shipped built application, not just one hand-mounted module.
    await writeFile(join(project, "scripts/verify-built-application.mjs"), `import { strict as assert } from "node:assert";
import { createApp } from "../output/supacloud/application.js";

const app = createApp({
    deps: {},
    requestContext: () => ({}),
    commandGovernance: { authorize: () => { throw new Error("No command is authorized by this read-only test"); } },
});
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => app.handle(request) });
try {
    const request = path => fetch(new URL(path, server.url), { signal: AbortSignal.timeout(5000) });
    const health = await request("/orders/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const placeholder = await request("/inventory/example");
    assert.equal(placeholder.status, 500);
    assert.ok(!(await placeholder.text()).includes("Bind InventoryReader"));
    assert.equal((await request("/inventory/%20")).status, 422);
} finally { await server.stop(true); }
console.log("Built consumer factory: original and generated routes served together; async placeholder remained fail-closed");
`);
    console.log(await run(["scripts/verify-built-application.mjs"]));
    const beforeInspect = await readFile(join(project, "generated/application.ts"), "utf8");
    const inspection = await run(["run", "inspect"]);
    assert.ok(inspection.includes('"application-root"'));
    assert.ok(inspection.includes('"inventory"'));
    assert.equal(await readFile(join(project, "generated/application.ts"), "utf8"), beforeInspect);

    // Artifact drift must fail with machine-readable diagnostics and no repair.
    const driftPath = join(project, "generated/application.ts");
    const drifted = beforeInspect + "\n// test-owned artifact drift\n";
    await writeFile(driftPath, drifted);
    const drift = JSON.parse(await run([cli, "app", "check", "--format", "json"], project, false));
    assert.equal(drift.ok, false);
    assert.deepEqual(drift.written, []);
    assert.ok(drift.mismatches.length > 0);
    assert.equal(await readFile(driftPath, "utf8"), drifted);
    await writeFile(driftPath, beforeInspect);

    // Compile/check/graph must agree even with a non-default generated directory.
    const custom = "candidate-generated";
    assert.equal(JSON.parse(await run([cli, "app", "compile", "--out_dir", custom, "--format", "json"])).ok, true);
    const graph = JSON.parse(await run([cli, "app", "graph", "--out_dir", custom, "--format", "json"]));
    assert.ok(graph.modules.some((module: { name: string }) => module.name === "inventory"));

    // Add the durable slice only after the original HTTP sandbox acceptance:
    // an unbound RPC must never acquire an automatic in-memory fallback.
    await mkdir(join(project, "db"), { recursive: true });
    await writeFile(join(project, "db/schema.ts"),
        "export type ReviewRow = { id: string; state: string; version: number };\n");
    const featureGeneration = [
        cli, "app", "generate", "--kind", "feature", "--name", "case-approval",
        "--permission", "cases:approve", "--read-permission", "cases:read", "--rpc", "approveCase",
        "--database-source", "db/schema.ts", "--database-table", "public.reviews", "--database-type", "ReviewRow",
        "--register-in", "src/app.module.ts", "--format", "json",
    ];
    const featureParent = await readFile(join(project, "src/app.module.ts"), "utf8");
    for (const [flag, expectedMessage] of [
        ["--permission", "feature requires an explicit valid --permission"],
        ["--read-permission", "feature requires an explicit valid --read-permission"],
        ["--rpc", "feature requires an explicit valid --rpc"],
    ] as const) {
        const missing = featureGeneration.filter((_value, index) => index !== featureGeneration.indexOf(flag)
            && index !== featureGeneration.indexOf(flag) + 1);
        const rejected = await run(missing, project, false);
        assert.match(rejected, new RegExp(expectedMessage));
        assert.equal(await readFile(join(project, "src/app.module.ts"), "utf8"), featureParent);
        await assert.rejects(readFile(join(project, "src/features/case-approval/case-approval.feature.ts")), { code: "ENOENT" });
    }
    const featurePreview = JSON.parse(await run([...featureGeneration, "--dry-run"]));
    assert.equal(featurePreview.written, false);
    assert.equal(featurePreview.changes.length, 10);
    assert.equal(await readFile(join(project, "src/app.module.ts"), "utf8"), featureParent);
    await assert.rejects(readFile(join(project, "src/features/case-approval/case-approval.feature.ts")), { code: "ENOENT" });
    assert.equal(JSON.parse(await run(featureGeneration)).written, true);
    for (const change of featurePreview.changes) {
        assert.equal(await readFile(join(project, change.path), "utf8"), change.content);
    }
    const featureConflict = JSON.parse(await run(featureGeneration, project, false));
    assert.equal(featureConflict.ok, false);
    assert.equal(featureConflict.code, "SCAFFOLD_EXISTS");

    // The generated slice deliberately requires explicit runtime adapters. Bind
    // test doubles here so the packed consumer can continue to the runtime
    // acceptance without weakening the compiler's missing-adapter diagnostic.
    const featurePath = join(project, "src/features/case-approval/case-approval.feature.ts");
    const featureSource = await readFile(featurePath, "utf8");
    const boundFeatureSource = featureSource
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
                '        { provide: CaseApprovalReader, useValue: {',
                '            list: async () => [],',
                '            detail: async () => ({ id: "case-1", state: "approved", version: 1 }),',
                '        }, scope: "request" },',
                '        { provide: CaseApprovalWriter, useValue: {',
                '            approve: async () => ({ id: "case-1", state: "approved", version: 1 }),',
                '        }, scope: "request" },',
                '        { provide: CaseApprovalReceipts, useValue: {',
                '            lookup: async () => ({ id: "case-1", operationId: "operation-1", status: "confirmed" as const, state: "approved", version: 1 }),',
                '        }, scope: "request" },',
                '        { provide: CaseApprovalJobStatuses, useValue: {',
                '            lookup: async () => ({ id: "case-1", operationId: "operation-1", status: "completed" as const }),',
                '        }, scope: "request" },',
                '        { provide: CaseApprovalRefresher, useValue: { run: async () => {} }, scope: "job" },',
            ].join("\n"),
        );
    assert.notEqual(boundFeatureSource, featureSource);
    await writeFile(featurePath, boundFeatureSource);

    const configPath = join(project, "supacloud.config.ts");
    const originalConfig = await readFile(configPath, "utf8");
    const preservedArtifacts = new Map<string, string>();
    for (const file of await readdir(join(project, "generated"))) {
        preservedArtifacts.set(file, await readFile(join(project, "generated", file), "utf8"));
    }
    async function assertMissingCapability(): Promise<void> {
        for (const action of ["compile", "check"]) {
            const blocked = JSON.parse(await run([cli, "app", action, "--format", "json"], project, false));
            assert.equal(blocked.ok, false);
            assert.deepEqual(blocked.written, []);
            assert.ok(blocked.diagnostics.some((diagnostic: { code: string; severity: string }) =>
                diagnostic.severity === "error" && diagnostic.code === "command-rpc-unavailable"));
            for (const [file, content] of preservedArtifacts) {
                assert.equal(await readFile(join(project, "generated", file), "utf8"), content);
            }
        }
    }
    await assertMissingCapability();
    await writeFile(join(project, "generation.base.config.ts"), originalConfig);
    const persistentConfig = `import base from "./generation.base.config";
import { defineSupacloudConfig } from "@supacloud/compiler";

export default defineSupacloudConfig({
  ...base,
  commandCapabilities: {
    ...base.commandCapabilities,
    requirePersistentAdapters: true,
    rpc: { approveCase: { boundary: "database", transaction: true, idempotency: true, audit: true } },
  },
});
`;
    const rpcOnlyConfig = `import base from "./generation.base.config";
import { defineSupacloudConfig } from "@supacloud/compiler";

export default defineSupacloudConfig({
  ...base,
  commandCapabilities: {
    ...base.commandCapabilities,
    rpc: { approveCase: { boundary: "database", transaction: true, idempotency: true, audit: true } },
  },
});
`;
    await writeFile(configPath, persistentConfig);
    const featureCompile = JSON.parse(await run([cli, "app", "compile", "--format", "json"]));
    assert.equal(featureCompile.ok, true);
    assert.ok(featureCompile.written.length > 0);
    const featureCheck = JSON.parse(await run([cli, "app", "check", "--format", "json"]));
    assert.equal(featureCheck.ok, true);
    assert.deepEqual(featureCheck.written, []);
    assert.ok(featureCheck.modules.includes("case-approval"));
    await run(["test", "src/features/case-approval/case-approval.feature.test.ts"]);
    await run(["run", "build"]);
    await writeFile(join(project, "scripts/verify-built-feature.mjs"), `import { strict as assert } from "node:assert";
import { createApp } from "../output/supacloud/application.js";

assert.throws(() => createApp({
    deps: {}, requestContext: () => ({}), commandGovernance: { authorize: () => {} },
}), { code: "COMMAND_RPC_UNCONFIGURED" });
console.log("Built feature: missing named runtime RPC prevents startup");
`);
    console.log(await run(["scripts/verify-built-feature.mjs"]));
    // Rebuild the same generated slice without adapter bindings so the runtime
    // fixture proves missing ports fail closed after the strict compile path.
    const unboundFeatureSource = featureSource.replace(
        [
            '    requiredAdapters: [',
            '        "CaseApprovalReader",',
            '        "CaseApprovalWriter",',
            '        "CaseApprovalReceipts",',
            '        "CaseApprovalJobStatuses",',
            '        "CaseApprovalRefresher",',
            '    ],',
            '    requiredAdapterScopes: {',
            '        CaseApprovalReader: "request",',
            '        CaseApprovalWriter: "request",',
            '        CaseApprovalReceipts: "request",',
            '        CaseApprovalJobStatuses: "request",',
            '        CaseApprovalRefresher: "job",',
            '    },',
        ].join("\n"),
        "",
    );
    await writeFile(featurePath, unboundFeatureSource);
    await writeFile(configPath, rpcOnlyConfig);
    assert.equal(JSON.parse(await run([cli, "app", "compile", "--format", "json"])).ok, true);
    assert.equal(JSON.parse(await run([cli, "app", "check", "--format", "json"])).ok, true);
    const unboundApplication = await readFile(join(project, "generated/application.ts"), "utf8");
    assert.doesNotMatch(unboundApplication, /const caseApproval(?:Reader|Writer|Receipts|JobStatuses|Refresher) =/);
    await run(["run", "build"]);
    const unboundBundle = await readFile(join(project, "output/supacloud/application.js"), "utf8");
    assert.doesNotMatch(unboundBundle, /caseApproval(?:Reader|Writer|Receipts|JobStatuses|Refresher)\s*=/);
    await copyFile(join(repo, "scripts/fixtures/generated-feature.fixture"), join(project, "scripts/verify-generated-feature.ts"));
    await run(["run", "typecheck"]);
    console.log(await run(["scripts/verify-generated-feature.ts"]));
    for (const file of preservedArtifacts.keys()) {
        preservedArtifacts.set(file, await readFile(join(project, "generated", file), "utf8"));
    }
    await writeFile(configPath, originalConfig);
    await assertMissingCapability();
    await writeFile(configPath, persistentConfig);

    // The other lightweight template shares the root-generation code. Exercise
    // its real graph too, without scheduling or claiming any background job.
    const edge = join(temporary, "edge-project");
    await run([cli, "app", "init", "--root", edge, "--name", "edge-generation-acceptance", "--template", "edge"], runner);
    const edgeManifestPath = join(edge, "package.json");
    const edgeManifest = JSON.parse(await readFile(edgeManifestPath, "utf8"));
    assert.equal(edgeManifest.dependencies.elysia, "2.0.0-rc.0");
    for (const group of ["dependencies", "devDependencies"]) {
        for (const name of Object.keys(edgeManifest[group] ?? {})) {
            if (overrides[name]) edgeManifest[group][name] = overrides[name];
        }
    }
    edgeManifest.overrides = overrides;
    await writeFile(edgeManifestPath, JSON.stringify(edgeManifest, null, 2));
    await installStarterConsumer(edge, run);
    await run(["run", "check"], edge);
    await run(["run", "build"], edge);
    const edgeInspection = await run(["run", "inspect"], edge);
    assert.ok(edgeInspection.includes('"application-root"'));
    assert.ok(edgeInspection.includes('"sync"'));
    console.log("Packed HTTP/edge roots, resource and feature generation, runtime denial and artifact preservation passed; no database, deployment or production persistence was exercised.");
} finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await rm(temporary, { recursive: true, force: true });
}
