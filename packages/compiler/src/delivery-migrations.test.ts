import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeliveryProject } from "./delivery-build";
import { artifactInventory, digest } from "./delivery-files";
import { deliveryObjectDigest } from "./delivery-build-schema";
import { readDeliveryMigrationArchive } from "./delivery-migration-archive";
import { parseDeliveryOptions } from "./delivery-schema";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";

const declarations = [
  { source: "migrations/002-roles.sql", version: "2", name: "runtime_roles", executor: "operator-provisioning" },
  { source: "migrations/001-schema.sql", version: "1", name: "review_schema", executor: "project-migration" },
];

test("migration declarations reject ambiguous versions, sources and executor authority", () => {
  for (const migrations of [
    [{ ...declarations[0], version: "02" }],
    [{ ...declarations[0], version: "9223372036854775808" }],
    [{ ...declarations[0], source: "../outside.sql" }],
    [{ ...declarations[0], source: "node_modules/vendor/schema.sql" }],
    [{ ...declarations[0], source: "migrations/credentials.json" }],
    [{ ...declarations[0], executor: "service_role" }],
    [{ ...declarations[0], compatibility: "proven" }],
    [declarations[0], { ...declarations[1], version: "2" }],
    [declarations[0], { ...declarations[1], source: declarations[0]!.source }],
  ]) {
    expect(() => parseDeliveryOptions({ version: 1, build: { migrations } })).toThrow("Invalid delivery configuration");
  }
  expect(parseDeliveryOptions({ version: 1, build: { migrations: declarations } }).build?.migrations).toHaveLength(2);
});

test("immutable targets carry exact declared SQL and reject unsafe changes without switching the pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-migrations-"));
  const sql = "CREATE TABLE public.review_schema(id integer PRIMARY KEY);\n";
  const roles = "CREATE ROLE reference_runtime NOLOGIN;\r\n";
  try {
    await writeFixtureProject(root, {
      ...GOOD_PROJECT_FILES,
      "src/runtime.ts": GOOD_PROJECT_FILES["src/runtime.ts"].replaceAll("() => {}", "(..._args: unknown[]) => {}"),
      "src/features/health/health.module.ts": `import { Module, Controller, Get } from "../../runtime";
        @Controller("/health") export class HealthController {
          @Get("/", {response: {type: "string"}}) status(): string {return "ready";}
        }
        @Module({name: "health", controllers: [HealthController]}) export class HealthModule {}`,
      "migrations/001-schema.sql": sql,
      "migrations/002-roles.sql": roles,
      "migrations/unlisted.sql": "SELECT 'unlisted-private-value';",
    });
    const options = { rootDir: join(root, "src"), outDir: join(root, "generated"), strict: false,
      generateClient: false, generatePermissions: false };
    const settings = { version: 1, targets: [{ name: "cases", kind: "api", modules: ["case"] }],
      build: { migrations: declarations } };
    const first = await buildDeliveryProject(options, settings);
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
    expect(first.manifest.objects).toHaveLength(2);
    const objects = join(root, "generated/delivery/objects");
    const manifestPath = join(root, "generated/delivery/delivery.manifest.json");
    for (const object of first.manifest.objects) {
      const bundle = join(objects, object.objectId, "bundle");
      expect(await readFile(join(bundle, "migrations/project-migration/1_review_schema.sql"), "utf8")).toBe(sql);
      expect(await readFile(join(bundle, "migrations/operator-provisioning/2_runtime_roles.sql"), "utf8")).toBe(roles);
      const inventory = JSON.parse(await readFile(join(bundle, "migrations.json"), "utf8"));
      expect(inventory).toEqual({
        version: 1, digestScope: "raw-sql-bytes", compatibility: "not-proven", executionPerformed: false,
        dataRecovery: "separate-required",
        migrations: [
          { version: "1", name: "review_schema", executor: "project-migration",
            path: "migrations/project-migration/1_review_schema.sql", sha256: digest(sql), bytes: Buffer.byteLength(sql) },
          { version: "2", name: "runtime_roles", executor: "operator-provisioning",
            path: "migrations/operator-provisioning/2_runtime_roles.sql", sha256: digest(roles), bytes: Buffer.byteLength(roles) },
        ],
      });
      expect(object.files.filter(file => file.path.startsWith("bundle/migrations/"))).toHaveLength(2);
      const archive = await readDeliveryMigrationArchive(manifestPath, object.name);
      expect(archive.objectId).toBe(object.objectId);
      expect(archive.artifactVerified).toBe(true);
      expect(archive.migrations.map(entry => entry.sql)).toEqual([sql, roles]);
      const sqlPath = join(bundle, "migrations/project-migration/1_review_schema.sql");
      await writeFile(sqlPath, "SELECT 'must-not-leak';");
      await expect(readDeliveryMigrationArchive(manifestPath, object.name)).rejects.toThrow("Invalid delivery migration archive.");
      await writeFile(sqlPath, sql);
      const executablePath = join(bundle, "index.js");
      const executable = await readFile(executablePath);
      await writeFile(executablePath, "throw new Error('must-not-leak');");
      await expect(readDeliveryMigrationArchive(manifestPath, object.name)).rejects.toThrow("Invalid delivery migration archive.");
      await writeFile(executablePath, executable);
      await writeFile(join(bundle, "extra.sql"), "SELECT 1;");
      await expect(readDeliveryMigrationArchive(manifestPath, object.name)).rejects.toThrow("Invalid delivery migration archive.");
      await rm(join(bundle, "extra.sql"));
      await rm(sqlPath);
      await symlink(join(root, declarations[1]!.source), sqlPath);
      await expect(readDeliveryMigrationArchive(manifestPath, object.name)).rejects.toThrow("Invalid delivery migration archive.");
      await rm(sqlPath);
      await writeFile(sqlPath, sql);
    }
    await expect(readDeliveryMigrationArchive(manifestPath, "missing")).rejects.toThrow("Invalid delivery migration archive.");
    const same = await buildDeliveryProject(options, settings);
    if (!same.ok) throw new Error(JSON.stringify(same.diagnostics));
    expect(same.written).toEqual([]);
    expect(same.unchangedTargets).toEqual(["api", "cases"]);

    await writeFile(join(root, declarations[1]!.source), sql + "-- changed migration bytes\n");
    const changed = await buildDeliveryProject(options, settings);
    if (!changed.ok) throw new Error(JSON.stringify(changed.diagnostics));
    expect(changed.changedTargets).toEqual(["api", "cases"]);
    for (const object of changed.manifest.objects) {
      const previous = first.manifest.objects.find(item => item.name === object.name)!;
      expect(object.inputDigest).not.toBe(previous.inputDigest);
      expect(object.objectId).not.toBe(previous.objectId);
      expect(await readFile(join(objects, object.objectId, "bundle/index.js")))
        .toEqual(await readFile(join(objects, previous.objectId, "bundle/index.js")));
    }

    const pointer = join(root, "generated/delivery/delivery.manifest.json");
    const selected = await readFile(pointer, "utf8");
    for (const content of [new Uint8Array([0xff]), new Uint8Array(1_048_577), new TextEncoder().encode(" \n")]) {
      await writeFile(join(root, declarations[1]!.source), content);
      const failed = await buildDeliveryProject(options, settings);
      expect(failed.ok).toBe(false);
      expect(failed.written).toEqual([]);
      expect(await readFile(pointer, "utf8")).toBe(selected);
    }
    await rm(join(root, declarations[1]!.source));
    await symlink(join(root, "migrations/unlisted.sql"), join(root, declarations[1]!.source));
    expect((await buildDeliveryProject(options, settings)).ok).toBe(false);
    expect(await readFile(pointer, "utf8")).toBe(selected);
    const generatedInput = { ...settings, build: { migrations: [{
      ...declarations[1], source: "generated/migration.sql",
    }] } };
    await writeFile(join(root, "generated/migration.sql"), sql);
    expect((await buildDeliveryProject(options, generatedInput)).ok).toBe(false);
    expect(await readFile(pointer, "utf8")).toBe(selected);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);

