import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = join(import.meta.dir, "../..");

function productionDependencies(directory: string, seen = new Set<string>()): string[] {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const names: string[] = [];
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    names.push(name);
    if (typeof spec === "string" && spec.startsWith("file:") && !seen.has(name)) {
      seen.add(name);
      names.push(...productionDependencies(resolve(directory, spec.slice("file:".length)), seen));
    }
  }
  return names;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("Management API production dependencies exclude ZenStack, Effect, and the app framework", () => {
  const names = productionDependencies(root);
  for (const name of names) {
    expect(name.startsWith("@zenstackhq/")).toBe(false);
    expect(["kysely", "effect", "@supacloud/app", "@supacloud/compiler", "@supacloud/elysia", "@supacloud/db-zenstack"]).not.toContain(name);
  }
  expect(names).toContain("@supacloud/db");
});

test("Management API source does not import the optional app layer or Effect", () => {
  const offenders: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*["'](@supacloud\/app|@supacloud\/compiler|@supacloud\/db\/zenstack|@supacloud\/db\/model|effect)(?:\/|["'])/;
  for (const file of sourceFiles(join(root, "src"))) {
    const source = readFileSync(file, "utf8");
    if (pattern.test(source)) offenders.push(file.slice(root.length + 1));
  }
  expect(offenders).toEqual([]);
});
