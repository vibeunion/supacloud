import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

type Project = {
  name: string;
  directory: string;
  tags: string[];
  dependencies: Set<string>;
};

type Issue = {
  code: string;
  file: string;
  message: string;
};

const root = resolve(import.meta.dir, "..");
const packagesRoot = join(root, "packages");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".svelte"]);
const requiredTags = ["scope:", "type:"];

const forbiddenDependencies = new Map<string, string[]>([
  ["type:compiler", ["type:runtime", "type:api", "type:app", "type:cli", "type:framework"]],
  ["type:framework", ["type:runtime", "type:api", "type:app", "type:cli", "type:compiler"]],
  ["type:database", ["type:runtime", "type:api", "type:app", "type:cli", "type:compiler"]],
  ["type:client", ["type:runtime", "type:api", "type:app", "type:cli", "type:admin"]],
  ["type:runtime", ["type:cli", "type:app", "type:admin"]],
]);

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (
      entry.name === "node_modules"
      || entry.name === "dist"
      || entry.name === "build"
      || entry.name === ".svelte-kit"
      || entry.name === "coverage"
      || entry.name === "test"
      || entry.name === "tests"
      || entry.name.endsWith(".test")
    ) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (
      sourceExtensions.has(extname(entry.name))
      && !entry.name.includes(".test.")
      && !entry.name.includes(".test-")
      && !entry.name.includes(".test_")
    ) files.push(path);
  }
  return files;
}

async function loadProjects(): Promise<Map<string, Project>> {
  const projects = new Map<string, Project>();
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(packagesRoot, entry.name);
    const packagePath = join(directory, "package.json");
    const projectPath = join(directory, "project.json");
    try {
      const packageJson = await readJson(packagePath);
      const projectJson = await readJson(projectPath);
      const name = typeof packageJson.name === "string" ? packageJson.name : entry.name;
      const tags = Array.isArray(projectJson.tags)
        ? projectJson.tags.filter((tag): tag is string => typeof tag === "string")
        : [];
      const dependencies = Object.keys({
        ...(typeof packageJson.dependencies === "object" && packageJson.dependencies ? packageJson.dependencies : {}),
        ...(typeof packageJson.devDependencies === "object" && packageJson.devDependencies ? packageJson.devDependencies : {}),
        ...(typeof packageJson.peerDependencies === "object" && packageJson.peerDependencies ? packageJson.peerDependencies : {}),
      });
      projects.set(name, { name, directory, tags, dependencies: new Set(dependencies) });
    } catch {
      // Packages without both manifests are intentionally outside the architecture graph.
    }
  }
  return projects;
}

function packageForFile(file: string, projects: Map<string, Project>): Project | undefined {
  for (const project of projects.values()) {
    const path = `${project.directory}/`;
    if (file.startsWith(path)) return project;
  }
  return undefined;
}

function targetProjectForImport(
  specifier: string,
  importer: Project,
  importerFile: string,
  projects: Map<string, Project>,
): Project | undefined {
  if (specifier.startsWith("@supacloud/")) {
    const name = [...projects.keys()].find((candidate) =>
      specifier === candidate || specifier.startsWith(`${candidate}/`));
    return name ? projects.get(name) : undefined;
  }
  if (!specifier.startsWith(".")) return undefined;
  const resolved = resolve(dirname(importerFile), specifier);
  return [...projects.values()].find((project) => {
    const path = `${project.directory}/`;
    return resolved.startsWith(path) && project !== importer;
  });
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("'") || trimmed.startsWith('"') || trimmed.startsWith("`")) continue;
    const staticImport = /^(?:import|export)\s+(?:type\s+)?[\s\S]*?\sfrom\s+["']([^"']+)["']/.exec(trimmed);
    const dynamicImport = /^import\s*\(\s*["']([^"']+)["']\s*\)/.exec(trimmed);
    const specifier = staticImport?.[1] ?? dynamicImport?.[1];
    if (specifier) specs.push(specifier);
  }
  return specs;
}

async function main() {
  const projects = await loadProjects();
  const issues: Issue[] = [];

  for (const project of projects.values()) {
    const scopeTag = project.tags.find((tag) => tag.startsWith("scope:"));
    const typeTag = project.tags.find((tag) => tag.startsWith("type:"));
    for (const prefix of requiredTags) {
      if (!project.tags.some((tag) => tag.startsWith(prefix))) {
        issues.push({
          code: "ARCH-001",
          file: relative(root, join(project.directory, "project.json")),
          message: `Package ${project.name} must declare a ${prefix} tag.`,
        });
      }
    }
    if (!scopeTag || !typeTag) continue;
    const banned = forbiddenDependencies.get(typeTag) ?? [];
    for (const dependency of project.dependencies) {
      const target = projects.get(dependency);
      if (!target) continue;
      if (banned.some((tag) => target.tags.includes(tag))) {
        issues.push({
          code: "ARCH-002",
          file: relative(root, join(project.directory, "package.json")),
          message: `${project.name} (${typeTag}) cannot depend on ${dependency} (${target.tags.join(", ")}).`,
        });
      }
    }
    for (const file of await walk(project.directory)) {
      const source = await readFile(file, "utf8");
      for (const specifier of new Set(importSpecifiers(source))) {
        const target = targetProjectForImport(specifier, project, file, projects);
        if (!target) continue;
        const metadataImport = specifier.endsWith("/package.json") || specifier === "../package.json";
        if (target !== project && specifier.startsWith(".")) {
          if (metadataImport) continue;
          issues.push({
            code: "ARCH-003",
            file: relative(root, file),
            message: `Cross-package relative import to ${target.name} is forbidden; use its package contract.`,
          });
        }
        if (!project.dependencies.has(target.name) && target !== project) {
          issues.push({
            code: "ARCH-004",
            file: relative(root, file),
            message: `${project.name} imports ${target.name} without declaring it as a dependency.`,
          });
        }
      }
    }
  }

  if (issues.length > 0) {
    for (const issue of issues) console.error(`ERROR [${issue.code}] ${issue.file}: ${issue.message}`);
    console.error(`\nFound ${issues.length} architecture issue(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(`✔ Architecture and production type-safety checks passed for ${projects.size} packages.`);
}

await main();
