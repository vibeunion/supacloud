// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { withNativePostgres } from "../helpers/native-postgres";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native initialization uses decoded credentials and the configured database on repeated runs",
  async () => withNativePostgres(async (database, url) => {
    await database.unsafe(`CREATE ROLE "init-user" LOGIN SUPERUSER PASSWORD 'pass%@:'`);
    await database.unsafe(`CREATE DATABASE "init db%20" OWNER "init-user"`);
    const targetUrl = new URL(url);
    targetUrl.username = "init-user";
    targetUrl.password = encodeURIComponent("pass%@:");
    targetUrl.pathname = `/${encodeURIComponent("init db%20")}`;
    targetUrl.search = "?sslmode=disable&application_name=init-boundary";
    const keys = ["DATABASE_URL", "SECRETS_ENCRYPTION_KEY", "CI", "GITHUB_ACTIONS", "TEST_FIXED_JWT_SECRET"] as const;
    const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.DATABASE_URL = targetUrl.href;
    process.env.SECRETS_ENCRYPTION_KEY = "native-init-encryption-key-0123456789abcdef";
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.TEST_FIXED_JWT_SECRET;
    try {
      const { initDatabase } = await import("../../src/db/init");
      await initDatabase();
      await initDatabase();
      const initialized = new SQL(targetUrl.href, { max: 1, connectionTimeout: 3 });
      try {
        const identity: unknown = await initialized`
          SELECT current_database() AS database, current_user AS username
        `;
        expect(identity).toEqual([{ database: "init db%20", username: "init-user" }]);
        const tables: unknown = await initialized`
          SELECT COUNT(*)::int AS count FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name IN ('projects', 'project_tasks', 'project_mutations', 'project_webhooks')
        `;
        expect(tables).toEqual([{ count: 4 }]);
        const untouched: unknown = await database`
          SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'projects'
        `;
        expect(untouched).toEqual([{ count: 0 }]);
      } finally { await initialized.close(); }
      targetUrl.username = "supabase_realtime_admin";
      const realtime = new SQL(targetUrl.href, { max: 1, connectionTimeout: 3 });
      try {
        const identity: unknown = await realtime`SELECT current_user AS username`;
        expect(identity).toEqual([{ username: "supabase_realtime_admin" }]);
      } finally { await realtime.close(); }
    } finally {
      for (const key of keys) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }),
  40_000,
);
