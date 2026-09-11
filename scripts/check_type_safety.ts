import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { discoverTypeSafetyProjects, inspectTypeSafetyProject } from "./type_safety_inventory";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args.some((arg) => !["--test", "--inventory", "--json"].includes(arg))) {
  throw new Error("Usage: bun run scripts/check_type_safety.ts [--test] [--inventory] [--json]");
}

type Manifest = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const projects = discoverTypeSafetyProjects(root);
let failed = false;
const checks: Array<{ project: string; check: string; ok: boolean; output?: string }> = [];
const built = new Set<string>();

function authoredTypecheckFailed(output: string, directory: string): boolean {
  const authored = resolve(directory);
  let current = "";
  let sawAuthoredError = false;
  for (const line of output.split("\n")) {
    const match = /^(\/\S+?):(\d+):(\d+)/.exec(line);
    if (match?.[1]) current = match[1];
    if (!/error TS|\bError:|\berror\b/i.test(line)) continue;
    if (!current) {
      sawAuthoredError = true;
      continue;
    }
    if (current.includes(`${sep}node_modules${sep}`)) continue;
    if (current.startsWith(authored)) sawAuthoredError = true;
  }
  return sawAuthoredError;
}

const execute = (
  project: string,
  directory: string,
  check: string,
  command: string,
  commandArgs: string[],
  authoredOnly = false,
) => {
  if (!args.includes("--json")) console.log(`\n[${project}] ${check}`);
  const result = spawnSync(command, commandArgs, { cwd: directory, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`;
  const ok = !result.error && (authoredOnly
    ? result.status === 0 || !authoredTypecheckFailed(output, directory)
    : result.status === 0);
  failed ||= !ok;
  checks.push({ project, check, ok, ...(!ok ? { output } : {}) });
  if (!args.includes("--json")) process.stdout.write(output);
  return ok;
};

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Manifest;
}

function ensureInstall(project: string, directory: string) {
  if (existsSync(join(directory, "node_modules"))) return;
  execute(project, directory, "install", "bun", ["install", "--frozen-lockfile"]);
}

function linkBuiltDist(depDir: string) {
  const dist = join(depDir, "dist");
  if (!existsSync(dist)) return;
  const name = (JSON.parse(readFileSync(join(depDir, "package.json"), "utf8")) as { name?: string }).name;
  if (!name) return;
  const parts = name.startsWith("@") ? name.split("/") : [name];
  for (const pkg of readdirSync(join(root, "packages"))) {
    const linked = join(root, "packages", pkg, "node_modules", ...parts);
    if (!existsSync(linked)) continue;
    const target = join(linked, "dist");
    if (existsSync(target)) continue;
    symlinkSync(dist, target);
  }
}

function packageReady(depDir: string): boolean {
  const pkg = JSON.parse(readFileSync(join(depDir, "package.json"), "utf8")) as { types?: string };
  if (typeof pkg.types === "string") return existsSync(join(depDir, pkg.types));
  return existsSync(join(depDir, "dist"));
}

function ensureWorkspaceBuilds(project: string, directory: string) {
  const manifest = readManifest(directory);
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const spec of Object.values(deps)) {
    if (!spec.startsWith("file:")) continue;
    const depDir = resolve(directory, spec.slice("file:".length));
    if (!existsSync(join(depDir, "package.json"))) continue;
    const dep = readManifest(depDir);
    const depName = (JSON.parse(readFileSync(join(depDir, "package.json"), "utf8")) as { name?: string }).name ?? depDir;
    ensureInstall(depName, depDir);
    ensureWorkspaceBuilds(depName, depDir);
    if (typeof dep.scripts?.build === "string" && !built.has(depDir) && !packageReady(depDir)) {
      if (!execute(depName, depDir, "build", "bun", ["run", "build"])) continue;
    }
    built.add(depDir);
    linkBuiltDist(depDir);
  }
}

for (const project of projects) {
  if (!project.svelte) continue;
  ensureInstall(project.name, project.directory);
  const svelteKit = join(project.directory, "node_modules", ".bin", "svelte-kit");
  if (existsSync(svelteKit)) spawnSync(svelteKit, ["sync"], { cwd: project.directory, encoding: "utf8" });
}

const inventory = projects.map(inspectTypeSafetyProject);
for (const item of inventory) {
  if (item.errors.length) {
    failed = true;
    if (!args.includes("--json")) {
      console.error(`[${item.name}] ${item.errors.join("; ")}`);
    }
  }
}

if (!args.includes("--inventory")) {
  for (const project of projects) {
    if (project.name === "workspace-tools") {
      execute(project.name, join(root, "scripts"), "tsconfig.commands.json",
        join(root, "packages", "compiler", "node_modules", ".bin", "tsc"),
        ["--noEmit", "-p", "tsconfig.commands.json"]);
      continue;
    }
    ensureInstall(project.name, project.directory);
    ensureWorkspaceBuilds(project.name, project.directory);
    const scripts = readManifest(project.directory).scripts ?? {};
    if (project.svelte && typeof scripts.check === "string") {
      execute(project.name, project.directory, "check", "bun", ["run", "check"], true);
      continue;
    }
    if (typeof scripts.typecheck === "string") {
      execute(project.name, project.directory, "typecheck", "bun", ["run", "typecheck"]);
    }
    if (typeof scripts["typecheck:consumer"] === "string") {
      if (typeof scripts.build === "string" && !packageReady(project.directory)) {
        execute(project.name, project.directory, "build", "bun", ["run", "build"]);
      }
      execute(project.name, project.directory, "typecheck:consumer", "bun", ["run", "typecheck:consumer"]);
    }
  }
}

if (args.includes("--test")) {
  execute("workspace-tools", root, "inventory-tests", process.execPath, ["test", "./scripts/type_safety_inventory.test.ts"]);
}

if (args.includes("--json")) {
  console.log(JSON.stringify({
    phase: args.includes("--inventory") ? "inventory" : "typecheck",
    ok: !failed, projects: inventory, checks,
  }, null, 2));
} else {
  console.log(`\n${projects.length} project inventories checked; ${failed ? "FAILED" : "PASSED"}.`);
  console.log("Third-party declarations, Git transport policy, browser memory, and full realtime compatibility are out of scope.");
}
process.exitCode = failed ? 1 : 0;
