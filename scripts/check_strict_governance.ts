import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const strictCompilerOptions = [
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noPropertyAccessFromIndexSignature",
  "noFallthroughCasesInSwitch",
] as const;

const effectGovernanceOptions = [
  "requireRouteEffects",
  "requireErrorMappings",
  "requireDependencies",
  "requireTaggedErrorTypes",
  "requireExactDependencyTypes",
  "requireTimeoutForDependencies",
  "forbidDirectRuntimeExecution",
  "forbidDirectThrows",
] as const;

const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function readJson(path: string): JsonRecord {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const value = record(parsed);
  if (!value) throw new Error(`${path} must contain a JSON object`);
  return value;
}

function readText(root: string, path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function hasTrueProperty(source: string, property: string): boolean {
  return new RegExp(`\\b${property}\\s*:\\s*true\\b`).test(source);
}

export function checkStrictGovernance(root: string): string[] {
  const problems: string[] = [];
  const strictPath = resolve(root, "tsconfig.strict.json");
  const toolsPath = resolve(root, "tsconfig.tools.json");
  const strictConfig = readJson(strictPath);
  const strictOptions = record(strictConfig["compilerOptions"]);
  if (!strictOptions) {
    problems.push("tsconfig.strict.json must declare compilerOptions.");
  } else {
    for (const option of strictCompilerOptions) {
      if (strictOptions[option] !== true) problems.push(`tsconfig.strict.json must enable ${option}.`);
    }
  }

  const toolsConfig = readJson(toolsPath);
  if (toolsConfig["extends"] !== "./tsconfig.strict.json") {
    problems.push("tsconfig.tools.json must extend ./tsconfig.strict.json.");
  }
  const toolsOptions = record(toolsConfig["compilerOptions"]);
  for (const option of strictCompilerOptions) {
    if (toolsOptions?.[option] === false) problems.push(`tsconfig.tools.json must not disable ${option}.`);
  }

  for (const path of [
    "packages/cli/src/shared/tools/app-starter.ts",
    "packages/cli/src/shared/tools/app-starter-templates.ts",
  ]) {
    const source = readText(root, path);
    for (const option of strictCompilerOptions) {
      if (!hasTrueProperty(source, option)) problems.push(`${path} must generate ${option}: true.`);
    }
  }

  const compilerConfig = readText(root, "packages/compiler/src/config.ts");
  for (const option of effectGovernanceOptions) {
    if (!hasTrueProperty(compilerConfig, option)) {
      problems.push(`packages/compiler/src/config.ts must default effect.${option} to true.`);
    }
  }

  const compatibility = readJson(resolve(root, "packages/elysia/compatibility.json"));
  const compatibilityPackages = record(compatibility["packages"]);
  const effectVersion = compatibilityPackages?.["effect"];
  if (effectVersion !== "4.0.2") {
    problems.push("packages/elysia/compatibility.json must pin Effect to 4.0.2.");
  }

  const packagesRoot = resolve(root, "packages");
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = resolve(packagesRoot, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    for (const section of dependencySections) {
      const dependencies = record(manifest[section]);
      const declared = dependencies?.["effect"];
      if (declared !== undefined && declared !== effectVersion) {
        problems.push(`${manifestPath}: ${section}.effect must equal ${String(effectVersion)}.`);
      }
    }
  }

  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dir, "..");
  const problems = checkStrictGovernance(root);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Strict TypeScript, Effect 4, starter, and runtime governance defaults are enabled.");
  }
}
