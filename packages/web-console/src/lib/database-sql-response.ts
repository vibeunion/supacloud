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

export type DatabaseSqlResponse = {
  rows: unknown[];
  rowCount: number;
  command: string | null;
  statementCount: number;
  durationMs: number | null;
};

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
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as DatabaseSqlPayload
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

export async function readDatabaseSqlResponse(response: Response): Promise<DatabaseSqlResponse> {
  const payload = await responsePayload(response);
  if (!response.ok || payload.error) {
    throw sqlResponseError(payload, `SQL 请求失败 (${response.status})`);
  }

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const rowCount = typeof payload.rowCount === "number" ? payload.rowCount : rows.length;
  return {
    rows,
    rowCount,
    command: typeof payload.command === "string" ? payload.command : null,
    statementCount: Array.isArray(payload.statements) ? payload.statements.length : 1,
    durationMs: responseDuration(payload),
  };
}

export async function readDatabaseSqlCancellationResponse(
  response: Response,
): Promise<DatabaseSqlCancellationResponse> {
  const payload = await responsePayload(response);
  const durationMs = responseDuration(payload);
  if (
    !response.ok
    || payload.cancelled !== true
    || typeof payload.query_id !== "string"
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
