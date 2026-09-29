/**
 * Candidate-package acceptance, not a source-import shortcut. The only reused
 * starter helpers manage subprocess lifetime and frozen consumer installation.
 * Application/resource generation is performed by the installed, packed CLI.
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
environment.HOME = join(temporary, "home");
environment.USERPROFILE = environment.HOME;
environment.XDG_CONFIG_HOME = join(environment.HOME, ".config");
environment.BUN_TMPDIR = join(temporary, "bun-tmp");
async function run(args: string[], cwd = project, success = true): Promise<string> {
    return runStarterCommand(args, { cwd, env: environment, signal: interruption.signal, success, timeoutMs: 180_000 });
}

try {
    await mkdir(runner, { recursive: true });
    await mkdir(environment.HOME, { recursive: true });
    await mkdir(environment.BUN_TMPDIR, { recursive: true });
    const overrides: Record<string, string> = {};
    for (const name of ["contracts", "commands", "delivery", "compiler", "db", "app", "elysia", "cli"]) {
        const directory = join(repo, "packages", name);
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
    assert.equal(generatedManifest.dependencies.elysia, "2.0.0-beta.19");
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
import { InventoryService } from "../src/features/inventory/inventory.service";
import type { InventoryResult } from "../src/features/inventory/inventory.model";

const typedResult: InventoryResult = { id: "example" };
// @ts-expect-error Response fields come from the schema, not an unknown/any cast.
const invalidResult: InventoryResult = { id: 1 };
void typedResult; void invalidResult;

const version = await Bun.file("node_modules/elysia/package.json").json();
assert.equal(version.version, "2.0.0-beta.19");
const module = createCompiledModules().find(value => value.name === "inventory");
assert.ok(module);
const services = module.createServices({}, {});
const service = Object.values(services).find(value => value instanceof InventoryService);
assert.ok(service instanceof InventoryService);
const app = new Elysia().use(createModulePlugin(module, services));
// Elysia 2 seals registration on its first request; mount every route first.
app.get("/native-generation-probe", {}, () => ({ native: true }));
const unavailable = await app.handle(new Request("http://localhost/inventory/example"));
assert.equal(unavailable.status, 500);
assert.ok(!(await unavailable.text()).includes("Implement InventoryService"));
let calls = 0;
// Test double on this test-owned instance only. No generated business file changes.
service.find = async id => { calls++; return { id }; };
const invalid = await app.handle(new Request("http://localhost/inventory/%20"));
assert.equal(invalid.status, 422);
assert.equal(calls, 0);
const accepted = await app.handle(new Request("http://localhost/inventory/example"));
assert.equal(accepted.status, 200);
assert.deepEqual(await accepted.json(), { id: "example" });
assert.equal(calls, 1);
service.find = async () => { calls++; throw new Error("private async read failure"); };
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
import { createApp } from "../dist/application.js";

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
    assert.ok(!(await placeholder.text()).includes("Implement InventoryService"));
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
    // The other lightweight template shares the root-generation code. Exercise
    // its real graph too, without scheduling or claiming any background job.
    const edge = join(temporary, "edge-project");
    await run([cli, "app", "init", "--root", edge, "--name", "edge-generation-acceptance", "--template", "edge"], runner);
    const edgeManifestPath = join(edge, "package.json");
    const edgeManifest = JSON.parse(await readFile(edgeManifestPath, "utf8"));
    assert.equal(edgeManifest.dependencies.elysia, "2.0.0-beta.19");
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
    console.log("Packed HTTP/edge roots, async resource, built application and read-only inspection passed; no deployment or production persistence was exercised.");
} finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await rm(temporary, { recursive: true, force: true });
}
