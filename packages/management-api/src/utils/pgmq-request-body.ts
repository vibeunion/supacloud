export const PGMQ_SEND_BODY_BYTES = 2 * 1024 * 1024;
export const PGMQ_BATCH_BODY_BYTES = 9 * 1024 * 1024;
export const PGMQ_BODY_MAX_CHUNKS = 65536;
const BODY_TIMEOUT_MS = 15000;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readPgmqEnqueueBody(request: Request, batch: boolean): Promise<unknown> {
  const value = await readPgmqRequestBody(request, batch ? PGMQ_BATCH_BODY_BYTES : PGMQ_SEND_BODY_BYTES);
  if (!isObject(value)) throw new PgmqRequestBodyError(400);
  if (batch) {
    if (!Array.isArray(value.messages) || !value.messages.every(isObject)) throw new PgmqRequestBodyError(400);
  } else {
    for (const key of ["message", "payload"]) {
      if (Object.hasOwn(value, key) && !isObject(value[key])) throw new PgmqRequestBodyError(400);
    }
  }
  return value;
}

export class PgmqRequestBodyError extends Error {
  constructor(readonly status: 400 | 408 | 413 | 415) {
    super("Queue request body could not be accepted");
    this.name = "PgmqRequestBodyError";
  }
}

export async function readPgmqRequestBody(
  request: Request,
  maxBytes: number,
  timeoutMs = BODY_TIMEOUT_MS,
): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const type = request.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;\s*charset=(?:"utf-8"|utf-8))?$/i.test(type)) {
      throw new PgmqRequestBodyError(415);
    }
    const encoding = request.headers.get("content-encoding");
    if (encoding !== null && encoding.toLowerCase() !== "identity") throw new PgmqRequestBodyError(415);
    const length = request.headers.get("content-length");
    if (length !== null && !/^(0|[1-9][0-9]{0,9})$/.test(length)) throw new PgmqRequestBodyError(400);
    const expected = length === null ? undefined : Number(length);
    if (expected !== undefined && expected > maxBytes) throw new PgmqRequestBodyError(413);
    if (!request.body || request.signal.aborted) throw new PgmqRequestBodyError(400);
    reader = request.body.getReader();
    const deadline = Date.now() + timeoutMs;
    const interrupted = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PgmqRequestBodyError(408)), timeoutMs);
      onAbort = () => reject(new PgmqRequestBodyError(400));
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
    });
    const activeReader = reader;
    async function consume(): Promise<unknown> {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let bytes = 0;
      let chunks = 0;
      const parts: string[] = [];
      while (true) {
        if (Date.now() >= deadline) throw new PgmqRequestBodyError(408);
        if (request.signal.aborted) throw new PgmqRequestBodyError(400);
        const chunk = await activeReader.read();
        if (Date.now() >= deadline) throw new PgmqRequestBodyError(408);
        if (request.signal.aborted) throw new PgmqRequestBodyError(400);
        if (chunk.done) break;
        if (++chunks > PGMQ_BODY_MAX_CHUNKS) throw new PgmqRequestBodyError(413);
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new PgmqRequestBodyError(413);
        if (expected !== undefined && bytes > expected) throw new PgmqRequestBodyError(400);
        const part = decoder.decode(chunk.value, { stream: true });
        if (part.length) parts.push(part);
      }
      if (expected !== undefined && bytes !== expected) throw new PgmqRequestBodyError(400);
      parts.push(decoder.decode());
      const result: unknown = JSON.parse(parts.join(""));
      return result;
    }
    return await Promise.race([consume(), interrupted]);
  } catch (error) {
    // A hostile or stalled stream must not delay the failure response during cleanup.
    if (reader) void reader.cancel().catch(() => {});
    else if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
    if (error instanceof PgmqRequestBodyError) throw error;
    throw new PgmqRequestBodyError(400);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) request.signal.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
}
