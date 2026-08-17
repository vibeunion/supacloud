import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HttpTransport } from "./http";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const MAX_TEST_RESPONSE_BYTES = 1024 * 1024;
const RELEASE_MUTATION_RESPONSE_MAX_BYTES = 64 * 1024;

let clearedTimerIds: Array<ReturnType<typeof setTimeout> | undefined> = [];
let nextTimerId = 0;
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

beforeEach(() => {
    clearedTimerIds = [];
    nextTimerId = 0;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        const timerId = ++nextTimerId as unknown as ReturnType<typeof setTimeout>;
        if (delay === 500 || delay === 1_000) queueMicrotask(() => callback(...args));
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

function chunkedTextResponse(
    body: string,
    headers: HeadersInit = { "Content-Type": "application/json" },
    chunkBytes = 256 * 1024,
): Response {
    const bytes = new TextEncoder().encode(body);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= bytes.byteLength) return controller.close();
            const nextOffset = Math.min(offset + chunkBytes, bytes.byteLength);
            controller.enqueue(bytes.subarray(offset, nextOffset));
            offset = nextOffset;
        },
    });
    return new Response(stream, { headers });
}

const redirectedRequests = [
    ["GET", (transport: HttpTransport) => transport.get("/resource")],
    [
        "JSON POST",
        (transport: HttpTransport) => transport.post("/resource", { secret: "request-secret" }),
    ],
    [
        "release POST",
        (transport: HttpTransport) => transport.postReleaseMutation("/resource", { secret: "request-secret" }),
    ],
    ["multipart POST", (transport: HttpTransport) => {
        const form = new FormData();
        form.set("secret", "request-secret");
        return transport.postMultipart("/resource", form);
    }],
    ["PATCH", (transport: HttpTransport) => transport.patch("/resource", { secret: "request-secret" })],
    ["PUT", (transport: HttpTransport) => transport.put("/resource", { secret: "request-secret" })],
    ["DELETE", (transport: HttpTransport) => transport.delete("/resource")],
] as const;

