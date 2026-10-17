import { readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ApplicationGraph } from "@supacloud/compiler";

function inside(root: string, file: string): boolean {
  const path = relative(root, file).replaceAll("\\", "/");
  return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

/** Read only the selected owner's immediate source directories, never the whole repository. */
export async function createVerificationPlan(root: string, graph: ApplicationGraph, target: string, sourceRoot = root) {
  const exact = graph.modules.filter(module => module.name === target);
  const owners = exact.length > 0 ? exact : graph.modules.filter(module => module.className === target
    || [...module.providers, ...module.controllers, ...module.commands, ...(module.jobs ?? []), ...(module.queries ?? [])]
      .some(item => ("className" in item && item.className === target)
        || ("name" in item && item.name === target)
        || ("token" in item && item.token === target)
        || ("useClass" in item && item.useClass === target)
        || ("serviceKey" in item && item.serviceKey === target)));
  if (owners.length !== 1) throw new Error("Select one unambiguous module or owned symbol for verification");
  const owner = owners[0]!;
  const project = await realpath(root);
  const requestedRoot = resolve(root);
  const sources = [
    owner.file, owner.featureSpec?.file, ...owner.providers.map(item => item.file), ...owner.controllers.map(item => item.file),
    ...(graph.moduleHandlerFiles?.[owner.name] ?? []),
    ...(owner.aspects ?? []).flatMap(item => item.file ? [item.file] : []),
    ...owner.commands.flatMap(item => (item.aspects ?? []).flatMap(aspect => aspect.file ? [aspect.file] : [])),
    ...(owner.jobs ?? []).flatMap(item => (item.aspects ?? []).flatMap(aspect => aspect.file ? [aspect.file] : [])),
    ...owner.controllers.flatMap(item => item.routes.flatMap(route =>
      (route.aspects ?? []).flatMap(aspect => aspect.file ? [aspect.file] : []))),
  ].filter((file): file is string => typeof file === "string");
  const directories = [...new Set(sources.map(file => dirname(resolve(sourceRoot, file))))].sort();
  const tests = new Set<string>();
  const manual: string[] = [];
  const coverage: Array<{ directory: string; tests: string[]; basis: "colocated-not-proven" }> = [];
  for (const directory of directories) {
    if (!inside(requestedRoot, directory)) {
      manual.push("A source directory is outside the project; select its owning project explicitly");
      continue;
    }
    const actual = await realpath(directory).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (actual === null) {
      manual.push(`Source directory is missing: ${relative(requestedRoot, directory).replaceAll("\\", "/")}`);
      continue;
    }
    if (!inside(project, actual)) {
      manual.push("A source directory is outside the project; select its owning project explicitly");
      continue;
    }
    const local: string[] = [];
    for (const entry of await readdir(actual, { withFileTypes: true })) {
      if (entry.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
        const file = relative(project, resolve(actual, entry.name)).replaceAll("\\", "/");
        tests.add(file);
        local.push(file);
      }
    }
    const path = relative(project, actual).replaceAll("\\", "/") || ".";
    coverage.push({ directory: path, tests: local.sort(), basis: "colocated-not-proven" });
    if (!local.length) manual.push(`No colocated tests for source directory: ${path}`);
  }
  const selected = [...tests].sort();
  if (!selected.length) manual.push("No colocated tests found; declare a focused test before changing this module");
  if (selected.length > 32) manual.push("More than 32 local tests; narrow module ownership before execution");
  return {
    version: 1,
    source: "declaration",
    target: owner.name,
    ready: manual.length === 0,
    files: [...new Set(sources.map(file => relative(requestedRoot, resolve(sourceRoot, file)).replaceAll("\\", "/")))].sort(),
    tests: selected.slice(0, 32),
    commands: selected.length <= 32 ? [
      ...selected.map(file => ["bun", "test", `./${file}`]),
      ["git", "diff", "--check"],
    ] : [],
    manual,
    coverage,
    limitations: [
      "Colocation selects candidates; it does not prove behavioral coverage",
      "Dependent modules and database behavior require explicit integration acceptance",
      "No recursive scan, test execution or generated-file repair is performed",
    ],
    releaseOnly: ["generated artifact drift", "consumer types", "database/RLS and authenticated integration", "delivery read-back"],
    executed: false,
  };
}
