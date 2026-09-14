type DatabaseSqlPayload = {
  rows?: unknown;
  rowCount?: unknown;
  command?: unknown;
  code?: unknown;
  durationMs?: unknown;
  cancelled?: unknown;
  query_id?: unknown;
  error?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
  statements?: unknown;
};

function isDatabaseSqlPayload(value: unknown): value is DatabaseSqlPayload {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type DatabaseSqlResponse = {
  rows: Record<string, unknown>[];
  rowCount: number;
  command: string | null;
  statementCount: number;
  durationMs: number | null;
};

function invalidSqlResponse(): DatabaseSqlError {
  return new DatabaseSqlError("Invalid SQL response", "INVALID_SQL_RESPONSE", null);
}

function isSqlRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseDatabaseSqlRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw invalidSqlResponse();
  const input: unknown[] = value;
  const rows: Record<string, unknown>[] = [];
  for (const row of input) {
    if (!isSqlRow(row)) throw invalidSqlResponse();
    rows.push(row);
  }
  return rows;
}

export type DatabaseSqlCancellationResponse = {
  queryId: string;
  cancelled: true;
  durationMs: number;
};

export class DatabaseSqlError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly durationMs: number | null,
  ) {
    super(message);
    this.name = "DatabaseSqlError";
  }
}

function responseMessage(payload: DatabaseSqlPayload, fallback: string): string {
  const message = typeof payload.message === "string" ? payload.message : payload.error;
  if (typeof message === "string" && message.trim()) return message;
  return fallback;
}

async function responsePayload(response: Response): Promise<DatabaseSqlPayload> {
  const text = await response.text();
  if (!text) return {};
  try {
    const payload: unknown = JSON.parse(text);
    return isDatabaseSqlPayload(payload)
      ? payload
      : { message: text };
  } catch {
    return { message: text };
  }
}

function responseDuration(payload: DatabaseSqlPayload): number | null {
  return typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs) && payload.durationMs >= 0
    ? payload.durationMs
    : null;
}

function sqlResponseError(payload: DatabaseSqlPayload, fallback: string): DatabaseSqlError {
  return new DatabaseSqlError(
    responseMessage(payload, fallback),
    typeof payload.code === "string" ? payload.code : null,
    responseDuration(payload),
  );
}

function responseStatementCount(value: unknown): number {
  if (value === undefined) return 1;
  if (!Array.isArray(value) || value.length === 0) throw invalidSqlResponse();
  const statements: unknown[] = value;
  for (const [index, statement] of statements.entries()) {
    if (!isSqlRow(statement) || statement.index !== index + 1
      || typeof statement.command !== "string" || !statement.command.trim()
      || typeof statement.rowCount !== "number" || !Number.isSafeInteger(statement.rowCount) || statement.rowCount < 0
      || typeof statement.durationMs !== "number" || !Number.isFinite(statement.durationMs) || statement.durationMs < 0) {
      throw invalidSqlResponse();
    }
  }
  return statements.length;
}

export async function readDatabaseSqlResponse(response: Response): Promise<DatabaseSqlResponse> {
  const payload = await responsePayload(response);
  if (!response.ok || (payload.error !== undefined && payload.error !== null)) {
    throw sqlResponseError(payload, `SQL 请求失败 (${response.status})`);
  }

  const rows = parseDatabaseSqlRows(payload.rows);
  const rowCount = payload.rowCount === undefined ? rows.length : payload.rowCount;
  if (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 0
    || (payload.command !== undefined && payload.command !== null && typeof payload.command !== "string")
    || (payload.durationMs !== undefined && responseDuration(payload) === null)) {
    throw invalidSqlResponse();
  }
  return {
    rows,
    rowCount,
    command: typeof payload.command === "string" ? payload.command : null,
    statementCount: responseStatementCount(payload.statements),
    durationMs: responseDuration(payload),
  };
}

export async function readDatabaseSqlCancellationResponse(
  response: Response,
  expectedQueryId?: string,
): Promise<DatabaseSqlCancellationResponse> {
  const payload = await responsePayload(response);
  const durationMs = responseDuration(payload);
  if (
    !response.ok
    || payload.cancelled !== true
    || typeof payload.query_id !== "string"
    || !payload.query_id.trim()
    || (expectedQueryId !== undefined && payload.query_id !== expectedQueryId)
    || (payload.error !== undefined && payload.error !== null)
    || durationMs === null
  ) {
    throw sqlResponseError(payload, `取消 SQL 查询失败 (${response.status})`);
  }
  return {
    queryId: payload.query_id,
    cancelled: true,
    durationMs,
  };
}
