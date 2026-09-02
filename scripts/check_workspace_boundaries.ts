import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

interface ProjectConfig {
  name: string;
  tags?: string[];
  path: string;
  dependencies: string[];
  devDependencies: string[];
}

interface BoundaryRule {
  sourceTag: string;
  bannedDependenciesWithTags?: string[];
  onlyDependOnLibsWithTags?: string[];
  description?: string;
}

const WORKSPACE_BOUNDARY_RULES: BoundaryRule[] = [
  {
    sourceTag: "type:compiler",
    bannedDependenciesWithTags: ["type:runtime", "type:api", "type:app", "type:cli", "type:framework"],
    description: "Compiler must remain a pure AST analysis tool and cannot depend on runtime or app packages.",
  },
  {
    sourceTag: "type:framework",
    bannedDependenciesWithTags: ["type:runtime", "type:api", "type:app", "type:cli", "type:compiler"],
    description: "Core framework metadata (@supacloud/app) must not depend on runtime, API, or compiler.",
  },
  {
    sourceTag: "type:database",
    bannedDependenciesWithTags: ["type:runtime", "type:api", "type:app", "type:cli", "type:compiler"],
    description: "Database core (@supacloud/db) must not depend on runtime, API, or CLI.",
  },
  {
    sourceTag: "type:client",
    bannedDependenciesWithTags: ["type:runtime", "type:api", "type:app", "type:cli", "type:admin"],
    description: "SDK client (@supacloud/js) must remain lightweight and cannot depend on server packages.",
  },
  {
    sourceTag: "type:runtime",
    bannedDependenciesWithTags: ["type:cli", "type:app", "type:admin"],
    description: "Runtimes must not depend on UI console, CLI, or admin operations.",
  },
];

async function loadProjects(packagesDir: string): Promise<Map<string, ProjectConfig>> {
  const projects = new Map<string, ProjectConfig>();
  const entries = await readdir(packagesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgDirPath = join(packagesDir, entry.name);
    const pkgJsonPath = join(pkgDirPath, "package.json");
    const projectJsonPath = join(pkgDirPath, "project.json");

    let pkgJson: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
      pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8"));
    } catch {
      continue;
    }

    let tags: string[] = [];
    try {
      const projectJson = JSON.parse(await readFile(projectJsonPath, "utf8"));
      tags = projectJson.tags ?? [];
    } catch {
      // If project.json does not exist, tags remain empty
    }

    const name = pkgJson.name ?? entry.name;
    projects.set(name, {
      name,
      tags,
      path: pkgDirPath,
      dependencies: Object.keys(pkgJson.dependencies ?? {}),
      devDependencies: Object.keys(pkgJson.devDependencies ?? {}),
    });
  }

  return projects;
}

function checkBoundaries(projects: Map<string, ProjectConfig>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [name, project] of projects) {
    const sourceTags = project.tags ?? [];
    const allDeps = [...project.dependencies];

    for (const depName of allDeps) {
      const targetProject = projects.get(depName);
      if (!targetProject) continue; // External npm package

      const targetTags = targetProject.tags ?? [];

      for (const rule of WORKSPACE_BOUNDARY_RULES) {
        const matchesSource = rule.sourceTag === "*" || sourceTags.includes(rule.sourceTag);
        if (!matchesSource) continue;

        if (rule.bannedDependenciesWithTags) {
          for (const bannedTag of rule.bannedDependenciesWithTags) {
            if (targetTags.includes(bannedTag)) {
              errors.push(
                `[Boundary Violation] Package "${name}" (tags: [${sourceTags.join(", ")}]) must not depend on "${depName}" (tags: [${targetTags.join(", ")}]). Reason: ${rule.description ?? "Banned by tag rule"}`,
              );
            }
          }
        }

        if (rule.onlyDependOnLibsWithTags && rule.onlyDependOnLibsWithTags.length > 0) {
          const hasAllowed = targetTags.some((t) => rule.onlyDependOnLibsWithTags!.includes(t));
          if (!hasAllowed && targetTags.length > 0) {
            errors.push(
              `[Boundary Violation] Package "${name}" (tags: [${sourceTags.join(", ")}]) is only allowed to depend on packages with tags [${rule.onlyDependOnLibsWithTags.join(", ")}], but "${depName}" has tags [${targetTags.join(", ")}].`,
            );
          }
        }
      }
    }
  }

  // Circular dependency check
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function checkCycle(current: string, path: string[]) {
    visited.add(current);
    recStack.add(current);
    path.push(current);

    const proj = projects.get(current);
    if (proj) {
      for (const dep of proj.dependencies) {
        if (!projects.has(dep)) continue;
        if (!visited.has(dep)) {
          checkCycle(dep, path);
        } else if (recStack.has(dep)) {
          errors.push(`[Circular Dependency] Cycle detected: ${[...path, dep].join(" -> ")}`);
        }
      }
    }

    path.pop();
    recStack.delete(current);
  }

  for (const name of projects.keys()) {
    if (!visited.has(name)) {
      checkCycle(name, []);
    }
  }

  return { errors, warnings };
}

async function main() {
  const packagesDir = join(import.meta.dir, "..", "packages");
  const projects = await loadProjects(packagesDir);
  console.log(`Loaded ${projects.size} packages in workspace.`);

  const { errors, warnings } = checkBoundaries(projects);

  for (const warn of warnings) {
    console.warn(`\x1b[33mWARN\x1b[0m ${warn}`);
  }

  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`\x1b[31mERROR\x1b[0m ${err}`);
    }
    console.error(`\nFound ${errors.length} boundary violation(s).`);
    process.exit(1);
  }

  console.log("\x1b[32m✔\x1b[0m All workspace architectural boundaries and module tags are respected!");
}

main().catch((err) => {
  console.error("Failed to check workspace boundaries:", err);
  process.exit(1);
});
