import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL, type ReservedSQL } from "bun";
import { SQL_MODULES } from "../../src/db/sql-modules";
import { ALTER_TENANT_SQL } from "../../src/services/tenant-runtime-migration";

interface PayloadBoundary {
  label: string;
  belowLimitExpression: string;
  atLimitExpression: string;
}

interface PayloadSizes {
  belowLimit: number;
  atLimit: number;
}

interface ServerVersion {
  versionNumber: number;
}

interface RealtimeSecurityModes {
  helperSecurityDefiner: boolean;
  triggerSecurityDefiner: boolean;
}

const databaseUrl = process.env.DATABASE_URL
  ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const postgresContainer = process.env.POSTGRES_CONTAINER;
const fixtureSuffix = randomUUID().replaceAll("-", "").slice(0, 12);
const fixtureTable = `realtime_payload_${fixtureSuffix}`;
const fixtureRole = `realtime_notify_owner_${fixtureSuffix}`;
const database = new SQL({ url: databaseUrl, max: 3 });

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function canonicalTriggerFunctionSql(): string {
  const signature = "CREATE OR REPLACE FUNCTION realtime.notify_postgres_changes()";
  const terminator = "$fn$ LANGUAGE plpgsql SECURITY DEFINER;";
  const functionStart = ALTER_TENANT_SQL.indexOf(signature);
  const functionEnd = ALTER_TENANT_SQL.indexOf(terminator, functionStart);
  if (functionStart < 0 || functionEnd < 0) {
    throw new Error("Canonical realtime trigger function is missing");
  }
  return ALTER_TENANT_SQL.slice(functionStart, functionEnd + terminator.length);
}

async function collectListenerOutput(
  stream: ReadableStream<Uint8Array>,
  markReady: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let listenerOutput = "";
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) return listenerOutput + decoder.decode();
    listenerOutput += decoder.decode(chunk, { stream: true });
    if (listenerOutput.includes("LISTEN\n")) markReady();
  }
}

