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
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

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

const redirectedRequests = [
    ["GET", (transport: HttpTransport) => transport.get("/resource")],
    ["JSON POST", (transport: HttpTransport) => transport.post("/resource", { secret: "request-secret" })],
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

    test.each([0, 36 * 60_000 + 1, 1.5])("rejects invalid POST timeout %d before dispatch", async timeoutMs => {
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

    test.each([0, 36 * 60_000 + 1, 1.5])(
        "rejects invalid POST response timeout %d before dispatch",
        async responseTimeoutMs => {
            let fetchCalls = 0;
            globalThis.fetch = (async () => {
                fetchCalls++;
                return Response.json({ ok: true });
            }) as unknown as typeof fetch;

            await expect(createTransport().post("/resource", {}, {
                maxJsonBytes: 1024,
                responseTimeoutMs,
            })).rejects.toThrow("HTTP response timeout must be between");
            expect(fetchCalls).toBe(0);
        },
    );

    test("bounds selected GET response bodies before JSON projection", async () => {
        const remoteSecret = "oversized-get-response-sentinel";
        globalThis.fetch = (async () => new Response(JSON.stringify({
            config: { private_value: remoteSecret.repeat(100) },
        }), { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

        const response = await createTransport().get("/v1/projects/project-ref", {
            maxResponseBytes: 128,
        });

        expect(response).toEqual({ ok: true, status: 200, data: null });
        expect(JSON.stringify(response)).not.toContain(remoteSecret);
    });

    test("parses a selected GET response within its byte limit", async () => {
        globalThis.fetch = (async () => Response.json({ ref: "project-ref" })) as unknown as typeof fetch;

        const response = await createTransport().get("/v1/projects/project-ref", {
            maxResponseBytes: 1_024,
        });

        expect(response).toEqual({ ok: true, status: 200, data: { ref: "project-ref" } });
    });

    test.each([0, -1, 1.5])("rejects invalid GET response limit %d before dispatch", async maxResponseBytes => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls++;
            return Response.json({});
        }) as unknown as typeof fetch;

        await expect(createTransport().get("/v1/projects", { maxResponseBytes })).rejects.toThrow(
            "HTTP response limit must be a positive safe integer",
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

describe("HttpTransport bounded JSON responses", () => {
    const maxJsonBytes = 64 * 1024;

    function jsonBodyWithByteLength(byteLength: number): Uint8Array {
        const prefix = '{"payload":"';
        const suffix = '"}';
        return new TextEncoder().encode(
            `${prefix}${"x".repeat(byteLength - prefix.length - suffix.length)}${suffix}`,
        );
    }

    test("accepts a strict JSON response exactly at the byte limit", async () => {
        const body = jsonBodyWithByteLength(maxJsonBytes);
        globalThis.fetch = (async () => new Response(Buffer.from(body))) as unknown as typeof fetch;

        const response = await createTransport().get<{ payload: string }>(
            "/v1/projects/project-ref/runtime-snapshot",
            { maxJsonBytes },
        );

        expect(response.ok).toBe(true);
        expect(response.data.payload.length).toBeGreaterThan(64_000);
    });

    test("bounds long-running POST success responses without changing the request timeout", async () => {
        const body = jsonBodyWithByteLength(maxJsonBytes);
        globalThis.fetch = (async () => new Response(Buffer.from(body))) as unknown as typeof fetch;

        const response = await createTransport().post<{ payload: string }>(
            "/v1/projects/project-ref/database/backups/logical",
            {},
            { timeoutMs: 36 * 60_000, maxJsonBytes },
        );

        expect(response.ok).toBe(true);
        expect(response.data.payload.length).toBeGreaterThan(64_000);
        expect(scheduledTimers.at(-1)?.delay).toBe(36 * 60_000);
    });

    test("rejects a declared response larger than the byte limit", async () => {
        globalThis.fetch = (async () => new Response("{}", {
            headers: { "content-length": String(maxJsonBytes + 1) },
        })) as unknown as typeof fetch;

        const response = await createTransport().get("/runtime-snapshot", { maxJsonBytes });

        expect(response).toEqual({
            ok: false,
            status: 200,
            data: { error: "Invalid Response", code: "INVALID_RESPONSE" },
            responseError: true,
        });
    });

    test("rejects a chunked response after it crosses the byte limit", async () => {
        const oversizedBody = jsonBodyWithByteLength(maxJsonBytes + 1);
        globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(oversizedBody.slice(0, maxJsonBytes));
                controller.enqueue(oversizedBody.slice(maxJsonBytes));
                controller.close();
            },
        }))) as unknown as typeof fetch;

        const response = await createTransport().get("/runtime-snapshot", { maxJsonBytes });

        expect(response.responseError).toBe(true);
        expect(JSON.stringify(response)).not.toContain("x".repeat(128));
    });

    test("marks an oversized POST response invalid without reflecting it", async () => {
        const oversizedBody = jsonBodyWithByteLength(maxJsonBytes + 1);
        globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(oversizedBody);
                controller.close();
            },
        }))) as unknown as typeof fetch;

        const response = await createTransport().post(
            "/v1/projects/project-ref/database/backups/logical",
            {},
            { timeoutMs: 36 * 60_000, maxJsonBytes },
        );

        expect(response.responseError).toBe(true);
        expect(JSON.stringify(response)).not.toContain("x".repeat(128));
    });

    test("rejects malformed UTF-8 and malformed JSON without reflection", async () => {
        const privateMarker = "private-response-marker";
        const invalidBodies = [
            new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
            new TextEncoder().encode(`{"marker":"${privateMarker}"`),
        ];

        for (const body of invalidBodies) {
            globalThis.fetch = (async () => new Response(Buffer.from(body))) as unknown as typeof fetch;
            const response = await createTransport().get("/runtime-snapshot", { maxJsonBytes });

            expect(response.responseError).toBe(true);
            expect(JSON.stringify(response)).not.toContain(privateMarker);
        }
    });

    test("rejects oversized and malformed bounded JSON POST responses without reflection", async () => {
        const privateMarker = "private-post-response-marker";
        const bodies = [
            new TextEncoder().encode(JSON.stringify({ marker: privateMarker.repeat(maxJsonBytes) })),
            new TextEncoder().encode(`{"marker":"${privateMarker}"`),
        ];

        for (const body of bodies) {
            globalThis.fetch = (async () => new Response(Buffer.from(body))) as unknown as typeof fetch;
            const response = await createTransport().post("/frontend/activate", {}, { maxJsonBytes });

            expect(response.responseError).toBe(true);
            expect(JSON.stringify(response)).not.toContain(privateMarker);
        }
    });

    test.each([0, -1, 1.5])("rejects invalid JSON byte limit %d before dispatch", async maxBytes => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            return Response.json({});
        }) as unknown as typeof fetch;

        await expect(createTransport().get("/runtime-snapshot", { maxJsonBytes: maxBytes }))
            .rejects.toThrow("positive safe integer");
        await expect(createTransport().post("/resource", {}, { timeoutMs: 1, maxJsonBytes: maxBytes }))
            .rejects.toThrow("positive safe integer");
        expect(fetchCalls).toBe(0);
    });
});

