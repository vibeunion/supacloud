type DatabaseSqlPayload = {
  rows?: unknown;
  rowCount?: unknown;
  command?: unknown;
  error?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
};

export type DatabaseSqlResponse = {
  rows: unknown[];
  rowCount: number;
  command: string | null;
};

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

export async function readDatabaseSqlResponse(response: Response): Promise<DatabaseSqlResponse> {
  const payload = await responsePayload(response);
  if (!response.ok || payload.error) {
    throw new Error(responseMessage(payload, `SQL 请求失败 (${response.status})`));
  }

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const rowCount = typeof payload.rowCount === "number" ? payload.rowCount : rows.length;
  return {
    rows,
    rowCount,
    command: typeof payload.command === "string" ? payload.command : null,
  };
}
