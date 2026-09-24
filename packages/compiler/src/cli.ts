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
import { GraphqlConfigurationError } from "./graphql-options";
import { planDeliveryProject, formatDeliveryPlan } from "./delivery-plan";
import { DeliveryConfigurationError } from "./delivery-schema";
import { buildDeliveryProject } from "./delivery-build";
import { migrateProject } from "./migrations";
import {
  assessMigration,
  formatMigrationAssessment,
  type MigrationRenderMode,
} from "./migration-assess";
import {
  diffOpenApiDocuments,
  exportGeneratedOpenApiJson,
  formatOpenApiDiff,
  OpenApiDocumentError,
  readOpenApiJson,
} from "./openapi-tools";

function isModuleBoundaryPresetName(value: string | undefined): value is ModuleBoundaryPresetName {
  return value === "modular-monolith"
    || value === "feature-slices"
    || value === "vertical-slices"
    || value === "angular-enterprise"
    || value === "angular"
    || value === "clean-architecture"
    || value === "domain-driven";
}

function isMigrationRenderMode(value: string | undefined): value is MigrationRenderMode {
  return value === "unspecified"
    || value === "browser"
    || value === "ssr"
    || value === "edge"
    || value === "trusted-server";
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
  supacloud-compiler context <name> [rootDir] [options]
  supacloud-compiler doctor  [rootDir] [options]
  supacloud-compiler migrate [rootDir] [options]
  supacloud-compiler migration-assess [rootDir] [options]
  supacloud-compiler plan    [rootDir] [options]
  supacloud-compiler build-delivery [rootDir] [options]
  supacloud-compiler openapi-export <openapi-module> <output.json> [options]
  supacloud-compiler openapi-diff <base.json> <current.json> [options]
  supacloud-compiler fix     <fix.json> [options]
  supacloud-compiler graphql-schema --url <project-url> --key-env <name> [--token-env <name>]
  supacloud-compiler database-contracts <config.json> [--check]

Commands:
  compile             Compile application modules and generate artifacts
  check               Check artifact drift and run governance gates
  dev                 Watch source files and recompile on changes
  graph               Print the discovered application graph
  explain             Explain a module, provider, or external token
  context             Extract an AI-sized module context pack
  doctor              Run project and generated-artifact health checks
  migrate             Preview or apply versioned source migrations
  migration-assess    Produce a read-only migration compatibility report
  plan                Preview deterministic workload targets without writing or deploying
  build-delivery      Build independent local factories and an atomic delivery manifest (Bun)
  openapi-export      Export a generated OpenAPI module to a standalone JSON document
  openapi-diff        Compare two OpenAPI JSON documents and fail on breaking changes
  graphql-schema      Explicitly export a caller-scoped schema to the configured local file

Options:
  --root, -r <dir>    Application source root (default: ./src, or first positional argument)
  --out, -o <dir>     Artifact output directory (default: ./generated)
  --strict            Enable type-safety gates and treat all warnings as errors (default)
  --no-strict         Disable strict diagnostics (local migration escape hatch)
  --client            Generate typed API client in client.ts (default)
  --no-client         Do not generate client.ts
  --openapi           Generate OpenAPI 3.1 module in openapi.ts (default)
  --no-openapi        Do not generate openapi.ts
  --permissions       Generate typed permissions registry (default)
  --no-permissions    Do not generate permissions.ts
  --no-graphql        Explicitly disable configured GraphQL contracts for this run
  --url <url>         Project base URL for graphql-schema (HTTPS outside loopback)
  --key-env <name>    Environment variable holding a public project key; never the key itself
  --token-env <name>  Environment variable holding the intended user's access token
  --check             graphql-schema: compare the remote schema without changing the snapshot
  --debounce <ms>     Debounce source changes in dev mode (default: 100)
  --json              Print machine-readable output for compile/check/graph/explain/context/doctor/migration-assess/plan/build-delivery/openapi-export/openapi-diff
  --space <n>         openapi-export: JSON indentation (0-10, default: 2)
  --delivery <file>   plan/build-delivery: validated JSON configuration (overrides config.delivery)
  --dry-run           Preview a fix without writing the target file
  --write             Apply a fix or migration to disk (preview-only by default)
  --from-version      Migration source-format checkpoint (requires --to-version)
  --to-version        Migration target checkpoint; verifies installed dependencies
  --baseline-openapi  OpenAPI baseline JSON for migration-assess
  --current-openapi   Current OpenAPI JSON for migration-assess
  --render-mode       Optional browser | ssr | edge | trusted-server label; SSR is never required
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
  if (command === "database-contracts") {
    const path = args[1];
    if (!path || path.startsWith("-") || args.slice(2).some((arg) => arg !== "--check")) {
      throw new Error("database-contracts requires <config.json> and optional --check");
    }
    const { runDatabaseContractsFile } = await import("./database-contracts");
    const result = await runDatabaseContractsFile(path, args.includes("--check"));
    console.log(JSON.stringify(result, null, 2));
    if (args.includes("--check") && !result.upToDate) process.exitCode = 1;
    return;
  }
  if (!command || !["compile", "check", "dev", "graph", "explain", "context", "doctor", "migrate", "migration-assess", "fix", "graphql-schema", "plan", "build-delivery", "openapi-export", "openapi-diff"].includes(command)) {
    console.error(`Error: unknown command "${command}"`);
    printUsage();
    process.exit(1);
  }

  let rootDir: string | undefined;
  let outDir: string | undefined;
  let strict: boolean | undefined;
  let generateClient: boolean | undefined;
  let generateOpenApi: boolean | undefined;
  let generatePermissions: boolean | undefined;
  let preset: ModuleBoundaryPresetName | undefined;
  let debounceMs: number = 100;
  let query: string | undefined;
  let json: boolean = false;
  let dryRun = true;
  let fromVersion: string | undefined;
  let toVersion: string | undefined;
  let noGraphql = false;
  let projectUrl: string | undefined;
  let keyEnv: string | undefined;
  let tokenEnv: string | undefined;
  let checkSchema = false;
  let deliveryPath: string | undefined;
  let baselineOpenApi: string | undefined;
  let currentOpenApi: string | undefined;
  let renderMode: MigrationRenderMode = "unspecified";
  const openApiDiffPaths: string[] = [];
  const openApiExportPaths: string[] = [];
  let openApiExportSpace: number | undefined;
  const deliveryCommand = command === "plan" || command === "build-delivery";
  const openApiDiffCommand = command === "openapi-diff";
  const openApiExportCommand = command === "openapi-export";
  const planFlags = new Set([
    "--delivery", "--root", "-r", "--out", "-o", "--strict", "--no-strict",
    "--client", "--no-client", "--permissions", "--no-permissions", "--no-graphql",
    "--openapi", "--no-openapi",
    "--json", "--dry-run", "--preset", "-p",
  ]);
  const planValueFlags = new Set(["--delivery", "--root", "-r", "--out", "-o", "--preset", "-p"]);

  for (let i: number = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) throw new Error("Missing command-line argument");
    if (openApiDiffCommand && arg.startsWith("-") && arg !== "--json") {
      throw new Error("openapi-diff accepts only --json and two JSON file paths");
    }
    if (openApiExportCommand && arg.startsWith("-") && arg !== "--json" && arg !== "--space") {
      throw new Error("openapi-export accepts --json, --space and two file paths");
    }
    if (deliveryCommand && arg.startsWith("-")) {
      if (!planFlags.has(arg)) throw new Error("Unsupported plan argument");
      if (command === "build-delivery" && arg === "--dry-run") throw new Error("Use plan for read-only previews");
      const next = args[i + 1];
      if (planValueFlags.has(arg) && (!next || next.startsWith("-"))) {
        throw new Error("Plan option requires a value");
      }
    }
    if (arg === "--delivery") {
      deliveryPath = args[++i];
      if (!deliveryCommand || !deliveryPath || deliveryPath.startsWith("-")) {
        throw new Error("--delivery requires a JSON file and a delivery command");
      }
    } else if (arg === "--root" || arg === "-r") {
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
    } else if (arg === "--openapi") {
      generateOpenApi = true;
    } else if (arg === "--no-openapi") {
      generateOpenApi = false;
    } else if (arg === "--permissions") {
      generatePermissions = true;
    } else if (arg === "--no-permissions") {
      generatePermissions = false;
    } else if (arg === "--no-graphql") {
      noGraphql = true;
    } else if (arg === "--check") {
      checkSchema = true;
    } else if (arg === "--url" || arg === "--key-env" || arg === "--token-env") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--url") projectUrl = value;
      else if (arg === "--key-env") keyEnv = value;
      else tokenEnv = value;
    } else if (arg === "--debounce") {
      debounceMs = Number(args[++i]);
      if (!Number.isFinite(debounceMs) || debounceMs < 0) {
        console.error("Error: --debounce must be a non-negative number");
        process.exit(1);
      }
    } else if (openApiExportCommand && arg === "--space") {
      const value = args[++i];
      const space = Number(value);
      if (!value || !Number.isInteger(space) || space < 0 || space > 10) {
        throw new Error("openapi-export --space must be an integer from 0 to 10");
      }
      openApiExportSpace = space;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--write") {
      if (command === "plan" || command === "migration-assess") throw new Error(`${command} is read-only; --write is not supported`);
      dryRun = false;
    } else if (arg === "--baseline-openapi" || arg === "--current-openapi") {
      if (command !== "migration-assess") throw new Error(`${arg} is only supported by migration-assess`);
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a JSON file path`);
      if (arg === "--baseline-openapi") baselineOpenApi = value;
      else currentOpenApi = value;
    } else if (arg === "--render-mode") {
      if (command !== "migration-assess") throw new Error("--render-mode is only supported by migration-assess");
      const value = args[++i];
      if (!isMigrationRenderMode(value)) {
        throw new Error("--render-mode requires browser, ssr, edge or trusted-server");
      }
      renderMode = value;
    } else if (arg === "--from-version" || arg === "--to-version") {
      if (command !== "migrate") throw new Error(`${arg} is only supported by migrate`);
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a version`);
      if (arg === "--from-version") fromVersion = value;
      else toVersion = value;
    } else if (arg === "--preset" || arg === "-p") {
      const presetArg = args[++i];
      if (!isModuleBoundaryPresetName(presetArg)) {
        console.error(`Error: --preset requires a known preset, received "${presetArg ?? ""}"`);
        process.exit(1);
      }
      preset = presetArg;
    } else if (openApiDiffCommand && !arg.startsWith("-")) {
      openApiDiffPaths.push(arg);
    } else if (openApiExportCommand && !arg.startsWith("-")) {
      openApiExportPaths.push(arg);
    } else if (!arg.startsWith("-") && !rootDir) {
      if ((command === "explain" || command === "context" || command === "fix") && !query) query = arg;
      else rootDir = arg;
    } else if (!arg.startsWith("-") && (command === "explain" || command === "context" || command === "fix") && !query) {
      query = arg;
    } else if (deliveryCommand) {
      throw new Error("Unsupported plan argument");
    }
  }

  if (openApiDiffCommand) {
    if (openApiDiffPaths.length !== 2) {
      throw new Error("openapi-diff requires exactly two JSON file paths: <base.json> <current.json>");
    }
    const basePath = openApiDiffPaths[0];
    const currentPath = openApiDiffPaths[1];
    if (!basePath || !currentPath) throw new Error("openapi-diff requires two JSON file paths");
    const result = diffOpenApiDocuments(
      await readOpenApiJson(resolve(process.cwd(), basePath)),
      await readOpenApiJson(resolve(process.cwd(), currentPath)),
    );
    console.log(json ? JSON.stringify(result, null, 2) : formatOpenApiDiff(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (openApiExportCommand) {
    if (openApiExportPaths.length !== 2) {
      throw new Error("openapi-export requires exactly two file paths: <openapi-module> <output.json>");
    }
    const modulePath = openApiExportPaths[0];
    const outputPath = openApiExportPaths[1];
    if (!modulePath || !outputPath) throw new Error("openapi-export requires an OpenAPI module and output path");
    const result = await exportGeneratedOpenApiJson({
      modulePath: resolve(process.cwd(), modulePath),
      outputPath: resolve(process.cwd(), outputPath),
      ...(openApiExportSpace === undefined ? {} : { space: openApiExportSpace }),
    });
    console.log(json ? JSON.stringify({ ok: true, ...result }, null, 2)
      : result.written ? `OpenAPI JSON written: ${result.path}` : `OpenAPI JSON matches: ${result.path}`);
    return;
  }

  if (command === "migrate") {
    const result = await migrateProject({
      rootDir: rootDir ? resolve(process.cwd(), rootDir) : process.cwd(),
      write: !dryRun,
      ...(fromVersion === undefined ? {} : { fromVersion }),
      ...(toVersion === undefined ? {} : { toVersion }),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const action = result.write ? "changed" : "would change";
      const lines = [`${action} ${result.changedFiles.length} file(s)`];
      for (const file of result.files) {
        lines.push(`  ${file.file}: ${file.replacements} replacement(s)`);
      }
      for (const issue of result.issues) lines.push(`  ${issue.file}:${issue.line ?? 0} ${issue.code}: ${issue.message}`);
      if (result.changedFiles.length === 0 && result.issues.length === 0) lines.push("  no migrations required");
      console.log(lines.join("\n"));
    }
    if (result.issues.length > 0) process.exitCode = 1;
    return;
  }

  const loadedConfig = await loadSupacloudConfig(process.cwd());
  if (checkSchema && command !== "graphql-schema") throw new Error("--check is only supported by graphql-schema");
  const defaults = resolveSupacloudConfig(loadedConfig, process.cwd());
  const resolvedRoot = rootDir ? resolve(process.cwd(), rootDir) : defaults.rootDir;
  const resolvedOut = outDir ? resolve(process.cwd(), outDir) : defaults.outDir;
  const configured = compileOptionsFromConfig({
    ...loadedConfig,
    root: resolvedRoot,
    outDir: resolvedOut,
    ...(strict === undefined ? {} : { strict }),
    ...(generateClient === undefined ? {} : { generateClient }),
    ...(generateOpenApi === undefined ? {} : { generateOpenApi }),
    ...(generatePermissions === undefined ? {} : { generatePermissions }),
    ...(noGraphql ? { graphql: false } : {}),
  }, process.cwd());
  const compileDefaults = {
    ...configured,
    ...(preset ? { moduleBoundaryPreset: preset } : {}),
  };

  if (deliveryCommand) {
    let delivery: unknown = loadedConfig.delivery;
    if (deliveryPath !== undefined) {
      try {
        delivery = JSON.parse(await readFile(resolve(process.cwd(), deliveryPath), "utf8"));
      } catch {
        throw new DeliveryConfigurationError();
      }
    }
    if (command === "build-delivery") {
      const result = await buildDeliveryProject(compileDefaults, delivery);
      console.log(json ? JSON.stringify(result, null, 2) : result.ok
        ? `Local delivery artifacts built. Changed: ${result.changedTargets.join(", ") || "-"}. Unchanged: ${result.unchangedTargets.join(", ") || "-"}. No deployment performed.`
        : result.diagnostics.map((item) => `${item.code}: ${item.message}\n${item.suggestion ?? ""}`).join("\n"));
      if (!result.ok) process.exitCode = 1;
    } else {
      const result = await planDeliveryProject(compileDefaults, delivery);
      console.log(json ? JSON.stringify(result, null, 2) : formatDeliveryPlan(result));
      if (!result.ok) process.exitCode = 1;
    }
  } else if (command === "graphql-schema") {
    if (!projectUrl) throw new Error("graphql-schema requires --url with an explicit project URL");
    if (!compileDefaults.graphql) throw new Error("graphql-schema requires graphql configuration");
    const credential = (name: string | undefined): string | undefined => {
      if (!name) return undefined;
      const value = process.env[name];
      if (!value) throw new Error(`Required environment variable ${name} is empty`);
      return value;
    };
    const { pullGraphqlSchema } = await import("./graphql-schema");
    const publishableKey = credential(keyEnv);
    const accessToken = credential(tokenEnv);
    const result = await pullGraphqlSchema({
      url: projectUrl,
      output: compileDefaults.graphql.schema,
      ...(publishableKey === undefined ? {} : { publishableKey }),
      ...(accessToken === undefined ? {} : { accessToken }),
      check: checkSchema,
    });
    console.log(json ? JSON.stringify({ ok: result.upToDate, ...result }, null, 2)
      : result.written ? `GraphQL schema written: ${result.path}`
      : result.upToDate ? `GraphQL schema matches: ${result.path}`
      : `GraphQL schema drift: ${result.path}. Export the role-scoped snapshot and compile before promotion.`);
    if (!result.upToDate) process.exit(1);
  } else if (command === "migration-assess") {
    const result = await assessMigration({
      projectDir: process.cwd(),
      compile: compileDefaults,
      ...(baselineOpenApi === undefined ? {} : { baselineOpenApiPath: baselineOpenApi }),
      ...(currentOpenApi === undefined ? {} : { currentOpenApiPath: currentOpenApi }),
      renderMode,
    });
    console.log(json ? JSON.stringify(result, null, 2) : formatMigrationAssessment(result));
    if (result.status === "breaking" || result.status === "unsupported") process.exitCode = 1;
  } else if (command === "fix") {
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
      console.error("Error: context requires a module or owned symbol name");
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
          ...(pack.graphql ? [
            `  graphql schema: ${pack.graphql.schema}`,
            `  graphql queries: ${pack.graphql.operations.map((operation) => operation.name).join(", ") || "-"}`,
          ] : []),
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
      printDiagnostics(doctor.diagnostics ?? []);
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
  if (process.argv[2] === "openapi-diff" || process.argv[2] === "openapi-export" || err instanceof OpenApiDocumentError) {
    const diagnostic = {
      severity: "error" as const,
      code: err instanceof OpenApiDocumentError
        ? err.code
        : process.argv[2] === "openapi-export" ? "openapi-export-failed" : "openapi-diff-failed",
      message: err instanceof OpenApiDocumentError
        ? err.message
        : process.argv[2] === "openapi-export"
          ? "OpenAPI export requires a generated module and a writable JSON output path."
          : "OpenAPI diff requires exactly two valid JSON documents.",
    };
    const result = { ok: false, breaking: [], changes: [], diagnostics: [diagnostic] };
    if (process.argv.slice(2).includes("--json")) console.log(JSON.stringify(result, null, 2));
    else console.error(`${diagnostic.code}: ${diagnostic.message}`);
    process.exitCode = 1;
    return;
  }
  if (process.argv[2] === "plan" || process.argv[2] === "build-delivery" || err instanceof DeliveryConfigurationError) {
    const result = {
      ok: false, written: [],
      ...(process.argv[2] === "build-delivery" ? { manifest: null, bundledTargets: [] } : { plan: null }),
      diagnostics: [{
        severity: "error",
        code: err instanceof DeliveryConfigurationError ? err.code : "delivery-planning-failed",
        message: err instanceof DeliveryConfigurationError ? err.message
          : "Planning failed. Check source/configuration paths and supported plan arguments.",
      }],
    };
    console.log(process.argv.slice(2).includes("--json") ? JSON.stringify(result, null, 2)
      : result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  if (err instanceof GraphqlConfigurationError) {
    const diagnostic: Diagnostic = {
      code: err.code,
      severity: "error",
      message: err.message,
      suggestion: "Configure a local role-scoped snapshot exported by graphql-schema; author only queries and fragments.",
    };
    if (process.argv.slice(2).includes("--json")) {
      console.log(JSON.stringify({ ok: false, diagnostics: [diagnostic], written: [] }, null, 2));
    } else {
      printDiagnostics([diagnostic]);
    }
    process.exit(1);
  }
  console.error("Unhandled error:", err);
  process.exit(1);
});
