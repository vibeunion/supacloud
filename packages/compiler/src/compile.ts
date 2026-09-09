import { analyzeProject } from "./analyze";
import { generateApplication, renderApplication, writeFileIfChanged } from "./generate";
import type { CheckProjectResult, CompileOptions, CompileResult, Diagnostic } from "./types";
import { validateGraph } from "./validate";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { scanGeneratedArtifacts, scanProductionSource } from "./type-safety";
import { validateRouteContracts } from "./route-contracts";
import type { GraphqlArtifacts } from "./graphql";

async function renderOptionalGraphql(options: CompileOptions): Promise<GraphqlArtifacts> {
  return options.graphql
    ? (await import("./graphql")).renderGraphql(options)
    : { diagnostics: [], files: {} };
}

/**
 * Complete compilation pipeline: AST analysis -> validation -> generate static factory code and manifest.
 * Errors preserve the last working artifacts unless writeOnError is explicitly enabled.
 */
export async function compileProject(options: CompileOptions): Promise<CompileResult> {
  const graph = await analyzeProject(options.rootDir, options.include, options.cache, options.changedPaths);
  const diagnostics: Diagnostic[] = [
    ...(graph.diagnostics ?? []),
    ...validateGraph(graph, options),
  ];
  if (options.strict) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === "warn") diagnostic.severity = "error";
    }
  }
  const typeSafety = resolveTypeSafety(options);
  const graphql = await renderOptionalGraphql(options);
  if (graphql.contract) graph.graphql = graphql.contract;
  diagnostics.push(...graphql.diagnostics);
  if (options.requireRouteContracts) diagnostics.push(...validateRouteContracts(graph));
  const rendered = renderApplication(graph, options);
  if (typeSafety.scanProductionSource) {
    diagnostics.push(...scanProductionSource({
      ...options,
      ...typeSafety,
    }));
  }
  if (typeSafety.noAnyInGenerated) {
    diagnostics.push(...scanGeneratedArtifacts({
      "application.ts": rendered.applicationCode,
      "client.ts": rendered.clientCode,
      "permissions.ts": rendered.permissionsCode,
      "graphql.ts": graphql.files["graphql.ts"],
      "graphql.documents.ts": graphql.files["graphql.documents.ts"],
    }, options.strict ?? false));
  }
  const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const generatedOptions = {
    ...options,
    ...(options.cache ? { artifactHashes: options.cache.generatedHashes } : {}),
  };
  const written = !hasErrors || options.writeOnError === true
    ? await generateApplication(graph, generatedOptions)
    : [];
  if (!hasErrors) {
    for (const [filename, content] of Object.entries(graphql.files)) {
      const path = join(options.outDir, filename);
      if (await writeFileIfChanged(path, content, options.cache?.generatedHashes)) written.push(path);
    }
  }
  const stats = graph.cacheStats
    ? {
        cacheHit: graph.cacheStats.reanalyzedModules.length === 0,
        changedFiles: [],
        affectedModules: graph.cacheStats.reanalyzedModules,
        reanalyzedModules: graph.cacheStats.reanalyzedModules,
        reusedModules: graph.cacheStats.reusedModules,
      }
    : undefined;
  return { diagnostics, graph, written, ...(stats ? { stats } : {}) };
}


/**
 * Check generated artifacts without writing files to disk.
 * Analyze the AST, run governance checks, and compare application.ts and app.manifest.json.
 */
export async function checkProject(options: CompileOptions): Promise<CheckProjectResult> {
  const graph = await analyzeProject(options.rootDir, options.include, options.cache, options.changedPaths);
  const diagnostics: Diagnostic[] = [
    ...(graph.diagnostics ?? []),
    ...validateGraph(graph, options),
  ];
  if (options.strict) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === "warn") diagnostic.severity = "error";
    }
  }

  const typeSafety = resolveTypeSafety(options);
  const graphql = await renderOptionalGraphql(options);
  if (graphql.contract) graph.graphql = graphql.contract;
  diagnostics.push(...graphql.diagnostics);
  if (options.requireRouteContracts) diagnostics.push(...validateRouteContracts(graph));
  const rendered = renderApplication(graph, options);
  if (typeSafety.scanProductionSource) {
    diagnostics.push(...scanProductionSource({
      ...options,
      ...typeSafety,
    }));
  }
  if (typeSafety.noAnyInGenerated) {
    diagnostics.push(...scanGeneratedArtifacts({
      "application.ts": rendered.applicationCode,
      "client.ts": rendered.clientCode,
      "permissions.ts": rendered.permissionsCode,
      "graphql.ts": graphql.files["graphql.ts"],
      "graphql.documents.ts": graphql.files["graphql.documents.ts"],
    }, options.strict ?? false));
  }

  const expectedFiles: Record<string, string> = {
    ...graphql.files,
    "application.ts": rendered.applicationCode,
    "app.manifest.json": rendered.manifestJson,
  };
  if (rendered.clientCode) {
    expectedFiles["client.ts"] = rendered.clientCode;
  }
  if (rendered.permissionsCode) {
    expectedFiles["permissions.ts"] = rendered.permissionsCode;
  }

  const mismatchResults = await Promise.all(
    Object.entries(expectedFiles).map(async ([filename, expectedContent]) => {
      const diskPath = join(options.outDir, filename);
      try {
        await access(diskPath);
        const diskContent = typeof Bun !== "undefined" && typeof Bun.file === "function"
          ? await Bun.file(diskPath).text()
          : await readFile(diskPath, "utf8");
        if (diskContent !== expectedContent) {
          return `${filename}: disk artifact differs from current compiler output`;
        }
      } catch {
        return `${filename}: generated artifact is missing from disk`;
      }
      return undefined;
    }),
  );
  const mismatches = mismatchResults.filter((item): item is string => item !== undefined);

  return {
    upToDate: mismatches.length === 0,
    mismatches,
    diagnostics,
    graph,
  };
}

function resolveTypeSafety(options: CompileOptions): NonNullable<CompileOptions["typeSafety"]> {
  return {
    noAnyInGenerated: options.typeSafety?.noAnyInGenerated ?? options.strict ?? false,
    scanProductionSource: options.typeSafety?.scanProductionSource ?? options.strict ?? false,
    ...(options.typeSafety?.exclude ? { exclude: options.typeSafety.exclude } : {}),
  };
}
