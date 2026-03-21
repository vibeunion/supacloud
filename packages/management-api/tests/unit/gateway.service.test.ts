import { describe, test, expect, mock } from "bun:test";
import { gatewayService } from "../../src/services/gateway.service";

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

    test("setCors should return true", async () => {
        const originalFetch = globalThis.fetch;
        mockFetch(() => Promise.resolve(new Response(JSON.stringify({ data: [] }))));

        const result = await gatewayService.setCors("testref123", "*");
        expect(result).toBe(true);

        globalThis.fetch = originalFetch;
    });
});
