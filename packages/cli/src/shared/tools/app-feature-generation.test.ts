import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject } from "@supacloud/compiler";
import { registerAppAliases, registerAppTools, runAppTool, type ToolResult } from "./app-tools";

const roots: string[] = [];
const feature = {
    action: "generate", kind: "feature", name: "case-approval",
    permission: "cases:approve", rpc: "approveCase", format: "json",
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
    expect(preview.changes).toHaveLength(6);
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
        { permission: undefined }, { rpc: undefined }, { permission: " " },
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
        expect(schemas[name]).toHaveProperty("rpc");
    }
});

async function generatedFixture() {
    const root = await fixture();
    expect((await runAppTool({ ...feature, root })).isError).toBe(false);
    await symlink(join(import.meta.dir, "../../../node_modules"), join(root, "node_modules"), "dir");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            experimentalDecorators: true, strict: true, skipLibCheck: true,
            module: "ESNext", moduleResolution: "bundler", target: "ES2022", noEmit: true,
            paths: {
                "@supacloud/app/core": [join(import.meta.dir, "../../../../app/src/core.ts")],
                "@supacloud/app": [join(import.meta.dir, "../../../../app/src/core.ts")],
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
    expect(compiled.graph.modules[0]?.featureSpec?.transitions[0]?.permission).toBe("cases:approve");
    expect(compiled.graph.modules[0]?.commands[0]?.rpc).toBe("approveCase");
    expect(compiled.graph.modules[0]?.queries).toHaveLength(1);
    const factoryPath = join(root, "generated/application.ts");
    const before = await readFile(factoryPath, "utf8");
    const missingAdapter = await compileProject(options);
    expect(missingAdapter.diagnostics.some(item => item.severity === "error" && item.code.startsWith("command-"))).toBe(true);
    expect(missingAdapter.written).toEqual([]);
    expect(await readFile(factoryPath, "utf8")).toBe(before);
}, { timeout: 30_000 });

test("the generated approval tests enforce read and write adapter boundaries", async () => {
    const root = await generatedFixture();
    const child = Bun.spawn([
        process.execPath, "--no-env-file", "test", "src/features/case-approval/case-approval.feature.test.ts",
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ code, errors: code ? stdout + stderr : "" }).toEqual({ code: 0, errors: "" });
}, { timeout: 30_000 });

test("the generated approval passes strict TypeScript checking", async () => {
    const root = await generatedFixture();
    const types = Bun.spawn([
        process.execPath, join(root, "node_modules/typescript/bin/tsc"), "--project", join(root, "tsconfig.json"),
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [typeCode, typeOut, typeErr] = await Promise.all([
        types.exited, new Response(types.stdout).text(), new Response(types.stderr).text(),
    ]);
    expect({ code: typeCode, errors: typeCode ? typeOut + typeErr : "" }).toEqual({ code: 0, errors: "" });
}, { timeout: 30_000 });
