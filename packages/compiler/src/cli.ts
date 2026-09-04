#!/usr/bin/env node
import { resolve } from "node:path";
import { analyzeProject } from "./analyze";
import { checkProject, compileProject } from "./compile";
import { doctorProject, explainGraph, formatGraph } from "./inspect";
import { watchProject } from "./watch";
import type { Diagnostic, ModuleBoundaryPresetName } from "./types";

function printUsage(): void {
  console.log(`
@supacloud/compiler CLI

Usage:
  supacloud-compiler compile [rootDir] [options]
  supacloud-compiler check   [rootDir] [options]
  supacloud-compiler dev     [rootDir] [options]
  supacloud-compiler graph   [rootDir] [options]
  supacloud-compiler explain <name> [rootDir] [options]
  supacloud-compiler doctor  [rootDir] [options]

Commands:
  compile             Compile application modules and generate artifacts
  check               Check artifact drift and run governance gates
  dev                 Watch source files and recompile on changes
  graph               Print the discovered application graph
  explain             Explain a module, provider, or external token
  doctor              Run project and generated-artifact health checks

Options:
  --root, -r <dir>    Application source root (default: current directory or first positional argument)
  --out, -o <dir>     Artifact output directory (default: <rootDir>/generated)
  --strict            Treat all warnings as errors
  --client            Generate typed API client in client.ts
  --permissions       Generate typed permissions registry in permissions.ts
  --debounce <ms>     Debounce source changes in dev mode (default: 100)
  --json              Print machine-readable output for graph/explain/doctor
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
  if (!["compile", "check", "dev", "graph", "explain", "doctor"].includes(command)) {
    console.error(`Error: unknown command "${command}"`);
    printUsage();
    process.exit(1);
  }

  let rootDir = ".";
  let outDir: string | undefined;
  let strict = false;
  let generateClient = false;
  let generatePermissions = false;
  let preset: ModuleBoundaryPresetName | undefined;
  let debounceMs = 100;
  let query: string | undefined;
  let json = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--root" || arg === "-r") {
      rootDir = args[++i];
    } else if (arg === "--out" || arg === "-o") {
      outDir = args[++i];
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--client") {
      generateClient = true;
    } else if (arg === "--permissions") {
      generatePermissions = true;
    } else if (arg === "--debounce") {
      debounceMs = Number(args[++i]);
      if (!Number.isFinite(debounceMs) || debounceMs < 0) {
        console.error("Error: --debounce must be a non-negative number");
        process.exit(1);
      }
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--preset" || arg === "-p") {
      preset = args[++i] as ModuleBoundaryPresetName;
    } else if (!arg.startsWith("-") && rootDir === ".") {
      if (command === "explain" && !query) query = arg;
      else rootDir = arg;
    } else if (!arg.startsWith("-") && command === "explain" && !query) {
      query = arg;
    }
  }

  const resolvedRoot = resolve(process.cwd(), rootDir);
  const resolvedOut = outDir ? resolve(process.cwd(), outDir) : resolve(resolvedRoot, "generated");

  if (command === "compile") {
    const result = await compileProject({
      rootDir: resolvedRoot,
      outDir: resolvedOut,
      strict,
      moduleBoundaryPreset: preset,
      generateClient,
      generatePermissions,
    });

    printDiagnostics(result.diagnostics);

    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      console.error(`\nCompilation failed with ${errors.length} error(s).`);
      process.exit(1);
    }

    console.log(`\nCompilation succeeded. Generated artifacts:\n${result.written.map((f) => `  - ${f}`).join("\n")}`);
  } else if (command === "check") {
    const result = await checkProject({
      rootDir: resolvedRoot,
      outDir: resolvedOut,
      strict,
      moduleBoundaryPreset: preset,
      generateClient,
      generatePermissions,
    });

    printDiagnostics(result.diagnostics);

    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      console.error(`\nGovernance checks failed with ${errors.length} error(s).`);
      process.exit(1);
    }

    if (!result.upToDate) {
      console.error("\nArtifact drift detected:");
      for (const mismatch of result.mismatches) {
        console.error(`  - ${mismatch}`);
      }
      console.error("Run the compile command and commit the updated generated artifacts.");
      process.exit(1);
    }

    console.log("Artifact check passed: disk files match compiler output with no drift.");
  } else if (command === "dev") {
    const handle = watchProject({
      rootDir: resolvedRoot,
      outDir: resolvedOut,
      strict,
      moduleBoundaryPreset: preset,
      debounceMs,
      generateClient,
      generatePermissions,
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
  } else {
    const result = await checkProject({
      rootDir: resolvedRoot,
      outDir: resolvedOut,
      strict,
      moduleBoundaryPreset: preset,
    });
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

run().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
