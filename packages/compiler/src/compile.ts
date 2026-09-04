import { analyzeProject } from "./analyze";
import { generateApplication, renderApplication } from "./generate";
import type { CheckProjectResult, CompileOptions, CompileResult, Diagnostic } from "./types";
import { validateGraph } from "./validate";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Complete compilation pipeline: AST analysis -> validation -> generate static factory code and manifest.
 * Files are emitted even when error-level diagnostics exist; caller decides adoption based on diagnostics.
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
 * Check generated artifacts without writing files to disk.
 * Analyze the AST, run governance checks, and compare application.ts and app.manifest.json.
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
      mismatches.push(`${filename}: generated artifact is missing from disk`);
      continue;
    }
    const diskContent = readFileSync(diskPath, "utf8");
    if (diskContent !== expectedContent) {
      mismatches.push(`${filename}: disk artifact differs from current compiler output`);
    }
  }

  return {
    upToDate: mismatches.length === 0,
    mismatches,
    diagnostics,
    graph,
  };
}
