import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAppAliases, registerAppTools, runAppTool, type ToolResult } from "./app-tools";

const roots: string[] = [];
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "resource-generation-"));
    roots.push(root);
    return root;
}
function data(result: ToolResult) { return JSON.parse(result.content.map((part) => part.text).join("\n")); }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("resource preview contains all six wired files and creates nothing", async () => {
    const root = await fixture();
    const result = await runAppTool({ action: "generate", kind: "resource", name: "inventory", root, "dry-run": true, format: "json" });
    const plan = data(result);
    expect(result.isError).toBe(false);
    expect(plan).toMatchObject({ version: 1, ok: true, written: false, kind: "resource" });
    expect(plan.changes).toHaveLength(6);
    expect(plan.changes.find((file: { path: string }) => file.path.endsWith(".module.ts")).content)
        .toContain("controllers: [InventoryController]");
    expect(plan.changes.find((file: { path: string }) => file.path.endsWith(".service.ts")).content)
        .toContain("Implement InventoryService.find");
    expect(await readdir(root)).toEqual([]);
});

test("resource apply writes the previewed sources without adding dependencies", async () => {
    const root = await fixture();
    const args = { action: "generate", kind: "resource", name: "inventory", root, format: "json" } as const;
    const preview = data(await runAppTool({ ...args, dry_run: true }));
    const applied = data(await runAppTool(args));
    expect(applied.written).toBe(true);
    for (const change of preview.changes) {
        expect(await readFile(join(root, change.path), "utf8")).toBe(change.content);
    }
    expect(await readdir(root)).toEqual(["src"]);
    expect(applied.changes.every((change: object) => !("content" in change))).toBe(true);
});

test("a resource conflict reports a structured error and leaves no partial files", async () => {
    const root = await fixture();
    await mkdir(join(root, "src/features/inventory"), { recursive: true });
    await writeFile(join(root, "src/features/inventory/inventory.service.ts"), "user source");
    const result = await runAppTool({ action: "generate", kind: "resource", name: "inventory", root, format: "json" });
    expect(result.isError).toBe(true);
    expect(data(result)).toMatchObject({ ok: false, code: "SCAFFOLD_EXISTS" });
    expect(await readdir(join(root, "src/features/inventory"))).toEqual(["inventory.service.ts"]);
});

test("explicit parent registration uses the existing compiler AST editor", async () => {
    const root = await fixture();
    const original = 'import { Module } from "@supacloud/app";\n@Module({ name: "root", imports: [], providers: [] })\nexport class RootModule {}\n';
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/root.module.ts"), original);
    const args = { action: "generate", kind: "resource", name: "inventory", root, "register-in": "src/root.module.ts", format: "json" } as const;
    const preview = data(await runAppTool({ ...args, "dry-run": true }));
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    expect(preview.changes).toHaveLength(7);
    expect(await readFile(join(root, "src/root.module.ts"), "utf8")).toBe(original);
    expect(await readdir(join(root, "src"))).toEqual(["root.module.ts"]);
    const applied = await runAppTool(args);
    expect(applied.isError, JSON.stringify(data(applied))).toBe(false);
    const source = await readFile(join(root, "src/root.module.ts"), "utf8");
    expect(source).toContain('from "./features/inventory/inventory.module"');
    expect(source).toContain("imports: [InventoryModule]");
});

test("dynamic parent metadata is rejected before writing a resource", async () => {
    const root = await fixture();
    const original = 'import { Module } from "@supacloud/app";\nconst modules = [];\n@Module({ name: "root", imports: modules })\nexport class RootModule {}\n';
    await writeFile(join(root, "root.module.ts"), original);
    const result = await runAppTool({ action: "generate", kind: "resource", name: "inventory", root, register_in: "root.module.ts", format: "json" });
    expect(result.isError).toBe(true);
    expect(await readdir(root)).toEqual(["root.module.ts"]);
    expect(await readFile(join(root, "root.module.ts"), "utf8")).toBe(original);
});