async function waitForListenerReady(ready: Promise<void>): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Timed out waiting for LISTEN readiness")), 2_000);
  });
  try {
    await Promise.race([ready, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function notificationFrom(action: () => Promise<unknown>): Promise<string | null> {
  if (!postgresContainer) throw new Error("POSTGRES_CONTAINER is required for PG18 notification tests");

  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const listenerProcess = Bun.spawn([
    "docker", "exec", postgresContainer, "psql", "-U", "postgres", "-d", "postgres", "-X",
    "-v", "ON_ERROR_STOP=1", "-c", "LISTEN realtime_changes", "-c", "SELECT pg_sleep(2)",
  ], { stdout: "pipe", stderr: "pipe" });
  const stdout = collectListenerOutput(listenerProcess.stdout, markReady);
  const stderr = new Response(listenerProcess.stderr).text();

  await waitForListenerReady(ready);
  await action();

  const [exitCode, listenerOutput, listenerError] = await Promise.all([
    listenerProcess.exited,
    stdout,
    stderr,
  ]);
  expect(exitCode, listenerError).toBe(0);
  return listenerOutput.match(
    /Asynchronous notification "realtime_changes" with payload "(.*)" received/,
  )?.[1] ?? null;
}

async function installRealtimeFixture(): Promise<void> {
  await database.unsafe("CREATE SCHEMA IF NOT EXISTS realtime");
  await database.unsafe(SQL_MODULES["realtime-notify-payload"]);
  await database.unsafe(canonicalTriggerFunctionSql());
  await database.unsafe(`CREATE TABLE public.${quoteIdentifier(fixtureTable)} (id integer PRIMARY KEY, body text NOT NULL)`);
  await database.unsafe(`DROP TRIGGER IF EXISTS realtime_notify_trigger ON public.${quoteIdentifier(fixtureTable)}`);
  await database.unsafe(`
    CREATE TRIGGER realtime_notify_trigger
    AFTER INSERT OR UPDATE OR DELETE ON public.${quoteIdentifier(fixtureTable)}
    FOR EACH ROW EXECUTE FUNCTION realtime.notify_postgres_changes()
  `);
}

async function payloadSizes(boundary: PayloadBoundary): Promise<PayloadSizes> {
  const [sizes] = await database.unsafe<PayloadSizes[]>(`
    SELECT
      pg_catalog.octet_length((${boundary.belowLimitExpression})::text)::int AS "belowLimit",
      pg_catalog.octet_length((${boundary.atLimitExpression})::text)::int AS "atLimit"
  `);
  return sizes;
}

async function expectBoundaryBehavior(boundary: PayloadBoundary): Promise<void> {
  expect(await payloadSizes(boundary), boundary.label).toEqual({ belowLimit: 7999, atLimit: 8000 });
  expect(await notificationFrom(() => database.unsafe(
    `SELECT realtime.notify_change_payload(${boundary.belowLimitExpression})`,
  )), boundary.label).not.toBeNull();
  expect(await notificationFrom(() => database.unsafe(
    `SELECT realtime.notify_change_payload(${boundary.atLimitExpression})`,
  )), boundary.label).toBeNull();
}

async function realtimeSecurityModes(): Promise<RealtimeSecurityModes> {
  const [securityModes] = await database<RealtimeSecurityModes[]>`
    SELECT
      (SELECT prosecdef FROM pg_catalog.pg_proc
        WHERE oid = 'realtime.notify_change_payload(jsonb)'::regprocedure) AS "helperSecurityDefiner",
      (SELECT prosecdef FROM pg_catalog.pg_proc
        WHERE oid = 'realtime.notify_postgres_changes()'::regprocedure) AS "triggerSecurityDefiner"
  `;
  return securityModes;
}

async function createRestrictedRole(connection: ReservedSQL): Promise<void> {
  await connection.unsafe(`CREATE ROLE ${quoteIdentifier(fixtureRole)} NOLOGIN`);
  await connection.unsafe(`GRANT USAGE ON SCHEMA realtime TO ${quoteIdentifier(fixtureRole)}`);
  await connection.unsafe(
    `GRANT INSERT ON TABLE public.${quoteIdentifier(fixtureTable)} TO ${quoteIdentifier(fixtureRole)}`,
  );
}

async function invokeWithOrdinaryPermissions(connection: ReservedSQL): Promise<void> {
  await connection.unsafe(`SET LOCAL ROLE ${quoteIdentifier(fixtureRole)}`);
  await connection.unsafe("SELECT realtime.notify_change_payload('{\"ordinary\":true}'::jsonb)");
  await connection.unsafe(
    `INSERT INTO public.${quoteIdentifier(fixtureTable)} (id, body) VALUES (3, 'restricted caller')`,
  );
  await connection.unsafe("RESET ROLE");
}

async function restrictedPermissionError(connection: ReservedSQL): Promise<unknown> {
  await connection.unsafe("REVOKE EXECUTE ON FUNCTION pg_catalog.pg_notify(text, text) FROM PUBLIC");
  await connection.unsafe(`SET LOCAL ROLE ${quoteIdentifier(fixtureRole)}`);
  await connection.unsafe(
    `INSERT INTO public.${quoteIdentifier(fixtureTable)} (id, body) VALUES (4, 'definer trigger')`,
  );
  try {
    await connection.unsafe("SELECT realtime.notify_change_payload('{\"small\":true}'::jsonb)");
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

async function expectInvokerSecurityAndNonPayloadError(): Promise<void> {
  expect(await realtimeSecurityModes()).toEqual({
    helperSecurityDefiner: false,
    triggerSecurityDefiner: true,
  });

  const connection = await database.reserve();
  await connection.unsafe("BEGIN");
  try {
    await createRestrictedRole(connection);
    await invokeWithOrdinaryPermissions(connection);
    const permissionError = await restrictedPermissionError(connection);
    expect(permissionError).toBeInstanceOf(Error);
    expect((permissionError as Error).message).toContain("permission denied for function pg_notify");
  } finally {
    await connection.unsafe("ROLLBACK");
    connection.release();
  }
}

beforeAll(async () => {
  const [server] = await database<ServerVersion[]>`
    SELECT current_setting('server_version_num')::int AS "versionNumber"
  `;
  expect(server.versionNumber).toBeGreaterThanOrEqual(180_000);
  expect(server.versionNumber).toBeLessThan(190_000);
  await installRealtimeFixture();
});

afterAll(async () => {
  await database.unsafe(`DROP TABLE IF EXISTS public.${quoteIdentifier(fixtureTable)}`);
  await database.close();
});

describe("realtime NOTIFY payload safety on PostgreSQL 18", () => {
  test("uses byte length for ASCII, Chinese, and emoji boundaries", async () => {
    const boundaries: PayloadBoundary[] = [
      {
        label: "ASCII",
        belowLimitExpression: "to_jsonb(repeat('a', 7997))",
        atLimitExpression: "to_jsonb(repeat('a', 7998))",
      },
      {
        label: "Chinese",
        belowLimitExpression: "to_jsonb(repeat('中', 2665) || 'aa')",
        atLimitExpression: "to_jsonb(repeat('中', 2665) || 'aaa')",
      },
      {
        label: "emoji",
        belowLimitExpression: "to_jsonb(repeat('😀', 1999) || 'a')",
        atLimitExpression: "to_jsonb(repeat('😀', 1999) || 'aa')",
      },
    ];
    for (const boundary of boundaries) await expectBoundaryBehavior(boundary);
  }, 20_000);

  test("preserves the small postgres_changes notification shape", async () => {
    const notification = await notificationFrom(() => database.unsafe(
      `INSERT INTO public.${quoteIdentifier(fixtureTable)} (id, body) VALUES (1, 'small')`,
    ));
    const parsedNotification = JSON.parse(notification!);

    expect(parsedNotification).toEqual({
      event: "postgres_changes",
      payload: {
        columns: [{ name: "id", type: "int4" }, { name: "body", type: "text" }],
        commit_timestamp: expect.any(String),
        old_record: null,
        record: { body: "small", id: 1 },
        schema: "public",
        table: fixtureTable,
        type: "INSERT",
      },
      topic: "realtime:public",
    });
  });

  test("commits oversized INSERT, UPDATE, and DELETE statements", async () => {
    await database.unsafe(
      `INSERT INTO public.${quoteIdentifier(fixtureTable)} (id, body) VALUES (2, repeat('x', 9000))`,
    );
    expect(await database`SELECT body FROM ${database(fixtureTable)} WHERE id = 2`).toHaveLength(1);

    await database.unsafe(
      `UPDATE public.${quoteIdentifier(fixtureTable)} SET body = repeat('中', 4000) WHERE id = 2`,
    );
    const [updated] = await database`SELECT pg_catalog.octet_length(body)::int AS bytes FROM ${database(fixtureTable)} WHERE id = 2`;
    expect(updated.bytes).toBe(12_000);

    await database.unsafe(`DELETE FROM public.${quoteIdentifier(fixtureTable)} WHERE id = 2`);
    expect(await database`SELECT id FROM ${database(fixtureTable)} WHERE id = 2`).toHaveLength(0);
  });

  test("uses invoker rights and propagates errors other than SQLSTATE 22023", async () => {
    await expectInvokerSecurityAndNonPayloadError();
  });
});
