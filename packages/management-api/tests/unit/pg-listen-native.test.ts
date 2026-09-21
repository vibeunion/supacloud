// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createPgListener, type PgListenerHandle } from "../../src/lib/pg-listen";
import { withPostgresDatabase } from "../../src/utils/postgres-url";
import { withNativePostgres, waitForPostgresFixture as until } from "../helpers/native-postgres";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "LISTEN/NOTIFY authenticates with PostgreSQL SCRAM, keeps alive and releases its session",
  async () => withNativePostgres(async (database, url, name) => {
    let listener: PgListenerHandle | undefined;
    try {
      await database.unsafe(`CREATE ROLE "user%@" LOGIN PASSWORD 'fixture%@:pw'`);
      const roleDatabase = new SQL(withPostgresDatabase(url, "fixture", "user%@", "fixture%@:pw"));
      try {
        const rows: unknown = await roleDatabase`SELECT current_user AS name`;
        expect(rows).toEqual([{ name: "user%@" }]);
      } finally {
        await roleDatabase.close();
      }
      const tlsDatabase = new SQL(`${url}?sslmode=require`, { max: 1, connectionTimeout: 2 });
      try {
        const query = async () => await tlsDatabase`SELECT 1`;
        await expect(query()).rejects.toThrow("Server does not support SSL");
      } finally {
        await tlsDatabase.close({ timeout: 0 });
      }
      const received: string[] = [];
      const channel = 'jobs"; SELECT 42; --';
      listener = createPgListener({
        url, channels: [channel], applicationName: name, keepaliveIntervalMs: 100,
        onNotification(actual, payload) { received.push(`${actual}:${payload}`); },
      });
      await until(async () => {
        const rows: unknown = await database`
          SELECT 1 FROM pg_stat_activity
          WHERE application_name = ${name} AND state = 'idle' AND query LIKE 'LISTEN%'
        `;
        return Array.isArray(rows) && rows.length === 1;
      });
      await database`SELECT pg_notify(${channel}, ${"native-scram"})`;
      await until(async () => received.length === 1);
      expect(received).toEqual([`${channel}:native-scram`]);
      await until(async () => {
        const rows: unknown = await database`
          SELECT 1 FROM pg_stat_activity
          WHERE application_name = ${name} AND state = 'idle' AND query = 'SELECT 1;'
        `;
        return Array.isArray(rows) && rows.length === 1;
      });
      listener.close();
      await until(async () => {
        const rows: unknown = await database`SELECT 1 FROM pg_stat_activity WHERE application_name = ${name}`;
        return Array.isArray(rows) && rows.length === 0;
      });
    } finally {
      listener?.close();
    }
  }),
  40_000,
);
