import { analyzeProject } from "./analyze";
import { generateApplication, renderApplication } from "./generate";
import type { CheckProjectResult, CompileOptions, CompileResult, Diagnostic } from "./types";
import { validateGraph } from "./validate";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 完整编译流程：AST 分析 → 校验 → 生成静态工厂代码与 manifest。
 * 即使存在 error 级诊断也会照常写出文件，由调用方根据 diagnostics 决定是否采用。
 */
export async function compileProject(options: CompileOptions): Promise<CompileResult> {
  const graph = await analyzeProject(options.rootDir, options.include);
  const diagnostics: Diagnostic[] = [
    ...(graph.diagnostics ?? []),
    ...validateGraph(graph, {
      strict: options.strict,
      moduleBoundaryPreset: options.moduleBoundaryPreset,
      moduleBoundaries: options.moduleBoundaries,
      allowRouteCommandBindings: options.allowRouteCommandBindings,
      commandCapabilities: options.commandCapabilities,
      disallowControllerDirectDb: options.disallowControllerDirectDb,
      detectOrphanModules: options.detectOrphanModules,
    }),
  ];
  if (options.strict) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === "warn") diagnostic.severity = "error";
    }
  }
  const written = await generateApplication(graph, {
    rootDir: options.rootDir,
    outDir: options.outDir,
  });
  return { diagnostics, graph, written };
}

/**
 * 产物漂移检测（纯比对，不覆写磁盘文件）：
 * 分析 AST、执行架构与能力校验，并与当前磁盘上的 application.ts / app.manifest.json 比对。
 */
export async function checkProject(options: CompileOptions): Promise<CheckProjectResult> {
  const graph = await analyzeProject(options.rootDir, options.include);
  const diagnostics: Diagnostic[] = [
    ...(graph.diagnostics ?? []),
    ...validateGraph(graph, {
      strict: options.strict,
      moduleBoundaryPreset: options.moduleBoundaryPreset,
      moduleBoundaries: options.moduleBoundaries,
      allowRouteCommandBindings: options.allowRouteCommandBindings,
      commandCapabilities: options.commandCapabilities,
      disallowControllerDirectDb: options.disallowControllerDirectDb,
      detectOrphanModules: options.detectOrphanModules,
    }),
  ];
  if (options.strict) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === "warn") diagnostic.severity = "error";
    }
  }

  const rendered = renderApplication(graph, {
    rootDir: options.rootDir,
    outDir: options.outDir,
  });

  const expectedFiles: Record<string, string> = {
    "application.ts": rendered.applicationCode,
    "app.manifest.json": rendered.manifestJson,
  };

  const mismatches: string[] = [];
  for (const [filename, expectedContent] of Object.entries(expectedFiles)) {
    const diskPath = join(options.outDir, filename);
    if (!existsSync(diskPath)) {
      mismatches.push(`${filename}: 磁盘缺少已生成产物`);
      continue;
    }
    const diskContent = readFileSync(diskPath, "utf8");
    if (diskContent !== expectedContent) {
      mismatches.push(`${filename}: 磁盘产物与当前编译输出不一致`);
    }
  }

  return {
    upToDate: mismatches.length === 0,
    mismatches,
    diagnostics,
    graph,
  };
}
