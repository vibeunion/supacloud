import type { SQL } from "bun";
import { Type } from "@sinclair/typebox";
import { createPgListener } from "../../src/lib/pg-listen";
import { fixtureRows } from "./fixture-rows";
import { waitForPostgresFixture } from "./native-postgres";

export async function observeNativeNotifications(database: SQL, url: string, channels: string[]) {
  const application = `notification-fixture-${crypto.randomUUID()}`;
  const barrier = `barrier_${crypto.randomUUID().replaceAll("-", "")}`;
  const received: Array<{ channel: string; payload: string }> = [];
  const listener = createPgListener({
    url, channels: [...channels, barrier], applicationName: application, keepaliveIntervalMs: 0,
    onNotification(channel, payload) { received.push({ channel, payload }); },
  });
  try {
    await waitForPostgresFixture(async () => fixtureRows(Type.Object({ ready: Type.Literal(1) }), await database`
      SELECT 1 AS ready FROM pg_stat_activity
      WHERE application_name = ${application} AND state = 'idle' AND query LIKE 'LISTEN%'
    `).length === 1);
  } catch (error) {
    listener.close();
    throw error;
  }
  return {
    async drain() {
      const token = crypto.randomUUID();
      await database`SELECT pg_notify(${barrier}, ${token})`;
      await waitForPostgresFixture(async () =>
        received.some(event => event.channel === barrier && event.payload === token));
      return received.filter(event => event.channel !== barrier);
    },
    async close() {
      listener.close();
      await waitForPostgresFixture(async () => fixtureRows(Type.Object({ ready: Type.Literal(1) }), await database`
        SELECT 1 AS ready FROM pg_stat_activity WHERE application_name = ${application}
      `).length === 0);
    },
  };
}