const redirectCases = redirectedRequests.flatMap(([requestName, sendRequest]) =>
    ([302, 307] as const).flatMap((redirectStatus) =>
        (["same-origin", "cross-origin"] as const).map((redirectScope) =>
            [`${requestName} ${redirectStatus} ${redirectScope}`, sendRequest, redirectStatus, redirectScope] as const
        )
    )
);

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
        ["POST", (transport: HttpTransport) => transport.post("/resource", { name: "test" }), 1],
        ["multipart POST", (transport: HttpTransport) => transport.postMultipart("/resource", new FormData()), 1],
        ["PATCH", (transport: HttpTransport) => transport.patch("/resource", { name: "test" }), 1],
        ["release PATCH", (transport: HttpTransport) => transport.patchReleaseMutation("/resource", { name: "test" }), 2],
        ["PUT", (transport: HttpTransport) => transport.put("/resource", { name: "test" }), 1],
        ["DELETE", (transport: HttpTransport) => transport.delete("/resource"), 1],
        ["release DELETE", (transport: HttpTransport) => transport.deleteReleaseMutation("/resource"), 2],
    ] as const;

    test.each(unsafeRequests)("does not retry %s after a 5xx response", async (
        _method,
        request,
        expectedTimerCount,
    ) => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls++;
            return Response.json({ error: "temporary" }, { status: 503 });
        }) as unknown as typeof fetch;

        const response = await request(createTransport());

        expect(response.status).toBe(503);
        expect(fetchCalls).toBe(1);
        expect(clearedTimerIds).toHaveLength(expectedTimerCount);
    });

    test.each(unsafeRequests)("does not retry %s after a retryable network error", async (
        _method,
        request,
    ) => {
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

    test("serializes an explicit DELETE request body", async () => {
        let requestBody: BodyInit | null | undefined;
        globalThis.fetch = (async (_url: RequestInfo | URL, options?: RequestInit) => {
            requestBody = options?.body;
            return Response.json({ success: true });
        }) as unknown as typeof fetch;

        const response = await createTransport().delete("/resource", {
            expected_activation_id: "legacy",
        });

        expect(response.ok).toBe(true);
        expect(requestBody).toBe(JSON.stringify({ expected_activation_id: "legacy" }));
    });

    const transportFailureRequests = [
        ["GET", (transport: HttpTransport) => transport.get("/resource")],
        ...unsafeRequests.map(([method, request]) => [method, request] as const),
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

    test.each(redirectCases)(
        "rejects %s redirects without reaching the target",
        async (_caseName, sendRequest, redirectStatus, redirectScope) => {
            let sourceRequests = 0;
            const targetRequests: string[] = [];
            const crossOriginTarget = Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch(request) {
                    targetRequests.push(new URL(request.url).pathname);
                    return Response.json({ ok: true });
                },
            });
            servers.push(crossOriginTarget);
            const source = Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch(request) {
                    sourceRequests += 1;
                    const pathname = new URL(request.url).pathname;
                    if (pathname === "/captured") {
                        targetRequests.push(pathname);
                        return Response.json({ ok: true });
                    }
                    const targetOrigin = redirectScope === "same-origin"
                        ? new URL(request.url).origin
                        : `http://127.0.0.1:${crossOriginTarget.port}`;
                    return Response.redirect(`${targetOrigin}/captured`, redirectStatus);
                },
            });
            servers.push(source);
            const transport = new HttpTransport({
                baseUrl: `http://127.0.0.1:${source.port}`,
                token: "management-token",
            });

            const response = await sendRequest(transport);

            expect(response.transportError).toBe(true);
            expect(response.data).toEqual({ error: "Network Error", code: "NETWORK_ERROR" });
            expect(sourceRequests).toBe(1);
            expect(targetRequests).toEqual([]);
            expect(JSON.stringify(response)).not.toContain("request-secret");
            expect(JSON.stringify(response)).not.toContain("management-token");
        },
    );

    test("preserves the ordinary POST contract for request serialization failures", async () => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            return Response.json({ ok: true });
        }) as unknown as typeof fetch;
        const circularBody: Record<string, unknown> = {};
        circularBody.self = circularBody;

        const response = await createTransport().post("/resource", circularBody);

        expect(response).toEqual({
            ok: false,
            status: 500,
            data: { error: "Network Error", code: "NETWORK_ERROR" },
            transportError: true,
        });
        expect(fetchCalls).toBe(0);
    });

    test.each([0, 36 * 60_000 + 1, 1.5])("rejects invalid bounded POST timeout %s before dispatch", async timeoutMs => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            return Response.json({ ok: true });
        }) as unknown as typeof fetch;

        await expect(createTransport().post("/resource", {}, { timeoutMs })).rejects.toThrow(
            "HTTP request timeout must be between",
        );
        expect(fetchCalls).toBe(0);
    });

    test("uses an explicit ordinary POST header timeout", async () => {
        const scheduledDelays: number[] = [];
        globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
            scheduledDelays.push(delay ?? 0);
            return ++nextTimerId as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout;
        globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;

        const response = await createTransport().post("/resource", {}, { timeoutMs: 120_000 });

        expect(response).toEqual({ ok: true, status: 200, data: { ok: true } });
        expect(scheduledDelays).toEqual([120_000]);
    });
});

describe("HttpTransport bounded GET responses", () => {
    test.each([
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        Number.POSITIVE_INFINITY,
        Number.NaN,
    ])("rejects invalid response limit %s before dispatch", async maxResponseBytes => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            return Response.json({ ok: true });
        }) as unknown as typeof fetch;

        await expect(createTransport().get("/resource", { maxResponseBytes })).rejects.toThrow(
            "HTTP response limit must be a positive safe integer",
        );

        expect(fetchCalls).toBe(0);
    });

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

    test("times out an explicitly bounded GET body after headers", async () => {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        const secretSentinel = "private-stalled-get-response";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(`{\"token\":\"${secretSentinel}`));
                },
            }), { headers: { "Content-Type": "application/json" } }),
        });
        servers.push(server);
        const transport = new HttpTransport({
            baseUrl: `http://127.0.0.1:${server.port}`,
            token: "test-token",
        });
        const startedAt = Date.now();

        const response = await transport.get("/resource", {
            maxJsonBytes: 64 * 1024,
            responseTimeoutMs: 10,
        });

        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(response).toMatchObject({ ok: false, status: 200, responseReadError: true });
        expect(JSON.stringify(response)).not.toContain(secretSentinel);
    });
});