test("self-consistent artifact hashes do not bypass migration metadata validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "migration-archive-schema-"));
  try {
    await writeFixtureProject(root, {
      ...GOOD_PROJECT_FILES,
      "src/runtime.ts": GOOD_PROJECT_FILES["src/runtime.ts"].replaceAll("() => {}", "(..._args: unknown[]) => {}"),
      "migrations/001-schema.sql": "SELECT 1;",
      "migrations/002-roles.sql": "SELECT 2;",
    });
    const options = { rootDir: join(root, "src"), outDir: join(root, "generated"), strict: false,
      generateClient: false, generatePermissions: false };
    const built = await buildDeliveryProject(options, { version: 1, build: { migrations: declarations } });
    if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
    const delivery = join(root, "generated/delivery");
    const object = built.manifest.objects.find(item => item.name === "api")!;
    const originalRoot = join(delivery, "objects", object.objectId);
    const metadata = JSON.parse(await readFile(join(originalRoot, "bundle/migrations.json"), "utf8"));
    const mutations = [
      (value: typeof metadata) => { value.executionPerformed = true; },
      (value: typeof metadata) => { value.migrations[0].path = "../../outside.sql"; },
      (value: typeof metadata) => { value.migrations[0].executor = "admin"; },
      (value: typeof metadata) => { value.migrations[0].sha256 = "0".repeat(64); },
      (value: typeof metadata) => { value.migrations[0].bytes++; },
      (value: typeof metadata) => { value.migrations[0].version = "9223372036854775808"; },
      (value: typeof metadata) => { value.migrations[1].version = value.migrations[0].version; },
      (value: typeof metadata) => { value.migrations.reverse(); },
      (value: typeof metadata) => { value.migrations.pop(); },
    ];
    for (const mutate of mutations) {
      const candidate = join(delivery, "candidate");
      await cp(originalRoot, candidate, { recursive: true });
      const invalid = structuredClone(metadata);
      mutate(invalid);
      await writeFile(join(candidate, "bundle/migrations.json"), JSON.stringify(invalid));
      const modified = { ...object, files: await artifactInventory(candidate) };
      modified.objectId = deliveryObjectDigest(modified);
      await rename(candidate, join(delivery, "objects", modified.objectId));
      await writeFile(join(delivery, "candidate.manifest.json"), JSON.stringify({
        ...built.manifest,
        objects: built.manifest.objects.map(item => item.name === "api" ? modified : item),
      }));
      await expect(readDeliveryMigrationArchive(join(delivery, "candidate.manifest.json"), "api"))
        .rejects.toThrow("Invalid delivery migration archive.");
    }
    const empty = await buildDeliveryProject(options, { version: 1 });
    if (!empty.ok) throw new Error(JSON.stringify(empty.diagnostics));
    expect((await readDeliveryMigrationArchive(join(delivery, "delivery.manifest.json"), "api")).migrations).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
