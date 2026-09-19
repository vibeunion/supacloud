import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMigrationDependencies, migrationDependencies } from "./migration-policy";

// A fake installation built from migrationDependencies alone cannot detect a
// stale tuple after release version bumps. Compare independent workspace files.
// The real upgrade/HTTP/type acceptance test must still pass for this tuple.
test("the migration tuple matches the app, compiler and Elysia release manifests", async () => {
  const dependencies = migrationDependencies();
  for (const packageName of ["app", "compiler", "elysia"]) {
    const manifest: unknown = JSON.parse(await readFile(
      new URL(`../../${packageName}/package.json`, import.meta.url), "utf8",
    ));
    if (!manifest || typeof manifest !== "object" || !("name" in manifest)
      || typeof manifest.name !== "string" || !("version" in manifest)
      || typeof manifest.version !== "string") {
      throw new Error(`Invalid workspace manifest: ${packageName}`);
    }
    expect(manifest.name).toBe(`@supacloud/${packageName}`);
    expect(dependencies[manifest.name]).toBe(manifest.version);
  }
});

async function withInstalledTuple(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "supacloud-migration-tuple-"));
  try {
    for (const [name, version] of Object.entries(migrationDependencies())) {
      const directory = join(root, "node_modules", name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ name, version }));
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("accepts the exact release migration tuple", async () => {
  await withInstalledTuple(async (root) => {
    expect(await checkMigrationDependencies(root)).toEqual([]);
  });
});

for (const [name, staleVersion] of Object.entries({
  "@supacloud/app": "0.14.0",
  "@supacloud/elysia": "0.17.0",
})) {
  test(`rejects the previous ${name} version rather than widening compatibility`, async () => {
    await withInstalledTuple(async (root) => {
      await writeFile(join(root, "node_modules", name, "package.json"), JSON.stringify({ name, version: staleVersion }));
      expect(await checkMigrationDependencies(root)).toEqual([
        `${name}: requires tested installed version ${migrationDependencies()[name]}`,
      ]);
    });
  });
}

test("rejects unverified versions, version ranges, wrong names and malformed manifests", async () => {
  await withInstalledTuple(async (root) => {
    for (const [name, version] of Object.entries(migrationDependencies())) {
      const path = join(root, "node_modules", name, "package.json");
      for (const manifest of [
        { name, version: `${version}-unverified` },
        { name, version: `^${version}` },
        { name: "wrong-package", version },
        null,
      ]) {
        await writeFile(path, JSON.stringify(manifest));
        expect(await checkMigrationDependencies(root)).toEqual([
          `${name}: requires tested installed version ${version}`,
        ]);
      }
      await writeFile(path, JSON.stringify({ name, version }));
    }
  });
});

test("rejects every missing migration dependency", async () => {
  await withInstalledTuple(async (root) => {
    for (const [name, version] of Object.entries(migrationDependencies())) {
      const path = join(root, "node_modules", name, "package.json");
      await rm(path);
      expect(await checkMigrationDependencies(root)).toEqual([
        `${name}: install tested version ${version} in the project node_modules first`,
      ]);
      await writeFile(path, JSON.stringify({ name, version }));
    }
  });
});
