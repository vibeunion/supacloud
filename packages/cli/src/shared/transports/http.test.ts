import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HttpTransport } from "./http";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const MAX_TEST_RESPONSE_BYTES = 1024 * 1024;

let clearedTimerIds: Array<ReturnType<typeof setTimeout> | undefined> = [];
let nextTimerId = 0;
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

beforeEach(() => {
    clearedTimerIds = [];
    nextTimerId = 0;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        const timerId = ++nextTimerId as unknown as ReturnType<typeof setTimeout>;
        if (delay !== 30_000) queueMicrotask(() => callback(...args));
        return timerId;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timerId?: ReturnType<typeof setTimeout>) => {
        clearedTimerIds.push(timerId);
    }) as typeof clearTimeout;
});

afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
});

function createTransport(): HttpTransport {
    return new HttpTransport({ baseUrl: "https://api.example.test", token: "test-token" });
}

function retryableNetworkError(kind: "AbortError" | "ECONNREFUSED" | "ECONNRESET"): Error {
    const error = new Error(kind);
    if (kind === "AbortError") error.name = kind;
    else Object.assign(error, { code: kind });
    return error;
}

function whitespaceJson(totalBytes: number): string {
    return `${" ".repeat(totalBytes - 2)}[]`;
}

function chunkedTextResponse(body: string): Response {
    const bytes = new TextEncoder().encode(body);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= bytes.byteLength) return controller.close();
            const nextOffset = Math.min(offset + 256 * 1024, bytes.byteLength);
            controller.enqueue(bytes.subarray(offset, nextOffset));
            offset = nextOffset;
        },
    });
    return new Response(stream, { headers: { "Content-Type": "application/json" } });
}

describe("HttpTransport retry policy", () => {
    test("retries GET after a 5xx response without waiting for backoff", async () => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls++;
            return fetchCalls === 1
                ? Response.json({ error: "temporary" }, { status: 503 })
                : Response.json({ ok: true });
        }) as unknown as typeof fetch;

        const response = await createTransport().get<{ ok: boolean }>("/v1/projects");

        expect(response.ok).toBe(true);
        expect(fetchCalls).toBe(2);
        expect(clearedTimerIds).toHaveLength(2);
    });

    test.each(["AbortError", "ECONNREFUSED", "ECONNRESET"] as const)(
        "retries GET after %s",
        async errorKind => {
            let fetchCalls = 0;
            globalThis.fetch = (async () => {
                fetchCalls++;
                if (fetchCalls === 1) throw retryableNetworkError(errorKind);
                return Response.json({ ok: true });
            }) as unknown as typeof fetch;

            const response = await createTransport().get<{ ok: boolean }>("/v1/projects");

            expect(response.ok).toBe(true);
            expect(fetchCalls).toBe(2);
            expect(clearedTimerIds).toHaveLength(2);
        },
    );

    const unsafeRequests = [
        ["POST", (transport: HttpTransport) => transport.post("/resource", { name: "test" })],
        ["multipart POST", (transport: HttpTransport) => transport.postMultipart("/resource", new FormData())],
        ["PATCH", (transport: HttpTransport) => transport.patch("/resource", { name: "test" })],
        ["PUT", (transport: HttpTransport) => transport.put("/resource", { name: "test" })],
        ["DELETE", (transport: HttpTransport) => transport.delete("/resource")],
    ] as const;

    test.each(unsafeRequests)("does not retry %s after a 5xx response", async (_method, request) => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls++;
            return Response.json({ error: "temporary" }, { status: 503 });
        }) as unknown as typeof fetch;

        const response = await request(createTransport());

        expect(response.status).toBe(503);
        expect(fetchCalls).toBe(1);
        expect(clearedTimerIds).toHaveLength(1);
    });

    test.each(unsafeRequests)("does not retry %s after a retryable network error", async (_method, request) => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls++;
            throw retryableNetworkError("ECONNRESET");
        }) as unknown as typeof fetch;

        const response = await request(createTransport());

        expect(response.status).toBe(500);
        expect(response.transportError).toBe(true);
        expect(fetchCalls).toBe(1);
        expect(clearedTimerIds).toHaveLength(1);
    });

    const transportFailureRequests = [
        ["GET", (transport: HttpTransport) => transport.get("/resource")],
        ...unsafeRequests,
    ] as const;

    test.each(transportFailureRequests)("redacts %s transport error messages", async (_method, request) => {
        const errorSentinel = "private-transport-sentinel";
        globalThis.fetch = (async () => {
            throw new Error(errorSentinel);
        }) as unknown as typeof fetch;

        const response = await request(createTransport());
        const serialized = JSON.stringify(response);

        expect(response.transportError).toBe(true);
        expect(response.data).toEqual({ error: "Network Error", code: "NETWORK_ERROR" });
        expect(serialized).not.toContain(errorSentinel);
        expect(serialized).not.toContain("details");
    });
});

describe("HttpTransport bounded GET responses", () => {
    test("accepts an exact 1 MiB UTF-8 JSON response", async () => {
        const body = whitespaceJson(MAX_TEST_RESPONSE_BYTES);
        globalThis.fetch = (async () => new Response(body, {
            headers: { "Content-Length": String(MAX_TEST_RESPONSE_BYTES) },
        })) as unknown as typeof fetch;

        const response = await createTransport().get("/resource", {
            maxResponseBytes: MAX_TEST_RESPONSE_BYTES,
        });

        expect(Buffer.byteLength(body)).toBe(MAX_TEST_RESPONSE_BYTES);
        expect(response).toMatchObject({ ok: true, status: 200, data: [] });
    });

    test("rejects an advertised response one byte over 1 MiB", async () => {
        const body = whitespaceJson(MAX_TEST_RESPONSE_BYTES + 1);
        globalThis.fetch = (async () => new Response(body, {
            headers: { "Content-Length": String(MAX_TEST_RESPONSE_BYTES + 1) },
        })) as unknown as typeof fetch;

        const response = await createTransport().get("/resource", {
            maxResponseBytes: MAX_TEST_RESPONSE_BYTES,
        });

        expect(response).toMatchObject({ ok: true, status: 200, data: null });
    });

    test("rejects a chunked response over 1 MiB without Content-Length", async () => {
        const body = whitespaceJson(MAX_TEST_RESPONSE_BYTES + 1);
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => chunkedTextResponse(body),
        });
        servers.push(server);
        const transport = new HttpTransport({
            baseUrl: `http://127.0.0.1:${server.port}`,
            token: "test-token",
        });

        const response = await transport.get("/resource", {
            maxResponseBytes: MAX_TEST_RESPONSE_BYTES,
        });

        expect(response).toMatchObject({ ok: true, status: 200, data: null });
    });

    test("rejects invalid UTF-8 within the byte limit", async () => {
        globalThis.fetch = (async () => new Response(new Uint8Array([0xff]))) as unknown as typeof fetch;

        const response = await createTransport().get("/resource", {
            maxResponseBytes: MAX_TEST_RESPONSE_BYTES,
        });

        expect(response).toMatchObject({ ok: true, status: 200, data: null });
    });
});
