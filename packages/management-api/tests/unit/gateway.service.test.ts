import { describe, test, expect, mock } from "bun:test";
import { DEFAULT_CORS_HEADERS, gatewayService } from "../../src/services/gateway.service";

/** Type-safe mock for globalThis.fetch using two-step cast */
function mockFetch(handler: () => Promise<Response>): void {
    globalThis.fetch = mock(handler) as unknown as typeof fetch;
}

describe("GatewayService", () => {
    test("applyConfig should combine multiple calls", async () => {
        const originalFetch = globalThis.fetch;
        mockFetch(() => Promise.resolve(new Response(JSON.stringify({ data: [] }))));

        const result = await gatewayService.applyConfig("testref123", {
            rateLimitTier: 'enterprise',
            jwtEnabled: true
        });

        expect(result.success).toBe(true);
        expect(result.message).toBe("Gateway configuration updated");

        globalThis.fetch = originalFetch;
    });

    test("setRateLimit should return true", async () => {
        const originalFetch = globalThis.fetch;
        mockFetch(() => Promise.resolve(new Response(JSON.stringify({ data: [] }))));

        const result = await gatewayService.setRateLimit("testref123", "pro");
        expect(result).toBe(true);

        globalThis.fetch = originalFetch;
    });

    test("setCors should return true and map across multiple routes", async () => {
        const originalFetch = globalThis.fetch;
        const calls: string[] = [];
        globalThis.fetch = mock((input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            calls.push(url);
            return Promise.resolve(new Response(JSON.stringify({ data: [] })));
        }) as unknown as typeof fetch;

        const result = await gatewayService.setCors("testref123");
        expect(result).toBe(true);

        const patchedRoutes = calls.filter(c => c.includes("route-svc-pgrst-") || c.includes("route-svc-gotrue-") || c.includes("route-svc-realtime-") || c.includes("route-svc-storage-") || c.includes("route-svc-functions-"));
        expect(patchedRoutes.length).toBeGreaterThan(0);

        globalThis.fetch = originalFetch;
    });

    test("default cors headers allow SupaCloud browser invocation headers", () => {
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-async");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-retries");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-timeout");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-idempotency-key");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-function-version");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-trace-id");
    });

    test("setupUpstream should configure realtime route through management websocket proxy", async () => {
        const originalFetch = globalThis.fetch;
        const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string"
                ? input
                : input instanceof URL
                    ? input.toString()
                    : input.url;
            const method = init?.method || "GET";
            let body: Record<string, unknown> | null = null;
            if (typeof init?.body === "string" && init.body.length > 0) {
                try {
                    body = JSON.parse(init.body) as Record<string, unknown>;
                } catch {
                    body = null;
                }
            }
            calls.push({ url, method, body });
            return Promise.resolve(new Response(JSON.stringify({ data: [] })));
        }) as unknown as typeof fetch;

        const result = await gatewayService.setupUpstream("testref123", 3000, 9999);
        expect(result.success).toBe(true);

        const realtimeService = calls.find(
            (c) => c.method === "PUT" && c.url.includes("/services/svc-realtime-testref123")
        );
        expect(realtimeService).toBeDefined();
        expect(realtimeService?.body?.url).toMatch(/http:\/\/.*:(8080|9090)$/);

        const realtimeRoute = calls.find(
            (c) => c.method === "PUT" && c.url.includes("/routes/route-svc-realtime-testref123")
        );
        expect(realtimeRoute).toBeDefined();
        expect(realtimeRoute?.body?.paths).toEqual(["/realtime/v1/websocket"]);
        expect(realtimeRoute?.body?.protocols).toEqual(["http", "https"]);
        expect(realtimeRoute?.body?.strip_path).toBe(false);

        globalThis.fetch = originalFetch;
    });

    test("setupUpstream should preserve /functions/v1 prefix for management sdk-proxy", async () => {
        const originalFetch = globalThis.fetch;
        const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string"
                ? input
                : input instanceof URL
                    ? input.toString()
                    : input.url;
            const method = init?.method || "GET";
            let body: Record<string, unknown> | null = null;
            if (typeof init?.body === "string" && init.body.length > 0) {
                try {
                    body = JSON.parse(init.body) as Record<string, unknown>;
                } catch {
                    body = null;
                }
            }
            calls.push({ url, method, body });
            return Promise.resolve(new Response(JSON.stringify({ data: [] })));
        }) as unknown as typeof fetch;

        const result = await gatewayService.setupUpstream("testref123", 3000, 9999);
        expect(result.success).toBe(true);

        const functionsRoute = calls.find(
            (c) => c.method === "PUT" && c.url.includes("/routes/route-svc-functions-testref123")
        );
        expect(functionsRoute).toBeDefined();
        expect(functionsRoute?.body?.paths).toEqual(["/functions/v1"]);
        expect(functionsRoute?.body?.strip_path).toBe(false);

        globalThis.fetch = originalFetch;
    });

    test("setupUpstream should disable buffering on storage routes", async () => {
        const originalFetch = globalThis.fetch;
        const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string"
                ? input
                : input instanceof URL
                    ? input.toString()
                    : input.url;
            const method = init?.method || "GET";
            let body: Record<string, unknown> | null = null;
            if (typeof init?.body === "string" && init.body.length > 0) {
                try {
                    body = JSON.parse(init.body) as Record<string, unknown>;
                } catch {
                    body = null;
                }
            }
            calls.push({ url, method, body });
            return Promise.resolve(new Response(JSON.stringify({ data: [] })));
        }) as unknown as typeof fetch;

        const result = await gatewayService.setupUpstream("testref123", 3000, 9999);
        expect(result.success).toBe(true);

        const storageRoute = calls.find(
            (c) => c.method === "PUT" && c.url.includes("/routes/route-svc-storage-testref123")
        );
        expect(storageRoute).toBeDefined();
        expect(storageRoute?.body?.paths).toEqual(["/storage/v1/"]);
        expect(storageRoute?.body?.request_buffering).toBe(false);
        expect(storageRoute?.body?.response_buffering).toBe(false);

        globalThis.fetch = originalFetch;
    });

    test("setupUpstream should reserve API root paths for ACME-safe host routing", async () => {
        const originalFetch = globalThis.fetch;
        const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string"
                ? input
                : input instanceof URL
                    ? input.toString()
                    : input.url;
            const method = init?.method || "GET";
            let body: Record<string, unknown> | null = null;
            if (typeof init?.body === "string" && init.body.length > 0) {
                try {
                    body = JSON.parse(init.body) as Record<string, unknown>;
                } catch {
                    body = null;
                }
            }
            calls.push({ url, method, body });
            return Promise.resolve(new Response(JSON.stringify({ data: [] })));
        }) as unknown as typeof fetch;

        const result = await gatewayService.setupUpstream("testref123", 3000, 9999);
        expect(result.success).toBe(true);

        const apiRootRoute = calls.find(
            (c) => c.method === "PUT" && c.url.includes("/routes/route-svc-api-root-testref123")
        );
        expect(apiRootRoute).toBeDefined();
        expect(apiRootRoute?.body?.paths).toEqual(["/.well-known/acme-challenge"]);
        expect(apiRootRoute?.body?.strip_path).toBe(false);
        expect(apiRootRoute?.body?.hosts).toContain("testref123.api.example.com");

        const studioTransformer = calls.find(
            (c) => c.method === "POST"
                && c.url.includes("/routes/route-svc-studio-testref123/plugins")
                && c.body?.name === "request-transformer"
        );
        expect(studioTransformer).toBeDefined();
        expect(((studioTransformer?.body?.config as Record<string, unknown>)?.add as Record<string, unknown>)?.headers).toContain("x-supacloud-ui-host:studio");

        globalThis.fetch = originalFetch;
    });
});
