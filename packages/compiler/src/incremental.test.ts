import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDependencyGraphCache, createIncrementalCompiler, ModuleDependencyGraph } from "./incremental";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";
import type { ModuleNode } from "./types";

describe("createIncrementalCompiler", () => {
  test("相同输入命中缓存，单文件修改计算受影响模块", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-incremental-"));
    await writeFixtureProject(rootDir, GOOD_PROJECT_FILES);
    const outDir = join(rootDir, "generated");
    const compiler = createIncrementalCompiler();

    const first = await compiler.compile({ rootDir, outDir });
    expect(first.stats.cacheHit).toBe(false);
    expect(first.stats.affectedModules).toEqual(["audit", "case", "health"]);

    const second = await compiler.compile({ rootDir, outDir });
    expect(second.stats.cacheHit).toBe(true);
    expect(second.stats.changedFiles).toEqual([]);
    expect(second.stats.affectedModules).toEqual([]);

    await appendFile(join(rootDir, "src/features/health/health.module.ts"), "\n", "utf8");
    const third = await compiler.compile({ rootDir, outDir });
    expect(third.stats.cacheHit).toBe(false);
    expect(third.stats.changedFiles).toContain("src/features/health/health.module.ts");
    expect(third.stats.affectedModules).toEqual(["health"]);
    expect(third.stats.reusedModules).toContain("audit");
    expect(third.stats.reusedModules).toContain("case");
    expect(third.stats.reanalyzedModules).toEqual(["health"]);

    await writeFile(join(rootDir, "src/plain.ts"), "export const value = 1;\n", "utf8");
    const fourth = await compiler.compile({ rootDir, outDir }, ["src/plain.ts"]);
    expect(fourth.stats.cacheHit).toBe(true);
    expect(fourth.stats.changedFiles).toEqual(["src/plain.ts"]);
    expect(fourth.written).toEqual([]);
  });

  test("模块依赖图增量缓存：单模块修改仅重解析受影响模块并复用未受影响模块节点", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-cache-"));
    await writeFixtureProject(rootDir, GOOD_PROJECT_FILES);
    const outDir = join(rootDir, "generated");
    const cache = createDependencyGraphCache();
    const compiler = createIncrementalCompiler();

    const first = await compiler.compile({ rootDir, outDir, cache });
    expect(first.stats.reusedModules).toEqual([]);
    expect(first.stats.reanalyzedModules).toEqual(["audit", "case", "health"]);
    expect(cache.modules.has("audit")).toBe(true);
    expect(cache.modules.has("case")).toBe(true);
    expect(cache.modules.has("health")).toBe(true);

    const auditEntryBefore = cache.modules.get("audit");

    // 修改 health 模块文件
    await appendFile(join(rootDir, "src/features/health/health.module.ts"), "\n// health ping\n", "utf8");
    const second = await compiler.compile({ rootDir, outDir, cache });
    expect(second.stats.reanalyzedModules).toEqual(["health"]);
    expect(second.stats.reusedModules).toContain("audit");
    expect(second.stats.reusedModules).toContain("case");
    // audit 模块对象从缓存原样复用，未重新扫描
    expect(cache.modules.get("audit")?.module).toBe(auditEntryBefore?.module);
  });

  test("ModuleDependencyGraph tracks forward imports, reverse dependents, and computes affected closures", () => {
    const modules: ModuleNode[] = [
      {
        name: "core",
        className: "CoreModule",
        file: "src/core/core.module.ts",
        line: 1,
        imports: [],
        providers: [{ token: "CoreService", tokenKind: "class", kind: "class", scope: "application", deps: [], file: "src/core/core.service.ts", line: 1, exported: true }],
        controllers: [],
        commands: [],
        queries: [],
        exports: ["CoreService"],
      },
      {
        name: "auth",
        className: "AuthModule",
        file: "src/auth/auth.module.ts",
        line: 1,
        imports: ["core"],
        providers: [{ token: "AuthService", tokenKind: "class", kind: "class", scope: "application", deps: ["CoreService"], file: "src/auth/auth.service.ts", line: 1, exported: true }],
        controllers: [],
        commands: [],
        queries: [],
        exports: ["AuthService"],
      },
      {
        name: "dashboard",
        className: "DashboardModule",
        file: "src/dashboard/dashboard.module.ts",
        line: 1,
        imports: ["auth"],
        providers: [],
        controllers: [],
        commands: [],
        queries: [],
        exports: [],
      },
    ];

    const graph = new ModuleDependencyGraph(modules);
    expect(graph.getDirectImports("auth")).toEqual(["core"]);
    expect(graph.getDirectImports("dashboard")).toEqual(["auth"]);
    expect(graph.getDirectDependents("core")).toEqual(["auth"]);
    expect(graph.getDirectDependents("auth")).toEqual(["dashboard"]);

    // Modifying core file affects core, auth (depends on core), and dashboard (depends on auth)
    const affectedByCore = graph.getAffectedModules(["src/core/core.service.ts"]);
    expect(affectedByCore).toContain("core");
    expect(affectedByCore).toContain("auth");
    expect(affectedByCore).toContain("dashboard");

    // Modifying dashboard only affects dashboard
    const affectedByDashboard = graph.getAffectedModules(["src/dashboard/dashboard.module.ts"]);
    expect(affectedByDashboard).toEqual(["dashboard"]);
  });
});
