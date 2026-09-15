import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectConfig {
  name: string;
  tags: string[];
  path: string;
  dependencies: string[];
}

export interface BoundaryRule {
  sourceTag: string;
  bannedDependenciesWithTags?: string[];
  onlyDependOnLibsWithTags?: string[];
  description?: string;
}

export interface WorkspaceInventory {
  projects: Map<string, ProjectConfig>;
  errors: string[];
}

export const WORKSPACE_BOUNDARY_RULES: BoundaryRule[] = [
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
    bannedDependenciesWithTags: ["type:cli", "type:app", "type:admin", "type:api", "type:compiler"],
    description: "Runtimes must not depend on UI, control-plane API, CLI, admin operations, or the compiler.",
  },
  {
    sourceTag: "type:api",
    bannedDependenciesWithTags: ["type:app", "type:cli", "type:admin", "type:distribution", "type:compiler"],
    description: "Control-plane APIs may depend on platform libraries, but not UI, packaging, CLI, or compiler surfaces.",
  },
  {
    sourceTag: "type:app",
    bannedDependenciesWithTags: ["type:api", "type:runtime", "type:database", "type:admin", "type:cli", "type:distribution", "type:compiler"],
    description: "Web applications consume client contracts and must not import server, database, packaging, or compiler surfaces.",
  },
  {
    sourceTag: "type:distribution",
    onlyDependOnLibsWithTags: ["type:admin", "type:cli"],
    description: "The distribution package is a thin packaging facade over the supported admin and project CLI entrypoints.",
  },
];

const REQUIRED_PACKAGE_TAGS: Record<string, string[]> = {
  "@supacloud/management-api": ["scope:cloud", "type:api"],
  "@supacloud/edge-runtime": ["scope:runtime", "type:runtime"],
  "web-console": ["scope:cloud", "type:app"],
  "@supacloud/db": ["scope:core", "type:database"],
};

export async function loadProjects(packagesDir: string): Promise<WorkspaceInventory> {
  const projects = new Map<string, ProjectConfig>();
  const errors: string[] = [];
  const entries = await readdir(packagesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgDirPath = join(packagesDir, entry.name);
    const pkgJsonPath = join(pkgDirPath, "package.json");
    const projectJsonPath = join(pkgDirPath, "project.json");

    let pkgJson: {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    } = {};
    try {
      pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8"));
    } catch {
      continue;
    }

    let tags: string[] = [];
    let projectJson: { name?: unknown; tags?: unknown } | undefined;
    try {
      projectJson = JSON.parse(await readFile(projectJsonPath, "utf8")) as { name?: unknown; tags?: unknown };
    } catch {
      errors.push(`Package "${pkgJson.name ?? entry.name}" is missing a valid project.json; every workspace package must declare scope and type tags.`);
    }
    if (projectJson) {
      const name = pkgJson.name ?? entry.name;
      const acceptedProjectNames = new Set([name, `@supacloud/${entry.name}`]);
      if (typeof projectJson.name !== "string" || !acceptedProjectNames.has(projectJson.name)) {
        errors.push(`Package "${name}" project.json name must be "${name}".`);
      }
      if (!Array.isArray(projectJson.tags) || !projectJson.tags.every((tag): tag is string => typeof tag === "string")) {
        errors.push(`Package "${name}" project.json tags must be a string array.`);
      } else {
        tags = projectJson.tags;
        const duplicateTags = tags.filter((tag, index) => tags.indexOf(tag) !== index);
        if (duplicateTags.length > 0) {
          errors.push(`Package "${name}" has duplicate tags: ${[...new Set(duplicateTags)].join(", ")}.`);
        }
        if (tags.filter((tag) => tag.startsWith("scope:")).length !== 1) {
          errors.push(`Package "${name}" must declare exactly one scope:* tag.`);
        }
        if (tags.filter((tag) => tag.startsWith("type:")).length !== 1) {
          errors.push(`Package "${name}" must declare exactly one type:* tag.`);
        }
      }
    }

    const name = pkgJson.name ?? entry.name;
    const dependencies = Object.keys({
      ...(pkgJson.dependencies ?? {}),
      ...(pkgJson.devDependencies ?? {}),
      ...(pkgJson.peerDependencies ?? {}),
      ...(pkgJson.optionalDependencies ?? {}),
    });
    projects.set(name, {
      name,
      tags,
      path: pkgDirPath,
      dependencies,
    });
  }

  return { projects, errors };
}

export function checkBoundaries(projects: Map<string, ProjectConfig>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [packageName, requiredTags] of Object.entries(REQUIRED_PACKAGE_TAGS)) {
    const project = projects.get(packageName);
    if (!project) {
      errors.push(`[Boundary Metadata] Required workspace package "${packageName}" is not present.`);
      continue;
    }
    for (const tag of requiredTags) {
      if (!project.tags.includes(tag)) {
        errors.push(`[Boundary Metadata] Package "${packageName}" must declare tag "${tag}".`);
      }
    }
  }

  for (const [name, project] of projects) {
    const sourceTags = project.tags;
    const allDeps = [...project.dependencies];

    for (const depName of allDeps) {
      const targetProject = projects.get(depName);
      if (!targetProject) continue; // External npm package

      const targetTags = targetProject.tags;

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

async function main(): Promise<void> {
  const packagesDir = join(import.meta.dir, "..", "packages");
  const inventory = await loadProjects(packagesDir);
  console.log(`Loaded ${inventory.projects.size} packages in workspace.`);

  const { errors, warnings } = checkBoundaries(inventory.projects);
  errors.push(...inventory.errors);

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

if (import.meta.main) {
  main().catch((err) => {
    console.error("Failed to check workspace boundaries:", err);
    process.exit(1);
  });
}
