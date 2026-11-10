import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
};

const adapterPackages = [
  "@zenstackhq/orm",
  "@zenstackhq/schema",
  "@zenstackhq/plugin-policy",
  "@zenstackhq/language",
  "@zenstackhq/sdk",
  "kysely",
  "@supacloud/db-zenstack",
];

function localImports(source: string): string[] {
  return [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((match) => {
    const specifier = match[1]!;
    return specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.ts` : specifier.endsWith(".ts") ? specifier : `${specifier}.ts`;
  });
}

test("the control-plane entry does not require ZenStack, Kysely, or the adapter package", () => {
  for (const name of adapterPackages) {
    expect(manifest.dependencies?.[name]).toBeUndefined();
    expect(manifest.devDependencies?.[name]).toBeUndefined();
    if (name === "@supacloud/db-zenstack") {
      // Compatibility entry points may declare the adapter only as an optional peer.
      expect(manifest.peerDependencies?.[name]).toBeDefined();
      expect(manifest.peerDependenciesMeta?.[name]?.optional).toBe(true);
    } else {
      expect(manifest.peerDependencies?.[name]).toBeUndefined();
    }
  }
});

test("the main export graph does not import the ZenStack adapter", () => {
  const seen = new Set<string>();
  const pending = [join(root, "src/index.ts")];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    expect(source).not.toContain("@zenstackhq/");
    expect(source).not.toContain("kysely");
    expect(source).not.toContain("@supacloud/db-zenstack");
    for (const specifier of localImports(source)) pending.push(resolve(file, "..", specifier));
  }
  expect(seen.size).toBeGreaterThan(3);
});
