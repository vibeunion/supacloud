import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HttpTransport } from "./http";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

let clearedTimerIds: Array<ReturnType<typeof setTimeout> | undefined> = [];
let nextTimerId = 0;

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
        expect(fetchCalls).toBe(1);
        expect(clearedTimerIds).toHaveLength(1);
    });
});
