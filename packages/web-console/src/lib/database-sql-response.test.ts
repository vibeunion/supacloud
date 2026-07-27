import { expect, test } from "bun:test";
import { readDatabaseSqlResponse } from "./database-sql-response";

test("returns successful SQL rows and metadata", async () => {
  const response = new Response(JSON.stringify({ rows: [{ answer: 42 }], rowCount: 1, command: "SELECT" }), { status: 200 });

  await expect(readDatabaseSqlResponse(response)).resolves.toEqual({
    rows: [{ answer: 42 }],
    rowCount: 1,
    command: "SELECT",
  });
});

test("surfaces SQL API error messages from failed responses", async () => {
  const response = new Response(JSON.stringify({ message: 'syntax error at or near "FRM"' }), { status: 400 });

  await expect(readDatabaseSqlResponse(response)).rejects.toThrow('syntax error at or near "FRM"');
});

test("does not treat an error envelope as an empty successful result", async () => {
  const response = new Response(JSON.stringify({ error: "multiple statements are not allowed" }), { status: 200 });

  await expect(readDatabaseSqlResponse(response)).rejects.toThrow("multiple statements are not allowed");
});
