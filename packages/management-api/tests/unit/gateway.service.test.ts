import { describe, test, expect, mock, spyOn } from "bun:test";
import { gatewayService } from "../../src/services/gateway.service";

describe("GatewayService", () => {
    test("applyConfig should combine multiple calls", async () => {
        // Mock fetch to simulate Kong Admin API
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ data: [] })))) as any;

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
        globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ data: [] })))) as any;

        const result = await gatewayService.setRateLimit("testref123", "pro");
        expect(result).toBe(true);

        globalThis.fetch = originalFetch;
    });

    test("setCors should return true", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ data: [] })))) as any;

        const result = await gatewayService.setCors("testref123", "*");
        expect(result).toBe(true);

        globalThis.fetch = originalFetch;
    });
});
