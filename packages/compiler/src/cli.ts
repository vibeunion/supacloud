#!/usr/bin/env node
import { resolve } from "node:path";
import { checkProject, compileProject } from "./compile";
import type { ModuleBoundaryPresetName } from "./types";

function printUsage(): void {
  console.log(`
@supacloud/compiler CLI

Usage:
  supacloud-compiler compile [rootDir] [options]
  supacloud-compiler check   [rootDir] [options]

Commands:
  compile             Compile application modules and generate artifacts
  check               Check artifact drift and run governance gates

Options:
  --root, -r <dir>    Application source root (default: current directory or first positional argument)
  --out, -o <dir>     Artifact output directory (default: <rootDir>/generated)
  --strict            Treat all warnings as errors
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
  if (command !== "compile" && command !== "check") {
    console.error(`Error: unknown command "${command}"`);
    printUsage();
    process.exit(1);
  }

  let rootDir = ".";
  let outDir: string | undefined;
  let strict = false;
  let preset: ModuleBoundaryPresetName | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--root" || arg === "-r") {
      rootDir = args[++i];
    } else if (arg === "--out" || arg === "-o") {
      outDir = args[++i];
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--preset" || arg === "-p") {
      preset = args[++i] as ModuleBoundaryPresetName;
    } else if (!arg.startsWith("-") && rootDir === ".") {
      rootDir = arg;
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
    });

    for (const diag of result.diagnostics) {
      const loc = diag.file ? ` ${diag.file}${diag.line ? `:${diag.line}` : ""}` : "";
      const log = diag.severity === "error" ? console.error : console.warn;
      log(`[${diag.severity}] ${diag.code}${loc}: ${diag.message}`);
    }

    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      console.error(`\nCompilation failed with ${errors.length} error(s).`);
      process.exit(1);
    }

    console.log(`\nCompilation succeeded. Generated artifacts:\n${result.written.map((f) => `  - ${f}`).join("\n")}`);
  } else {
    const result = await checkProject({
      rootDir: resolvedRoot,
      outDir: resolvedOut,
      strict,
      moduleBoundaryPreset: preset,
    });

    for (const diag of result.diagnostics) {
      const loc = diag.file ? ` ${diag.file}${diag.line ? `:${diag.line}` : ""}` : "";
      const log = diag.severity === "error" ? console.error : console.warn;
      log(`[${diag.severity}] ${diag.code}${loc}: ${diag.message}`);
    }

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
  }
}

run().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
