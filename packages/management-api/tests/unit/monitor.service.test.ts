import { describe, test, expect, mock, spyOn, afterEach } from "bun:test";
import { MonitorService } from "../../src/services/monitor.service";

// Mock fetch globally for Bun
const mockFetch = mock((url: string) => {
    if (url.endsWith('/health')) {
        return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ status: 'ok', role: 'primary' })
        });
    }
    if (url.includes('/api/v1/query')) {
        return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
                data: {
                    result: [{ value: [0, "42.5"] }]
                }
            })
        });
    }
    return Promise.reject(new Error("Unknown URL"));
});

// Since Bun 1.1+, fetch can be mocked easily or we can replace globalThis.fetch
const originalFetch = globalThis.fetch;

describe("MonitorService", () => {
    test("getHealth should return formatted status", async () => {
        globalThis.fetch = mockFetch as any;

        const status = await MonitorService.getHealth("1.2.3.4");

        expect(status.status).toBe("up");
        expect(status.role).toBe("primary");
        expect(status.node).toBe("1.2.3.4");

        globalThis.fetch = originalFetch;
    });

    test("getMetrics should aggregate and parse VM results", async () => {
        globalThis.fetch = mockFetch as any;

        const metrics = await MonitorService.getMetrics("1.2.3.4");

        expect(metrics.qps).toBe(42.5);
        expect(metrics.active_connections).toBe(42.5);
        expect(metrics.slow_queries).toBe(42.5);

        globalThis.fetch = originalFetch;
    });

    test("getHealth should handle errors gracefully", async () => {
        globalThis.fetch = mock(() => Promise.reject(new Error("Network Error"))) as any;

        const status = await MonitorService.getHealth("1.2.3.4");
        expect(status.status).toBe("unreachable");

        globalThis.fetch = originalFetch;
    });
});
