import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HttpTransport } from "./http";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

let clearedTimerIds: Array<ReturnType<typeof setTimeout> | undefined> = [];
let scheduledTimers: Array<{
    callback: (...args: unknown[]) => void;
    delay: number | undefined;
    args: unknown[];
}> = [];
let nextTimerId = 0;

beforeEach(() => {
    clearedTimerIds = [];
    scheduledTimers = [];
    nextTimerId = 0;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        const timerId = ++nextTimerId as unknown as ReturnType<typeof setTimeout>;
        scheduledTimers.push({ callback, delay, args });
        if (delay === 500 || delay === 1_000) queueMicrotask(() => callback(...args));
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

    test("does not retry POST after an HTTP 408 response", async () => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls++;
            return Response.json({ error: "request timeout" }, { status: 408 });
        }) as unknown as typeof fetch;

        const response = await createTransport().post("/resource", { name: "test" });

        expect(response.status).toBe(408);
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
        expect(response.data).toEqual({
            error: "Network Error",
            code: "CONNECTION_RESET",
        });
        expect(fetchCalls).toBe(1);
        expect(clearedTimerIds).toHaveLength(1);
    });

    test("uses a bounded operation-specific timeout for one POST", async () => {
        globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;

        const response = await createTransport().post(
            "/v1/projects/fa/database/backups",
            { type: "full" },
            { timeoutMs: 35 * 60_000 },
        );

        expect(response.ok).toBe(true);
        expect(scheduledTimers.map(({ delay }) => delay)).toEqual([35 * 60_000]);
        expect(clearedTimerIds).toHaveLength(1);
    });

    test("aborts a long POST at its cap without retrying", async () => {
        let fetchCalls = 0;
        globalThis.fetch = ((_input, init) => {
            fetchCalls++;
            return new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    const error = new Error("request timed out");
                    error.name = "AbortError";
                    reject(error);
                });
                queueMicrotask(() => scheduledTimers[0].callback(...scheduledTimers[0].args));
            });
        }) as typeof fetch;

        const response = await createTransport().post(
            "/v1/projects/fa/database/backups",
            { type: "full" },
            { timeoutMs: 35 * 60_000 },
        );

        expect(response).toEqual({
            ok: false,
            status: 500,
            data: { error: "Network Error", code: "TIMEOUT" },
            transportError: true,
        });
        expect(fetchCalls).toBe(1);
        expect(clearedTimerIds).toHaveLength(1);
    });

    test.each([0, 35 * 60_000 + 1, 1.5])("rejects invalid POST timeout %d before dispatch", async timeoutMs => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls++;
            return Response.json({ ok: true });
        }) as unknown as typeof fetch;

        await expect(createTransport().post("/resource", {}, { timeoutMs })).rejects.toThrow(
            "HTTP request timeout must be between",
        );
        expect(fetchCalls).toBe(0);
    });

    test("never preserves an arbitrary transport error message", async () => {
        const privateDetail = "Bearer private-transport-token";
        globalThis.fetch = (async () => {
            throw Object.assign(new Error(privateDetail), { code: "EHOSTUNREACH" });
        }) as unknown as typeof fetch;

        const response = await createTransport().post("/v1/projects", { name: "test" });

        expect(response).toEqual({
            ok: false,
            status: 500,
            data: { error: "Network Error", code: "NETWORK_ERROR" },
            transportError: true,
        });
        expect(JSON.stringify(response)).not.toContain(privateDetail);
    });
});