describe("HttpTransport raw binary mutations", () => {
    function binaryBody(bytes: number[]) {
        const body = new Uint8Array(bytes);
        return {
            byteLength: body.byteLength,
            stream: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(body);
                    controller.close();
                },
            }),
        };
    }

    test("sends an exact ZIP body and returns only a bounded JSON response", async () => {
        const captured = { headers: new Headers(), body: [] as number[] };
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            captured.headers = request.headers;
            captured.body = [...new Uint8Array(await request.arrayBuffer())];
            return Response.json({ ok: true });
        }) as unknown as typeof fetch;

        const response = await createTransport().postBinary(
            "/frontend/releases",
            binaryBody([1, 2, 3]),
            {
                contentType: "application/zip",
                contentLength: 3,
                contentSha256: "a".repeat(64),
                maxJsonBytes: 1024,
            },
        );

        expect(response).toEqual({ ok: true, status: 200, data: { ok: true } });
        expect(captured.headers.get("content-type")).toBe("application/zip");
        expect(captured.headers.get("content-length")).toBe("3");
        expect(captured.headers.get("x-supacloud-content-sha256")).toBe("a".repeat(64));
        expect(captured.body).toEqual([1, 2, 3]);
    });

    test("rejects invalid binary metadata before dispatch", async () => {
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            return Response.json({});
        }) as unknown as typeof fetch;
        const transport = createTransport();
        await expect(transport.postBinary("/frontend/releases", binaryBody([1]), {
            contentType: "application/json",
            contentLength: 1,
            contentSha256: "a".repeat(64),
            maxJsonBytes: 1024,
        })).rejects.toThrow("content type");
        await expect(transport.postBinary("/frontend/releases", binaryBody([1]), {
            contentType: "application/zip",
            contentLength: 2,
            contentSha256: "a".repeat(64),
            maxJsonBytes: 1024,
        })).rejects.toThrow("length");
        expect(fetchCalls).toBe(0);
    });

    test("rejects an oversized binary response without reflecting its body", async () => {
        const privateMarker = "private-binary-response";
        globalThis.fetch = (async () => new Response(JSON.stringify({ privateMarker }), {
            status: 201,
            headers: { "content-length": "2048" },
        })) as unknown as typeof fetch;
        const response = await createTransport().postBinary("/frontend/releases", binaryBody([1]), {
            contentType: "application/zip",
            contentLength: 1,
            contentSha256: "a".repeat(64),
            maxJsonBytes: 1024,
        });
        expect(response.responseError).toBe(true);
        expect(JSON.stringify(response)).not.toContain(privateMarker);
    });

    test.each([
        ["JSON activation", (transport: HttpTransport) => transport.post("/frontend/activate", {}, {
            maxJsonBytes: 1024,
            responseTimeoutMs: 10,
        })],
        ["ZIP upload", (transport: HttpTransport) => transport.postBinary(
            "/frontend/releases",
            binaryBody([1]),
            {
                contentType: "application/zip",
                contentLength: 1,
                contentSha256: "a".repeat(64),
                maxJsonBytes: 1024,
                responseTimeoutMs: 10,
            },
        )],
    ] as const)("ends a stalled %s response body as invalid", async (_label, request) => {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"committed":true'));
            },
        }), { status: 200 })) as unknown as typeof fetch;

        const startedAt = Date.now();
        const response = await request(createTransport());

        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(response.responseError).toBe(true);
    });
});
