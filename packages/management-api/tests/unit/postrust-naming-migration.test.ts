import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratePostrustTenantConfig, parseLegacyServiceList } from "../../src/services/postrust-naming-migration";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Postrust runtime naming migration", () => {
  test("parses the systemctl ACTIVE column instead of the sub-state", () => {
    expect(parseLegacyServiceList([
      "supacloud-pgrst@running.service loaded active running SupaCloud PostgREST for tenant running",
      "supacloud-pgrst@stopped.service loaded inactive dead SupaCloud PostgREST for tenant stopped",
      "supacloud-pgrst@starting.service loaded activating start SupaCloud PostgREST for tenant starting",
      "supacloud-pgrst@removed.service not-found failed failed SupaCloud PostgREST for tenant removed",
    ].join("\n"))).toEqual([
      { ref: "running", active: true },
      { ref: "stopped", active: false },
      { ref: "starting", active: true },
    ]);
  });

  test("moves the legacy generation directory and rewrites the pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "postrust-naming-"));
    directories.push(root);
    const ref = "tenantref";
    const digest = "a".repeat(64);
    const legacyDirectory = join(root, `${ref}_postgrest.d`);
    await mkdir(legacyDirectory, { mode: 0o750 });
    await writeFile(join(legacyDirectory, `${digest}.conf`), "db-uri = \"postgres://localhost/db\"\n", { mode: 0o440 });
    const legacyPointer = join(root, `${ref}_postgrest.current`);
    await writeFile(legacyPointer, `${ref}_postgrest.d/${digest}.conf`, { mode: 0o440 });

    expect(await migratePostrustTenantConfig(root)).toBe(2);

    const pointer = join(root, `${ref}_postrust.current`);
    expect(await readFile(pointer, "utf8")).toBe(`${ref}_postrust.d/${digest}.conf\n`);
    expect((await stat(join(root, `${ref}_postrust.d`, `${digest}.conf`))).isFile()).toBe(true);
    await expect(stat(legacyDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(legacyPointer)).rejects.toMatchObject({ code: "ENOENT" });

    expect(await migratePostrustTenantConfig(root)).toBe(0);
  });

  test("removes a stale legacy pointer when the canonical pointer already exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "postrust-naming-stale-"));
    directories.push(root);
    const ref = "tenantref3";
    const digest = "c".repeat(64);
    await mkdir(join(root, `${ref}_postrust.d`), { mode: 0o750 });
    await writeFile(join(root, `${ref}_postrust.d`, `${digest}.conf`), "x = \"y\"\n", { mode: 0o440 });
    await writeFile(join(root, `${ref}_postrust.current`), `${ref}_postrust.d/${digest}.conf\n`, { mode: 0o440 });
    await writeFile(join(root, `${ref}_postgrest.current`), `${ref}_postgrest.d/${digest}.conf\n`, { mode: 0o440 });

    expect(await migratePostrustTenantConfig(root)).toBe(1);
    await expect(stat(join(root, `${ref}_postgrest.current`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, `${ref}_postrust.current`), "utf8"))
      .toBe(`${ref}_postrust.d/${digest}.conf\n`);
  });

  test("moves a legacy pointer even when the directory was already migrated", async () => {
    const root = await mkdtemp(join(tmpdir(), "postrust-naming-pointer-"));
    directories.push(root);
    const ref = "tenantref2";
    const digest = "b".repeat(64);
    await mkdir(join(root, `${ref}_postrust.d`), { mode: 0o750 });
    await writeFile(join(root, `${ref}_postrust.d`, `${digest}.conf`), "x = \"y\"\n", { mode: 0o440 });
    await writeFile(join(root, `${ref}_postgrest.current`), `${ref}_postgrest.d/${digest}.conf`, { mode: 0o440 });

    expect(await migratePostrustTenantConfig(root)).toBe(1);
    expect(await readFile(join(root, `${ref}_postrust.current`), "utf8"))
      .toBe(`${ref}_postrust.d/${digest}.conf\n`);
  });
});
