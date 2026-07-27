import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTenantDatabaseConfig, TenantConfigError } from "./tenant-config";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "supacloud-pgredis-config-"));
  directories.push(directory);
  return directory;
}

describe("loadTenantDatabaseConfig", () => {
  test("loads only the project-scoped pgredis role", async () => {
    const directory = await tempDirectory();
    await Bun.write(
      join(directory, "tenant-a_pgredis.env"),
      'PGREDIS_DATABASE_URL="postgresql://role_tenant-a:secret@postgres:5432/custom-db"\n',
    );
    await chmod(join(directory, "tenant-a_pgredis.env"), 0o600);

    const config = await loadTenantDatabaseConfig(directory, "tenant-a");
    expect(config.databaseUrl).toContain("role_tenant-a");
    expect(config.fingerprint).toHaveLength(64);
  });

  test("rejects cross-tenant role substitution", async () => {
    const directory = await tempDirectory();
    await Bun.write(
      join(directory, "tenant-a_pgredis.env"),
      'PGREDIS_DATABASE_URL="postgresql://role_tenant-b:secret@postgres:5432/db"\n',
    );
    await expect(loadTenantDatabaseConfig(directory, "tenant-a"))
      .rejects.toThrow("does not match");
  });

  test("rejects symlinked tenant configuration", async () => {
    const directory = await tempDirectory();
    const target = join(directory, "target.env");
    await Bun.write(target, 'PGREDIS_DATABASE_URL="postgresql://role_tenant-a:secret@postgres:5432/db"\n');
    await symlink(target, join(directory, "tenant-a_pgredis.env"));
    await expect(loadTenantDatabaseConfig(directory, "tenant-a")).rejects.toBeInstanceOf(TenantConfigError);
  });
});