describe("HttpTransport release mutation response boundary", () => {
    test("keeps a long release header timeout separate from the body deadline", async () => {
        const scheduledDelays: number[] = [];
        globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
            scheduledDelays.push(delay ?? 0);
            return ++nextTimerId as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout;
        globalThis.fetch = (async () => Response.json({ success: true })) as unknown as typeof fetch;

        const response = await createTransport().postReleaseMutation("/resource", {}, {
            timeoutMs: 36 * 60_000,
        });

        expect(response).toEqual({ ok: true, status: 200, data: { success: true } });
        expect(scheduledDelays).toEqual([36 * 60_000, 5_000]);
    });

    test("bounds an explicitly selected POST JSON response", async () => {
        const secretSentinel = "private-bounded-post-response";
        const body = JSON.stringify({ token: secretSentinel.repeat(64) });
        globalThis.fetch = (async () => chunkedTextResponse(body, {}, 1024)) as unknown as typeof fetch;

        const response = await createTransport().post("/resource", {}, { maxJsonBytes: 64 });

        expect(response).toMatchObject({ ok: false, status: 200, responseReadError: true });
        expect(JSON.stringify(response)).not.toContain(secretSentinel);
    });

    test.each([
        ["POST", (transport: HttpTransport) => transport.postReleaseMutation("/resource", { expected: "1" })],
        ["PATCH", (transport: HttpTransport) => transport.patchReleaseMutation("/resource", { expected: "1" })],
        ["DELETE", (transport: HttpTransport) => transport.deleteReleaseMutation("/resource", { expected: "1" })],
    ] as const)("bounds and redacts an oversized %s mutation response", async (method, request) => {
        const secretSentinel = `service-role-${method.toLowerCase()}-response-secret`;
        const structuredBody = JSON.stringify({ token: secretSentinel });
        const body = `${" ".repeat(RELEASE_MUTATION_RESPONSE_MAX_BYTES + 1 - structuredBody.length)}${structuredBody}`;
        let observedMethod: string | undefined;
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            observedMethod = init?.method;
            return chunkedTextResponse(body, {}, 1024);
        }) as unknown as typeof fetch;

        const response = await request(createTransport());

        expect(observedMethod).toBe(method);
        expect(response).toMatchObject({ ok: false, status: 200, responseReadError: true });
        expect(JSON.stringify(response)).not.toContain(secretSentinel);
    });

    test("rejects an unserializable request before HTTP dispatch", async () => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            return Response.json({ ok: true });
        }) as unknown as typeof fetch;
        const circularBody: Record<string, unknown> = {};
        circularBody.self = circularBody;

        await expect(createTransport().postReleaseMutation("/resource", circularBody)).rejects.toThrow();

        expect(fetchCalls).toBe(0);
    });

    test("accepts a chunked JSON response exactly at the byte cap", async () => {
        const body = whitespaceJson(RELEASE_MUTATION_RESPONSE_MAX_BYTES);
        globalThis.fetch = (async () => chunkedTextResponse(
            body,
            { "Content-Type": "application/json" },
            1024,
        )) as unknown as typeof fetch;

        const response = await createTransport().postReleaseMutation("/resource", { expected: "1" });

        expect(Buffer.byteLength(body)).toBe(RELEASE_MUTATION_RESPONSE_MAX_BYTES);
        expect(response).toEqual({ ok: true, status: 200, data: [] });
    });

    test.each([
        ["without Content-Length", {}],
        ["with a false small Content-Length", { "Content-Length": "1" }],
    ])("rejects a chunked response one byte over the cap %s", async (_label, headers) => {
        const secretSentinel = "Bearer service-role-response-secret";
        const structuredBody = JSON.stringify({ token: secretSentinel });
        const body = `${" ".repeat(RELEASE_MUTATION_RESPONSE_MAX_BYTES + 1 - structuredBody.length)}${structuredBody}`;
        globalThis.fetch = (async () => chunkedTextResponse(body, headers, 1024)) as unknown as typeof fetch;

        const response = await createTransport().postReleaseMutation("/resource", { expected: "1" });
        const serialized = JSON.stringify(response);

        expect(Buffer.byteLength(body)).toBe(RELEASE_MUTATION_RESPONSE_MAX_BYTES + 1);
        expect(response).toEqual({
            ok: false,
            status: 200,
            data: { error: "Response body unavailable", code: "RESPONSE_READ_ERROR" },
            responseReadError: true,
        });
        expect(serialized).not.toContain(secretSentinel);
    });

    test("rejects a response truncated below its declared Content-Length", async () => {
        const secretSentinel = "service-role-truncated-response-secret";
        const body = JSON.stringify({ token: secretSentinel });
        globalThis.fetch = (async () => chunkedTextResponse(body, {
            "Content-Length": String(Buffer.byteLength(body) + 10),
            "Content-Type": "application/json",
        }, 7)) as unknown as typeof fetch;

        const response = await createTransport().postReleaseMutation("/resource", { expected: "1" });

        expect(response.responseReadError).toBe(true);
        expect(JSON.stringify(response)).not.toContain(secretSentinel);
    });

    test("rejects a chunked JSON response that ends mid-document", async () => {
        const secretSentinel = "service-role-mid-document-secret";
        const body = `{"token":"${secretSentinel}`;
        globalThis.fetch = (async () => chunkedTextResponse(body, {}, 5)) as unknown as typeof fetch;

        const response = await createTransport().postReleaseMutation("/resource", { expected: "1" });

        expect(response.responseReadError).toBe(true);
        expect(JSON.stringify(response)).not.toContain(secretSentinel);
    });

    test("redacts a secret-like body and reader exception", async () => {
        const secretSentinel = "Bearer reader-failure-service-role-secret";
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(`{"token":"${secretSentinel}`));
                controller.error(new Error(secretSentinel));
            },
        });
        globalThis.fetch = (async () => new Response(stream, {
            headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;

        const response = await createTransport().postReleaseMutation("/resource", { expected: "1" });

        expect(response.responseReadError).toBe(true);
        expect(JSON.stringify(response)).not.toContain(secretSentinel);
    });

    test("times out a real response stream that stalls after headers", async () => {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        const secretSentinel = "Bearer delayed-service-role-secret";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(`{"token":"${secretSentinel}`));
                },
            }), { headers: { "Content-Type": "application/json" } }),
        });
        servers.push(server);
        const transport = new HttpTransport({
            baseUrl: `http://127.0.0.1:${server.port}`,
            token: "test-token",
        });
        const startedAt = Date.now();

        const response = await transport.postReleaseMutation("/resource", { expected: "1" });

        expect(Date.now() - startedAt).toBeLessThan(15_000);
        expect(response).toMatchObject({ ok: false, status: 200, responseReadError: true });
        expect(JSON.stringify(response)).not.toContain(secretSentinel);
    }, 20_000);

    test.each([400, 409])("preserves a normal structured HTTP %d response", async status => {
        const responseBody = { error: "ACTIVE_VERSION_CONFLICT", current_active_version: "8" };
        globalThis.fetch = (async () => Response.json(responseBody, { status })) as unknown as typeof fetch;

        const response = await createTransport().postReleaseMutation("/resource", { expected: "7" });

        expect(response).toEqual({ ok: false, status, data: responseBody });
    });
});