test("resource force and invalid kinds do not silently choose a different template", async () => {
    const root = await fixture();
    const forced = await runAppTool({ action: "generate", kind: "resource", name: "inventory", root, force: true, format: "json" });
    expect(data(forced)).toMatchObject({ ok: false, code: "SCAFFOLD_OPTION_INVALID" });
    // @ts-expect-error Simulate an untyped caller.
    const invalid = await runAppTool({ action: "generate", kind: "invalid", root, format: "json" });
    expect(data(invalid)).toMatchObject({ ok: false, code: "SCAFFOLD_KIND_INVALID" });
    expect(await readdir(root)).toEqual([]);
});

test("all existing single-file kinds support dry-run", async () => {
    const root = await fixture();
    for (const kind of ["module", "command", "query", "controller", "job", "contract"] as const) {
        const result = await runAppTool({ action: "generate", kind, name: "sample", module: "inventory", root, dry_run: true, format: "json" });
        expect(data(result)).toMatchObject({ ok: true, written: false });
        expect(data(result).changes).toHaveLength(1);
    }
    expect(await readdir(root)).toEqual([]);
});

test("outside directories and duplicate aliases fail without writing", async () => {
    const root = await fixture();
    const result = await runAppTool({ action: "generate", kind: "resource", name: "inventory", root, dir: "../outside", format: "json" });
    expect(data(result)).toMatchObject({ ok: false, code: "SCAFFOLD_PATH_INVALID" });
    await expect(runAppTool({ action: "generate", kind: "module", name: "inventory", root, "dry-run": true, dry_run: false }))
        .rejects.toMatchObject({ code: "SCAFFOLD_OPTION_INVALID" });
    await expect(runAppTool({ action: "init", root, dry_run: true }))
        .rejects.toMatchObject({ code: "SCAFFOLD_OPTION_INVALID" });
    expect(await readdir(root)).toEqual([]);
});

test("app and top-level generate expose the same resource and preview options", () => {
    const schemas: Record<string, Record<string, unknown>> = {};
    const server = { tool(name: string, _description: string, schema: Record<string, unknown>) { schemas[name] = schema; } };
    registerAppTools(server);
    registerAppAliases(server);
    for (const name of ["app", "generate"]) {
        expect(schemas[name]).toHaveProperty("dry_run");
        expect(schemas[name]).toHaveProperty("dry-run");
        expect(schemas[name]).toHaveProperty("register_in");
        expect(schemas[name]).toHaveProperty("register-in");
        expect(JSON.stringify(schemas[name]!.kind)).toContain("resource");
    }
});


test("registration refuses an existing symbol instead of changing its binding", async () => {
    const root = await fixture();
    const original = 'import { Module } from "@supacloud/app";\nimport { InventoryModule } from "./existing";\n@Module({ name: "root", imports: [InventoryModule] })\nexport class RootModule {}\n';
    await writeFile(join(root, "root.module.ts"), original);
    const result = await runAppTool({ action: "generate", kind: "resource", name: "inventory", root, register_in: "root.module.ts", format: "json" });
    expect(data(result)).toMatchObject({ ok: false, code: "SCAFFOLD_REGISTRATION_CONFLICT" });
    expect(await readdir(root)).toEqual(["root.module.ts"]);
    expect(await readFile(join(root, "root.module.ts"), "utf8")).toBe(original);
});

test("an explicit project-root feature directory remains supported", async () => {
    const root = await fixture();
    const result = await runAppTool({ action: "generate", kind: "module", name: "inventory", root, dir: ".", dry_run: true, format: "json" });
    expect(data(result).changes[0].path).toBe("inventory/inventory.module.ts");
    expect(await readdir(root)).toEqual([]);
});


test("generation flag normalization does not add fields to remote application requests", async () => {
    let forwarded: Record<string, unknown> | undefined;
    const result = await runAppTool({ action: "status", ref: "project-test", id: "app-test" }, {
        getApplications: () => async (args) => {
            forwarded = args;
            return { isError: false, content: [{ type: "text", text: "remote-status" }] };
        },
    });
    expect(result.isError).toBe(false);
    expect(forwarded).toMatchObject({ action: "get_runtime", ref: "project-test", id: "app-test" });
    expect(forwarded).not.toHaveProperty("dry_run");
    expect(forwarded).not.toHaveProperty("register_in");
});
