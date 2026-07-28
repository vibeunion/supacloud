import { expect, test } from "bun:test";
import {
  DatabaseSqlError,
  readDatabaseSqlCancellationResponse,
  readDatabaseSqlResponse,
} from "./database-sql-response";

test("returns successful SQL rows, metadata, and duration", async () => {
  const response = new Response(JSON.stringify({
    rows: [{ answer: 42 }],
    rowCount: 1,
    command: "SELECT",
    durationMs: 17,
  }), { status: 200 });

  await expect(readDatabaseSqlResponse(response)).resolves.toEqual({
    rows: [{ answer: 42 }],
    rowCount: 1,
    command: "SELECT",
    statementCount: 1,
    durationMs: 17,
  });
});

test("returns the executed statement count for an atomic SQL batch", async () => {
  const response = Response.json({
    rows: [],
    rowCount: 0,
    command: "BATCH",
    statements: [
      { index: 1, command: "CREATE", rowCount: 0, durationMs: 2 },
      { index: 2, command: "ALTER", rowCount: 0, durationMs: 1 },
    ],
    durationMs: 4,
  });

  await expect(readDatabaseSqlResponse(response)).resolves.toMatchObject({
    command: "BATCH",
    statementCount: 2,
  });
});

test("preserves SQL API error code and duration", async () => {
  const response = new Response(JSON.stringify({
    message: 'syntax error at or near "FRM"',
    code: "42601",
    durationMs: 9,
  }), { status: 400 });

  try {
    await readDatabaseSqlResponse(response);
    throw new Error("expected SQL response to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseSqlError);
    expect((error as DatabaseSqlError).message).toBe('syntax error at or near "FRM"');
    expect((error as DatabaseSqlError).code).toBe("42601");
    expect((error as DatabaseSqlError).durationMs).toBe(9);
  }
});

test("does not treat an error envelope as an empty successful result", async () => {
  const response = new Response(JSON.stringify({ error: "multiple statements are not allowed" }), { status: 200 });

  await expect(readDatabaseSqlResponse(response)).rejects.toThrow("multiple statements are not allowed");
});

test("returns server-confirmed SQL cancellation metadata", async () => {
  const response = Response.json({
    query_id: "18da2c53-48f9-47bc-a255-530adc1eef26",
    cancelled: true,
    durationMs: 125,
  });

  await expect(readDatabaseSqlCancellationResponse(response)).resolves.toEqual({
    queryId: "18da2c53-48f9-47bc-a255-530adc1eef26",
    cancelled: true,
    durationMs: 125,
  });
});

test("rejects unconfirmed SQL cancellation responses", async () => {
  const response = Response.json({
    message: "SQL query is not running",
    code: "QUERY_NOT_RUNNING",
  }, { status: 404 });

  await expect(readDatabaseSqlCancellationResponse(response)).rejects.toMatchObject({
    message: "SQL query is not running",
    code: "QUERY_NOT_RUNNING",
  });
});
