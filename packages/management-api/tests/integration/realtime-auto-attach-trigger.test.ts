import { expect, test } from "bun:test";
import { SQL, type ReservedSQL } from "bun";
import { randomUUID } from "node:crypto";
import { SQL_MODULES } from "../../src/db/sql-modules";

interface RealtimeFixtureNames {
  eventTrigger: string;
  ownerTable: string;
  targetTable: string;
  privateSchema: string;
  privateTable: string;
  partitionRoot: string;
  partitionChild: string;
}

interface TriggerObservation {
  triggerCount: number;
  functionMatchCount: number;
}

function fixtureNames(): RealtimeFixtureNames {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return {
    eventTrigger: `realtime_attach_test_${suffix}`,
    ownerTable: `realtime_owner_${suffix}`,
    targetTable: `realtime_target_${suffix}`,
    privateSchema: `realtime_private_${suffix}`,
    privateTable: `realtime_private_target_${suffix}`,
    partitionRoot: `realtime_partition_root_${suffix}`,
    partitionChild: `realtime_partition_child_${suffix}`,
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function installNotifyFixture(database: ReservedSQL): Promise<void> {
  await database.unsafe("CREATE SCHEMA IF NOT EXISTS realtime");
  await database.unsafe(`
    CREATE OR REPLACE FUNCTION realtime.notify_postgres_changes()
    RETURNS trigger AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql
  `);
}

async function installAutoAttachTrigger(
  database: ReservedSQL,
  eventTriggerName: string,
): Promise<void> {
  await database.unsafe(SQL_MODULES["realtime-auto-attach-trigger"]);
  await database.unsafe(`
    CREATE EVENT TRIGGER ${quoteIdentifier(eventTriggerName)} ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE')
      EXECUTE FUNCTION realtime.auto_attach_notify_trigger()
  `);
}

async function createRegressionTables(
  database: ReservedSQL,
  names: RealtimeFixtureNames,
): Promise<void> {
  await database.unsafe(`CREATE TABLE public.${quoteIdentifier(names.ownerTable)} (id uuid PRIMARY KEY)`);
  await database.unsafe(`
    CREATE TABLE public.${quoteIdentifier(names.targetTable)} (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES public.${quoteIdentifier(names.ownerTable)}(id)
    )
  `);
  await database.unsafe(`CREATE SCHEMA ${quoteIdentifier(names.privateSchema)}`);
  await database.unsafe(`
    CREATE TABLE ${quoteIdentifier(names.privateSchema)}.${quoteIdentifier(names.privateTable)} (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES public.${quoteIdentifier(names.ownerTable)}(id)
    )
  `);
}

async function createPartitionTables(
  database: ReservedSQL,
  names: RealtimeFixtureNames,
): Promise<void> {
  await database.unsafe(`
    CREATE TABLE public.${quoteIdentifier(names.partitionRoot)} (id integer NOT NULL)
      PARTITION BY RANGE (id)
  `);
  await database.unsafe(`
    CREATE TABLE public.${quoteIdentifier(names.partitionChild)}
      PARTITION OF public.${quoteIdentifier(names.partitionRoot)}
      FOR VALUES FROM (0) TO (100)
  `);
}

async function triggerObservation(
  database: ReservedSQL,
  schemaName: string,
  tableName: string,
): Promise<TriggerObservation> {
  const [observation] = await database<TriggerObservation[]>`
    SELECT
      count(*) FILTER (WHERE t.tgname = 'realtime_notify_trigger')::int AS "triggerCount",
      count(*) FILTER (
        WHERE t.tgname = 'realtime_notify_trigger'
          AND t.tgfoid = 'realtime.notify_postgres_changes()'::regprocedure
      )::int AS "functionMatchCount"
    FROM pg_catalog.pg_trigger AS t
    JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schemaName}
      AND c.relname = ${tableName}
      AND NOT t.tgisinternal
  `;
  return observation;
}

async function verifyTriggerObservations(
  database: ReservedSQL,
  names: RealtimeFixtureNames,
): Promise<void> {
  expect(await triggerObservation(database, "public", names.targetTable)).toEqual({
    triggerCount: 1,
    functionMatchCount: 1,
  });
  expect(await triggerObservation(database, names.privateSchema, names.privateTable)).toEqual({
    triggerCount: 0,
    functionMatchCount: 0,
  });
  for (const tableName of [names.partitionRoot, names.partitionChild]) {
    expect(await triggerObservation(database, "public", tableName)).toEqual({
      triggerCount: 1,
      functionMatchCount: 1,
    });
  }
}

async function runRollbackIsolatedRegression(
  database: SQL,
  names: RealtimeFixtureNames,
): Promise<void> {
  const connection = await database.reserve();
  let transactionStarted = false;

  try {
    await connection.unsafe("BEGIN");
    transactionStarted = true;
    await installNotifyFixture(connection);
    await installAutoAttachTrigger(connection, names.eventTrigger);
    await createRegressionTables(connection, names);
    await createPartitionTables(connection, names);
    await verifyTriggerObservations(connection, names);
  } finally {
    try {
      if (transactionStarted) await connection.unsafe("ROLLBACK");
    } finally {
      connection.release();
    }
  }
}

test("auto-attaches one realtime trigger per public relation OID", async () => {
  const database = new SQL({
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres",
    max: 1,
  });

  try {
    await runRollbackIsolatedRegression(database, fixtureNames());
  } finally {
    await database.close();
  }
});
