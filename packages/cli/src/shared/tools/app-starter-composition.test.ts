import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeAppProject } from "./app-starter";
import { appTemplateFiles } from "./app-starter-templates";
import { resourceScaffold } from "./app-resource";

const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

for (const [template, feature, source] of [
    ["http", "OrdersFeature", "./orders/orders"],
    ["edge", "SyncFeature", "./sync/sync"],
] as const) {
    test(`${template} starter declares its actual feature in an application composition root`, () => {
        const files = appTemplateFiles("composition-test", template);
        const root = files["src/app.module.ts"];
        expect(root).toContain(`import { ${feature} } from "${source}"`);
        expect(root).toContain('name: "application-root"');
        expect(root).toContain('tags: ["type:app"]');
        expect(root).toContain(`imports: [${feature}]`);
        expect(root).not.toContain("createApplication");
        expect(files[`src/${source.slice(2)}.ts`]).toContain(`export const ${feature}`);
        expect(files["supacloud.config.ts"]).toContain('moduleBoundaryPreset: "modular-monolith"');
        expect(files["supacloud.config.ts"]).toContain("detectOrphanModules: true");
        const manifest = JSON.parse(files["package.json"]!);
        expect(manifest.dependencies.elysia).toBe("2.0.0-beta.19");
        expect(manifest.scripts.inspect).toBe("bun --no-env-file node_modules/@supacloud/compiler/dist/cli.js graph --json");
        expect(files["README.md"]).toContain("--register-in src/app.module.ts");
        expect(files["README.md"]).toContain("not a live mounted-route report");
    });

    test(`${template} init writes the documented root and never rewrites an existing project`, async () => {
        const root = await mkdtemp(join(tmpdir(), `starter-${template}-composition-`));
        roots.push(root);
        const expected = appTemplateFiles("composition-test", template);
        await initializeAppProject({ root, name: "composition-test", template });
        const actual = await readFile(join(root, "src/app.module.ts"), "utf8");
        expect(actual).toBe(expected["src/app.module.ts"]);
        await expect(initializeAppProject({ root, name: "composition-test", template })).rejects.toThrow();
        expect(await readFile(join(root, "src/app.module.ts"), "utf8")).toBe(actual);
    });
}

test("resource generation is async-ready without adding another validator or persistence library", () => {
    const files = resourceScaffold("inventory", "Inventory");
    expect(files["inventory.service.ts"]).toContain("async find(_id: string): Promise<InventoryResult>");
    expect(files["inventory.controller.ts"]).toContain('find(@Param("id") id: string): Promise<InventoryResult>');
    expect(files["inventory.service.ts"]).not.toContain('from "elysia"');
    expect(files["inventory.model.ts"]).toContain("RouteHandlerOutput");
    expect(files["inventory.service.test.ts"]).toContain(".rejects.toThrow");
    expect(files["inventory.controller.test.ts"]).toContain(".rejects.toBe(failure)");
    expect(files["inventory.controller.test.ts"]).toContain("expect(await controller.find");
    expect(Object.keys(files)).toHaveLength(6);
});
