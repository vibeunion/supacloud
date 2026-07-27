import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createPgListener } from "@postgresx/bun-listen";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TenantCacheRegistry } from "./cache-registry";

const databaseUrl = process.env.PGREDIS_TEST_DATABASE_URL?.trim() || "";
const tenantRef = "pgitest";
const tenantRole = `role_${tenantRef}`;
const tenantPassword = "pgredis_test_password_123";
const channel = "supacloud_pgredis_invalidate";

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for PostgreSQL integration state");
}

function registry(tenantsDir: string): TenantCacheRegistry {
  return new TenantCacheRegistry({
    tenantsDir,
    maxTenants: 1,
    connectionsPerTenant: 2,
    tenantIdleMs: 60_000,
    l1MaxEntries: 100,
    l1TtlMs: 60_000,
  });
}

test.skipIf(!databaseUrl)("PostgreSQL commits notifications atomically and clears L1 after reconnect", async () => {
  const admin = new SQL({ url: databaseUrl, max: 2 });
  const roleUrl = new URL(databaseUrl);
  roleUrl.username = tenantRole;
  roleUrl.password = tenantPassword;
  const tenantsDir = await mkdtemp(path.join(tmpdir(), "pgredis-postgres-"));
  const firstRegistry = registry(tenantsDir);
  const secondRegistry = registry(tenantsDir);
  const notifications: Array<{ op: string; key: string }> = [];
  const observer = createPgListener(databaseUrl, [channel], (_channel, payload) => {
    const parsed = JSON.parse(payload) as { op?: string; key?: string };
    if (parsed.op && parsed.key) notifications.push({ op: parsed.op, key: parsed.key });
  }, { logger: false });
  let roleLoginDisabled = false;

  try {
    await admin.unsafe("DROP TABLE IF EXISTS public.supacloud_pgredis_kv");
    await admin.unsafe(`DROP OWNED BY ${tenantRole}`).catch(() => {});
    await admin.unsafe(`DROP ROLE IF EXISTS ${tenantRole}`);
    await admin.unsafe(`CREATE ROLE ${tenantRole} LOGIN PASSWORD '${tenantPassword}'`);
    await admin.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${tenantRole}`);
    await writeFile(
      path.join(tenantsDir, `${tenantRef}_pgredis.env`),
      `PGREDIS_DATABASE_URL=${roleUrl.toString()}\n`,
      { mode: 0o600 },
    );
    await waitFor(() => observer.getHealth().connected);

    const first = await firstRegistry.acquire(tenantRef);
    const second = await secondRegistry.acquire(tenantRef);
    try {
      await first.cache.set("atomic:set", { version: 1 });
      await first.cache.delete("atomic:set");
      expect(await first.cache.getset<{ version: number }>("atomic:swap", { version: 2 })).toBeNull();
      expect(await first.cache.getdel<{ version: number }>("atomic:swap")).toEqual({ version: 2 });
      await waitFor(() => notifications.filter(({ key }) => key.startsWith("atomic:")).length === 4);
      expect(notifications.filter(({ key }) => key.startsWith("atomic:"))).toEqual([
        { op: "set", key: "atomic:set" },
        { op: "delete", key: "atomic:set" },
        { op: "set", key: "atomic:swap" },
        { op: "delete", key: "atomic:swap" },
      ]);

      await expect(admin.begin(async (transaction) => {
        await transaction.unsafe("SELECT pg_notify($1, $2)", [
          channel,
          JSON.stringify({ namespace: "supacloud-edge-runtime", op: "set", key: "rolled-back" }),
        ]);
        throw new Error("force rollback");
      })).rejects.toThrow("force rollback");
      await Bun.sleep(200);
      expect(notifications.some(({ key }) => key === "rolled-back")).toBeFalse();

      await first.cache.set("reconnect", "v1");
      await waitFor(() => notifications.some(({ key }) => key === "reconnect"));
      await Bun.sleep(100);
      expect(await second.cache.get<string>("reconnect")).toBe("v1");
      await admin.unsafe(`ALTER ROLE ${tenantRole} NOLOGIN`);
      roleLoginDisabled = true;
      await waitFor(async () => {
        const listenerRows = await admin.unsafe(
          "SELECT pid FROM pg_stat_activity WHERE usename = $1 AND query ~ '^LISTEN'",
          [tenantRole],
        ) as unknown as Array<{ pid: number }>;
        for (const { pid } of listenerRows) {
          await admin.unsafe("SELECT pg_terminate_backend($1)", [pid]);
        }
        return listenerRows.length === 0;
      });
      await first.cache.set("reconnect", "v2");
      expect(await second.cache.get<string>("reconnect")).toBe("v2");
      await first.cache.set("reconnect", "v3");
      expect(await second.cache.get<string>("reconnect")).toBe("v2");

      await admin.unsafe(`ALTER ROLE ${tenantRole} LOGIN`);
      roleLoginDisabled = false;
      await waitFor(async () => await second.cache.get<string>("reconnect") === "v3");
      expect(await second.cache.get<string>("reconnect")).toBe("v3");
    } finally {
      first.release();
      second.release();
    }
  } finally {
    if (roleLoginDisabled) await admin.unsafe(`ALTER ROLE ${tenantRole} LOGIN`).catch(() => {});
    observer.close();
    await Promise.allSettled([firstRegistry.shutdown(), secondRegistry.shutdown()]);
    await admin.unsafe("DROP TABLE IF EXISTS public.supacloud_pgredis_kv").catch(() => {});
    await admin.unsafe(`DROP OWNED BY ${tenantRole}`).catch(() => {});
    await admin.unsafe(`DROP ROLE IF EXISTS ${tenantRole}`).catch(() => {});
    await admin.close({ timeout: 0 });
    await rm(tenantsDir, { recursive: true, force: true });
  }
}, 30_000);
