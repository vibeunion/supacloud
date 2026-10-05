export interface AccountingRecord {
  sessionId: string;
  sequence: string;
  kind: "start" | "interim" | "stop";
  inputOctets: string;
  outputOctets: string;
  recordedAt: string;
}
export interface AccountingRequest {
  schemaVersion: 1;
  projectRef: string;
  operationId: string;
  records: AccountingRecord[];
}

/** Stateless computation only. Never apply this retry boundary to external effects. */
export async function normalizeAccounting(
  endpoint: string,
  token: string,
  input: AccountingRequest,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<AccountingRequest> {
  const url = new URL(endpoint);
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !["127.0.0.1", "[::1]"].includes(url.hostname)) ||
    token.length < 32 || !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 || options.timeoutMs > 30000) throw new Error("NATIVE_CONFIG_INVALID");
  const body = JSON.stringify(input);
  if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("NATIVE_INPUT_TOO_LARGE");
  try {
    const result = await fetch(new URL("/v1/accounting/normalize", url), {
      method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body, signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
    });
    if (!result.ok || !result.body) { await result.body?.cancel(); throw new Error(); }
    const reader = result.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new Error();
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== 1 ||
      !("projectRef" in value) || value.projectRef !== input.projectRef ||
      !("operationId" in value) || value.operationId !== input.operationId ||
      !("records" in value) || !Array.isArray(value.records) || value.records.length !== input.records.length)
      throw new Error();
    const records = value.records.map((record: unknown, index): AccountingRecord => {
      const original = input.records[index]!;
      if (!record || typeof record !== "object" ||
        !("sessionId" in record) || record.sessionId !== original.sessionId ||
        !("sequence" in record) || record.sequence !== original.sequence ||
        !("kind" in record) || record.kind !== original.kind ||
        !("inputOctets" in record) || record.inputOctets !== original.inputOctets ||
        !("outputOctets" in record) || record.outputOctets !== original.outputOctets ||
        !("recordedAt" in record) || typeof record.recordedAt !== "string" ||
        !Number.isFinite(Date.parse(record.recordedAt)) ||
        Date.parse(record.recordedAt) !== Date.parse(original.recordedAt)) throw new Error();
      return { ...original, recordedAt: record.recordedAt };
    });
    return { schemaVersion: 1, projectRef: input.projectRef, operationId: input.operationId, records };
  } catch { throw new Error("NATIVE_EXECUTION_FAILED"); }
}
