import { expect, test } from "bun:test";
import { requestValidatedJson } from "./validated-json";

test("JSON reads capture method and cancellation identity before asynchronous transport starts", async () => {
  const original = new AbortController();
  const replacement = new AbortController();
  const options: RequestInit = { method: "GET", signal: original.signal };
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  let calls = 0;
  let transportedSignal: AbortSignal | null | undefined;
  const read = requestValidatedJson("/columns", async (_url, snapshot) => {
    calls++;
    expect(snapshot.method).toBe("GET");
    expect(snapshot.redirect).toBe("error");
    transportedSignal = snapshot.signal;
    started.resolve();
    return response.promise;
  }, value => value, options);
  options.method = "DELETE";
  options.signal = replacement.signal;
  await started.promise;
  replacement.abort();
  expect(transportedSignal?.aborted).toBe(false);
  original.abort();
  await expect(read).rejects.toMatchObject({ name: "AbortError" });
  expect(transportedSignal?.aborted).toBe(true);
  expect(calls).toBe(1);
  let cancelled = false;
  response.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(cancelled).toBe(true);
});

test("streaming JSON decodes split UTF-8 and rejects incomplete final characters", async () => {
  const encoded = new TextEncoder().encode('{"name":"\u754c"}');
  const read = (bytes: Uint8Array) => requestValidatedJson("/columns", async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
  ), value => value);
  expect(await read(encoded)).toEqual({ name: "\u754c" });
  await expect(read(Uint8Array.of(0x22, 0xe7, 0x95))).rejects.toThrow();
});

test("the deadline covers a stalled body and releases its reader without decoding or retry", async () => {
  let calls = 0;
  let decoded = false;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await expect(requestValidatedJson("/columns", async () => {
    calls++;
    return new Response(body);
  }, value => { decoded = true; return value; })).rejects.toMatchObject({ name: "AbortError" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls).toBe(1);
  expect(decoded).toBe(false);
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
}, 20_000);

test("custom JSON policies retain the actual status and do not weaken the default", async () => {
  await expect(requestValidatedJson("/session", async () => Response.json({ valid: false }, { status: 401 }),
    value => value)).rejects.toThrow("Invalid JSON response");
  const response = await requestValidatedJson("/session",
    async () => Response.json({ valid: false }, { status: 401 }),
    (value, status) => ({ value, status }), {}, { statuses: [200, 401], maxBytes: 64 * 1024 });
  expect(response).toEqual({ value: { valid: false }, status: 401 });
});

test("invalid JSON policies reject before transport and policy changes cannot alter an in-flight read", async () => {
  let calls = 0;
  const request = async () => { calls++; return Response.json({}); };
  for (const maxBytes of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(requestValidatedJson("/read", request, value => value, {}, { maxBytes })).rejects.toThrow();
  }
  for (const statuses of [[], [0], [199], [600], [200.5]]) {
    await expect(requestValidatedJson("/read", request, value => value, {}, { statuses })).rejects.toThrow();
  }
  expect(calls).toBe(0);
  const policy = { statuses: [200], maxBytes: 2 };
  const result = requestValidatedJson("/read", request, value => value, {}, policy);
  policy.statuses[0] = 500;
  policy.maxBytes = 1;
  expect(await result).toEqual({});
});
