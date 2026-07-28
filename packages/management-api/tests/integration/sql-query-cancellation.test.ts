import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import {
  executeCancellableSqlBatch,
  executeCancellableSqlQuery,
  PgError,
  sqlExecutionError,
} from "../../src/db";
import { cancelActiveSqlQuery } from "../../src/db/sql-query-registry";

const databaseUrl = process.env.SQL_CANCEL_TEST_DATABASE_URL;
const queryDb = new SQL(databaseUrl ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres", { max: 1 });
const cancellationDb = new SQL(databaseUrl ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres", { max: 1 });

afterAll(async () => {
  await Promise.all([
    queryDb.close({ timeout: 1 }),
    cancellationDb.close({ timeout: 1 }),
  ]);
});

async function requestConfirmedCancellation(projectRef: string, queryId: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const cancellation = await cancelActiveSqlQuery(projectRef, queryId);
    if (cancellation?.cancelled) return;
    await Bun.sleep(20);
  }
  throw new Error("PostgreSQL did not confirm cancellation within two seconds");
}

async function waitForActiveQueryMarker(marker: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const [activity] = await cancellationDb<{ activeCount: number }[]>`
      SELECT count(*)::int AS "activeCount"
      FROM pg_stat_activity
      WHERE state = ${"active"}
        AND query LIKE ${`%${marker}%`}
    `;
    if ((activity?.activeCount ?? 0) > 0) return;
    await Bun.sleep(20);
  }
  throw new Error("PostgreSQL batch query did not become active within two seconds");
}

test.skipIf(!databaseUrl)("cancels a live PostgreSQL query and removes it from pg_stat_activity", async () => {
  const projectRef = `cancel-project-${randomUUID()}`;
  const queryId = randomUUID();
  const marker = `cancel_${randomUUID().replaceAll("-", "")}`;
  const startedAt = performance.now();
  const execution = executeCancellableSqlQuery({
    queryDb,
    cancellationDb,
    projectRef,
    queryId,
    sqlQuery: `SELECT pg_sleep(30) /* ${marker} */`,
    startedAt,
  });

  await requestConfirmedCancellation(projectRef, queryId);

  let rejection: PgError | undefined;
  try {
    await execution;
  } catch (error) {
    rejection = sqlExecutionError(error, performance.now() - startedAt);
  }
  expect(rejection).toMatchObject({ code: "QUERY_CANCELLED", message: "Query cancelled" });

  const [activity] = await cancellationDb<{ activeCount: number }[]>`
    SELECT count(*)::int AS "activeCount"
    FROM pg_stat_activity
    WHERE state = ${"active"}
      AND query LIKE ${`%${marker}%`}
  `;
  expect(activity?.activeCount).toBe(0);
});

test.skipIf(!databaseUrl)("reports statement_timeout separately from user cancellation", async () => {
  await queryDb.unsafe("SET statement_timeout = '25ms'").execute();
  const startedAt = performance.now();
  let rejection: PgError | undefined;
  try {
    await executeCancellableSqlQuery({
      queryDb,
      cancellationDb,
      projectRef: `timeout-project-${randomUUID()}`,
      queryId: randomUUID(),
      sqlQuery: "SELECT pg_sleep(1)",
      startedAt,
    });
  } catch (error) {
    rejection = sqlExecutionError(error, performance.now() - startedAt);
  } finally {
    await queryDb.unsafe("SET statement_timeout = 0").execute();
  }

  expect(rejection).toMatchObject({ code: "QUERY_TIMEOUT", message: "Query timed out" });
});

test.skipIf(!databaseUrl)("rolls back a cancelled SQL batch and clears its registry entry", async () => {
  const projectRef = `cancel-batch-project-${randomUUID()}`;
  const queryId = randomUUID();
  const marker = `cancel_batch_sleep_${randomUUID().replaceAll("-", "")}`;
  const tableName = `cancel_batch_${randomUUID().replaceAll("-", "")}`;
  await cancellationDb.unsafe(`CREATE TABLE public.${tableName} (value integer NOT NULL)`).execute();

  try {
    const startedAt = performance.now();
    const execution = executeCancellableSqlBatch({
      queryDb,
      cancellationDb,
      projectRef,
      queryId,
      statements: [
        `INSERT INTO public.${tableName} (value) VALUES (1)`,
        `SELECT pg_sleep(30) /* ${marker} */`,
      ],
      startedAt,
    });

    await waitForActiveQueryMarker(marker);
    await requestConfirmedCancellation(projectRef, queryId);

    let rejection: PgError | undefined;
    try {
      await execution;
    } catch (error) {
      rejection = sqlExecutionError(error, performance.now() - startedAt);
    }
    expect(rejection).toMatchObject({ code: "QUERY_CANCELLED", message: "Query cancelled" });

    const [rowCount] = await cancellationDb<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ${cancellationDb(tableName)}
    `;
    expect(rowCount?.count).toBe(0);
    expect(await cancelActiveSqlQuery(projectRef, queryId)).toBeNull();
  } finally {
    await cancellationDb.unsafe(`DROP TABLE IF EXISTS public.${tableName}`).execute();
  }
});
