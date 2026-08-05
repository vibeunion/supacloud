import { afterAll, describe, expect, test } from "bun:test";
import { SQL, type ReservedSQL } from "bun";

interface WebhookEventsRow {
  events: string[];
}

const database = new SQL({
  url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres",
  max: 1,
});

async function withRollback(operation: (transaction: ReservedSQL) => Promise<void>): Promise<void> {
  const connection = await database.reserve();
  await connection.unsafe("BEGIN");
  try {
    await operation(connection);
  } finally {
    await connection.unsafe("ROLLBACK");
    connection.release();
  }
}

async function insertEvents(transaction: ReservedSQL, fixtureId: string, events: string[]): Promise<string[]> {
  const eventArray = transaction.array(events, "TEXT");
  const [webhook] = await transaction<WebhookEventsRow[]>`
    INSERT INTO project_webhook_array_binding (fixture_id, events)
    VALUES (${fixtureId}, ${eventArray})
    RETURNING events
  `;
  return webhook.events;
}

async function updateEvents(transaction: ReservedSQL, fixtureId: string, events: string[]): Promise<string[]> {
  const eventArray = transaction.array(events, "TEXT");
  const [webhook] = await transaction<WebhookEventsRow[]>`
    UPDATE project_webhook_array_binding
    SET events = ${eventArray}
    WHERE fixture_id = ${fixtureId}
    RETURNING events
  `;
  return webhook.events;
}

afterAll(async () => {
  await database.close();
}, 30_000);

describe("project webhook TEXT[] binding", () => {
  test("round trips single, multiple, wildcard, and escaped event arrays", async () => {
    await withRollback(async (transaction) => {
      await transaction`
        CREATE TEMPORARY TABLE project_webhook_array_binding (
          fixture_id TEXT PRIMARY KEY,
          events TEXT[] NOT NULL
        ) ON COMMIT DROP
      `;

      expect(await insertEvents(transaction, "single", ["user.created"]))
        .toEqual(["user.created"]);
      expect(await insertEvents(transaction, "multiple", ["user.created", "organization.updated"]))
        .toEqual(["user.created", "organization.updated"]);
      expect(await insertEvents(transaction, "wildcard", ["*"])).toEqual(["*"]);
      expect(await insertEvents(transaction, "escaped", ["comma,event", "back\\slash.event"]))
        .toEqual(["comma,event", "back\\slash.event"]);
      expect(await updateEvents(transaction, "single", ["organization.created", "organization.deleted"]))
        .toEqual(["organization.created", "organization.deleted"]);
    });
  }, 30_000);
});
