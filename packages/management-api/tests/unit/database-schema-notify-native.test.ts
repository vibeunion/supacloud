// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { notifyPostgrestSchemaReload, tryNotifyPostgrestSchemaReload } from "../../src/services/database-schema-notify";
import { ensureTasksRealtimePublication } from "../../src/routes/database";
import { withNativePostgres } from "../helpers/native-postgres";
import { observeNativeNotifications } from "../helpers/native-pg-notifications";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native schema notifications are commit-bound and rollback-safe",
  async () => withNativePostgres(async (database, url) => {
    const observer = await observeNativeNotifications(database, url, ["pgrst_parent", "pgrst"]);
    try {
      await database.begin(async transaction => {
        await notifyPostgrestSchemaReload(transaction, "parent");
        expect(await observer.drain()).toEqual([]);
      });
      const committed = [
        { channel: "pgrst_parent", payload: "reload schema" },
        { channel: "pgrst", payload: "reload schema" },
      ];
      expect(await observer.drain()).toEqual(committed);
      await expect(database.begin(async transaction => {
        await notifyPostgrestSchemaReload(transaction, "parent");
        throw new Error("abort notification");
      })).rejects.toThrow("abort notification");
      expect(await observer.drain()).toEqual(committed);
      expect(await tryNotifyPostgrestSchemaReload(database, "parent")).toBe(true);
      expect(await observer.drain()).toEqual([...committed, ...committed]);

      await ensureTasksRealtimePublication(database);
      await database.unsafe(`
        CREATE SCHEMA realtime;
        CREATE TABLE realtime.publication_calls (invoked boolean NOT NULL);
        CREATE FUNCTION realtime.ensure_tasks_publication() RETURNS void LANGUAGE SQL AS $$
          INSERT INTO realtime.publication_calls VALUES (true)
        $$;
      `);
      await ensureTasksRealtimePublication(database);
      const rows: unknown = await database`SELECT invoked FROM realtime.publication_calls`;
      expect(rows).toEqual([{ invoked: true }]);

      const closed = new SQL(url, { max: 1 });
      await closed.close();
      await expect(notifyPostgrestSchemaReload(closed, "parent")).rejects.toThrow();
      expect(await tryNotifyPostgrestSchemaReload(closed, "parent")).toBe(false);
      expect(await observer.drain()).toEqual([...committed, ...committed]);
    } finally {
      await observer.close();
    }
  }),
  40_000,
);
