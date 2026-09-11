import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "../packages/compiler/node_modules/@typescript/typescript6/lib/typescript.js";

export interface TypeSafetyProject {
  name: string;
  directory: string;
  configs: string[];
  svelte: boolean;
  typecheckScript?: string;
  sourceIncludes?: string[];
}

export interface TypeSafetyInventory {
  name: string;
  configs: string[];
  files: number;
  uncovered: string[];
  errors: string[];
}

const requiredOptions = ["strict", "skipLibCheck"] as const;
const strictOptions = [
  "noImplicitAny", "strictNullChecks", "strictFunctionTypes", "strictBindCallApply",
  "strictPropertyInitialization", "noImplicitThis", "useUnknownInCatchVariables",
  "alwaysStrict",
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function discoverTypeSafetyProjects(root: string): TypeSafetyProject[] {
  const projects: TypeSafetyProject[] = [];
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, "packages", entry.name);
    const path = join(directory, "package.json");
    if (!existsSync(path)) throw new Error(`Package directory has no manifest: ${entry.name}`);
    const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!record(manifest) || typeof manifest.name !== "string") {
      throw new Error(`Invalid package manifest: ${entry.name}`);
    }
    const scripts = record(manifest.scripts) ? manifest.scripts : {};
    const typecheckScript = typeof scripts.typecheck === "string" ? "typecheck"
      : typeof scripts.check === "string" ? "check" : undefined;
    projects.push({
      name: manifest.name,
      directory,
      configs: ["tsconfig.json", "tsconfig.test.json",
        ...(existsSync(join(directory, "tsconfig.consumer.json")) ? ["tsconfig.consumer.json"] : [])],
      svelte: existsSync(join(directory, "svelte.config.js")),
      ...(typecheckScript ? { typecheckScript } : {}),
    });
  }
  projects.sort((a, b) => a.directory.localeCompare(b.directory));
  projects.push({
    name: "workspace-tools",
    directory: root,
    configs: ["scripts/tsconfig.commands.json"],
    svelte: false,
    sourceIncludes: [
      "scripts/verify-command-migration.ts",
      "scripts/build-command-dependencies.ts",
      "scripts/prepare-command-test-database.ts",
      ".github/scripts/prepare-command-package.mjs",
      ".github/scripts/prepare-command-package.test.mjs",
      ".github/scripts/package-validation.mjs",
    ],
  });
  return projects;
}

export function inspectTypeSafetyProject(project: TypeSafetyProject): TypeSafetyInventory {
  const errors: string[] = [];
  const covered = new Set<string>();
  for (const name of project.configs) {
    const path = join(project.directory, name);
    if (!existsSync(path)) {
      errors.push(`Missing ${name}`);
      continue;
    }
    const read = ts.readConfigFile(path, ts.sys.readFile);
    if (read.error) {
      errors.push(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, project.directory, {}, path, undefined, [
      { extension: ".svelte", isMixedContent: true, scriptKind: ts.ScriptKind.Deferred },
    ]);
    for (const error of parsed.errors) errors.push(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
    for (const option of requiredOptions) {
      if (parsed.options[option] !== true) errors.push(`${name}: ${option} must be true`);
    }
    for (const option of strictOptions) {
      if (parsed.options[option] === false) errors.push(`${name}: ${option} must not override strict`);
    }
    for (const file of parsed.fileNames) {
      if (/\.[cm]?js$/.test(file) && parsed.options.checkJs !== true) continue;
      covered.add(resolve(file));
    }
  }
  const candidates = ts.sys.readDirectory(
    project.directory,
    [".ts", ".tsx", ".mts", ".cts", ".svelte", ".js", ".mjs", ".cjs"],
    ["**/node_modules/**", "**/dist/**", "**/.svelte-kit/**", "**/.git/**", "**/coverage/**",
      ...(project.svelte ? ["build/**"] : [])],
    project.sourceIncludes ?? ["**/*"],
  );
  const uncovered = candidates.filter((file) => !covered.has(resolve(file)))
    .map((file) => relative(project.directory, file)).sort();
  return { name: project.name, configs: project.configs, files: candidates.length, uncovered, errors };
}
