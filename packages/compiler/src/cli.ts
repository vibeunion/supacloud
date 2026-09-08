#!/usr/bin/env node
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { analyzeProject } from "./analyze";
import { checkProject, compileProject } from "./compile";
import { createContextPack, doctorProject, explainGraph, formatGraph } from "./inspect";
import { watchProject } from "./watch";
import type { Diagnostic, ModuleBoundaryPresetName } from "./types";
import { compileOptionsFromConfig, loadSupacloudConfig, resolveSupacloudConfig } from "./config";
import { applyDiagnosticFix } from "./fixes";

function isModuleBoundaryPresetName(value: string | undefined): value is ModuleBoundaryPresetName {
  return value === "modular-monolith"
    || value === "feature-slices"
    || value === "vertical-slices"
    || value === "angular-enterprise"
    || value === "angular"
    || value === "clean-architecture"
    || value === "domain-driven";
}

function printUsage(): void {
  console.log(`
@supacloud/compiler CLI

Usage:
  supacloud-compiler compile [rootDir] [options]
  supacloud-compiler check   [rootDir] [options]
  supacloud-compiler dev     [rootDir] [options]
  supacloud-compiler graph   [rootDir] [options]
  supacloud-compiler explain <name> [rootDir] [options]
  supacloud-compiler context <module> [rootDir] [options]
  supacloud-compiler doctor  [rootDir] [options]
  supacloud-compiler fix     <fix.json> [options]

Commands:
  compile             Compile application modules and generate artifacts
  check               Check artifact drift and run governance gates
  dev                 Watch source files and recompile on changes
  graph               Print the discovered application graph
  explain             Explain a module, provider, or external token
  context             Extract an AI-sized module context pack
  doctor              Run project and generated-artifact health checks

Options:
  --root, -r <dir>    Application source root (default: ./src, or first positional argument)
  --out, -o <dir>     Artifact output directory (default: ./generated)
  --strict            Enable type-safety gates and treat all warnings as errors (default)
  --no-strict         Disable strict diagnostics (local migration escape hatch)
  --client            Generate typed API client in client.ts (default)
  --no-client         Do not generate client.ts
  --permissions       Generate typed permissions registry (default)
  --no-permissions    Do not generate permissions.ts
  --debounce <ms>     Debounce source changes in dev mode (default: 100)
  --json              Print machine-readable output for compile/check/graph/explain/context/doctor
  --dry-run           Preview a fix without writing the target file
  --write             Apply a fix to disk (fix is preview-only by default)
  --preset, -p <name> Architecture preset ('modular-monolith' | 'angular-enterprise' | 'clean-architecture')
  --help, -h          Show this help
`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  if (!["compile", "check", "dev", "graph", "explain", "context", "doctor", "fix"].includes(command)) {
    console.error(`Error: unknown command "${command}"`);
    printUsage();
    process.exit(1);
  }

  let rootDir: string | undefined;
  let outDir: string | undefined;
  let strict: boolean | undefined;
  let generateClient: boolean | undefined;
  let generatePermissions: boolean | undefined;
  let preset: ModuleBoundaryPresetName | undefined;
  let debounceMs: number = 100;
  let query: string | undefined;
  let json: boolean = false;
  let dryRun = true;

  for (let i: number = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--root" || arg === "-r") {
      rootDir = args[++i];
    } else if (arg === "--out" || arg === "-o") {
      outDir = args[++i];
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--no-strict") {
      strict = false;
    } else if (arg === "--client") {
      generateClient = true;
    } else if (arg === "--no-client") {
      generateClient = false;
    } else if (arg === "--permissions") {
      generatePermissions = true;
    } else if (arg === "--no-permissions") {
      generatePermissions = false;
    } else if (arg === "--debounce") {
      debounceMs = Number(args[++i]);
      if (!Number.isFinite(debounceMs) || debounceMs < 0) {
        console.error("Error: --debounce must be a non-negative number");
        process.exit(1);
      }
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--write") {
      dryRun = false;
    } else if (arg === "--preset" || arg === "-p") {
      const presetArg = args[++i];
      if (!isModuleBoundaryPresetName(presetArg)) {
        console.error(`Error: --preset requires a known preset, received "${presetArg ?? ""}"`);
        process.exit(1);
      }
      preset = presetArg;
    } else if (!arg.startsWith("-") && !rootDir) {
      if ((command === "explain" || command === "context" || command === "fix") && !query) query = arg;
      else rootDir = arg;
    } else if (!arg.startsWith("-") && (command === "explain" || command === "context" || command === "fix") && !query) {
      query = arg;
    }
  }

  const loadedConfig = await loadSupacloudConfig(process.cwd());
  const defaults = resolveSupacloudConfig(loadedConfig, process.cwd());
  const resolvedRoot = rootDir ? resolve(process.cwd(), rootDir) : defaults.rootDir;
  const resolvedOut = outDir ? resolve(process.cwd(), outDir) : defaults.outDir;
  const configured = compileOptionsFromConfig({
    ...loadedConfig,
    root: resolvedRoot,
    outDir: resolvedOut,
    strict: strict ?? loadedConfig.strict,
    generateClient: generateClient ?? loadedConfig.generateClient,
    generatePermissions: generatePermissions ?? loadedConfig.generatePermissions,
  }, process.cwd());
  const compileDefaults = {
    ...configured,
    moduleBoundaryPreset: preset ?? configured.moduleBoundaryPreset,
  };

  if (command === "fix") {
    if (!query) throw new Error("fix requires a JSON file containing one DiagnosticFix");
    const fix = JSON.parse(await readFile(resolve(process.cwd(), query), "utf8"));
    const result = await applyDiagnosticFix(fix, { rootDir: resolvedRoot, dryRun });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else if (command === "compile") {
    const result = await compileProject(compileDefaults);

    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (json) {
      console.log(JSON.stringify({
        ok: errors.length === 0,
        diagnostics: result.diagnostics,
        written: result.written,
        stats: result.stats,
      }, null, 2));
    } else {
      printDiagnostics(result.diagnostics);
    }
    if (errors.length > 0) {
      if (!json) console.error(`\nCompilation failed with ${errors.length} error(s).`);
      process.exit(1);
    }

    if (!json) {
      console.log(`\nCompilation succeeded. Generated artifacts:\n${result.written.map((f) => `  - ${f}`).join("\n")}`);
    }
  } else if (command === "check") {
    const result = await checkProject(compileDefaults);

    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (json) {
      console.log(JSON.stringify({
        ok: errors.length === 0 && result.upToDate,
        upToDate: result.upToDate,
        mismatches: result.mismatches,
        diagnostics: result.diagnostics,
      }, null, 2));
    } else {
      printDiagnostics(result.diagnostics);
    }
    if (errors.length > 0) {
      if (!json) console.error(`\nGovernance checks failed with ${errors.length} error(s).`);
      process.exit(1);
    }

    if (!result.upToDate) {
      if (!json) {
        console.error("\nArtifact drift detected:");
        for (const mismatch of result.mismatches) {
          console.error(`  - ${mismatch}`);
        }
        console.error("Run the compile command and commit the updated generated artifacts.");
      }
      process.exit(1);
    }

    if (!json) console.log("Artifact check passed: disk files match compiler output with no drift.");
  } else if (command === "dev") {
    const handle = watchProject({
      ...compileDefaults,
      debounceMs,
      onEvent: (event) => {
        if (event.type === "compile-start") {
          console.log(event.initial ? "\nInitial compilation..." : "\nSource change detected; compiling...");
          return;
        }
        printDiagnostics(event.diagnostics);
        if (event.type === "compile-error") {
          console.error(`Compilation failed; keeping the last successful artifacts (${event.durationMs}ms).`);
        } else {
          const cache = event.stats?.cacheHit ? "cache hit" : "recompiled";
          const affected = event.stats?.affectedModules?.length
            ? `; affected modules: ${event.stats.affectedModules.join(", ")}`
            : "";
          console.log(`Compilation succeeded in ${event.durationMs}ms (${cache}${affected}).`);
        }
      },
    });

    const close = async (): Promise<void> => {
      await handle.close();
      process.exit(0);
    };
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
    await handle.ready;
    await new Promise<void>(() => undefined);
  } else if (command === "graph") {
    const graph = await analyzeProject(resolvedRoot);
    if (json) console.log(JSON.stringify(graph, null, 2));
    else console.log(formatGraph(graph));
  } else if (command === "explain") {
    if (!query) {
      console.error("Error: explain requires a module, provider, or external token name");
      process.exit(1);
    }
    try {
      const graph = await analyzeProject(resolvedRoot);
      const explanation = explainGraph(graph, query);
      if (json) console.log(JSON.stringify({ subject: query, explanation }, null, 2));
      else console.log(explanation);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else if (command === "context") {
    if (!query) {
      console.error("Error: context requires a module name");
      process.exit(1);
    }
    try {
      const result = await checkProject(compileDefaults);
      const pack = createContextPack({ ...result.graph, diagnostics: result.diagnostics }, query);
      if (json) {
        console.log(JSON.stringify(pack, null, 2));
      } else {
        console.log([
          `CONTEXT ${pack.subject}`,
          `  modules: ${pack.modules.map((module) => module.name).join(", ") || "-"}`,
          `  files: ${pack.files.join(", ") || "-"}`,
          `  external tokens: ${pack.externalTokens.join(", ") || "-"}`,
          `  imports: ${pack.relatedModules.imports.join(", ") || "-"}`,
          `  imported by: ${pack.relatedModules.importedBy.join(", ") || "-"}`,
          ...pack.executionPlans.map((plan) => `  execution ${plan.name}: ${plan.stages.join(" -> ")}`),
          ...pack.diagnostics.map((diagnostic) => `  ${diagnostic.code}: ${diagnostic.message}`),
        ].join("\n"));
      }
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2));
      } else {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      process.exit(1);
    }
  } else {
    const result = await checkProject(compileDefaults);
    const doctor = doctorProject(resolvedRoot, resolvedOut, result.graph, result.upToDate, result.diagnostics);
    if (json) {
      console.log(JSON.stringify(doctor, null, 2));
    } else {
      for (const check of doctor.checks) console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`);
      printDiagnostics(doctor.diagnostics);
    }
    if (doctor.errors > 0) process.exit(1);
  }
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const diag of diagnostics) {
    const loc = diag.file ? ` ${diag.file}${diag.line ? `:${diag.line}` : ""}` : "";
    const log = diag.severity === "error" ? console.error : console.warn;
    log(`[${diag.severity}] ${diag.code}${loc}: ${diag.message}`);
    if (diag.suggestion) {
      console.log(`  Hint: ${diag.suggestion}`);
    }
  }
}

run().catch((err: unknown) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
