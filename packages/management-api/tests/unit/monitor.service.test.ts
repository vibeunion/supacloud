import { describe, test, expect, mock, afterEach } from "bun:test";
import * as MonitorService from "../../src/services/monitor.service";

/** Type-safe mock for globalThis.fetch */
function mockFetch(handler: (url: string) => Promise<Partial<Response>>): void {
    globalThis.fetch = mock(handler) as unknown as typeof fetch;
}

describe("MonitorService", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test("getHealth should return formatted status", async () => {
        mockFetch((url: string) => {
            if (url.endsWith('/health')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ status: 'ok', role: 'primary' })
                });
            }
            return Promise.reject(new Error("Unknown URL"));
        });

        const status = await MonitorService.getHealth("1.2.3.4");

        expect(status.status).toBe("up");
        expect(status.role).toBe("primary");
        expect(status.node).toBe("1.2.3.4");
    });

    test("getMetrics should aggregate and parse VM results", async () => {
        mockFetch((url: string) => {
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

        const metrics = await MonitorService.getMetrics("1.2.3.4");

        expect(metrics.qps).toBe(42.5);
        expect(metrics.active_connections).toBe(42.5);
        expect(metrics.slow_queries).toBe(42.5);
        expect(metrics.cpu_usage).toBe(42.5);
        expect(metrics.mem_usage).toBe(42.5);
    });

    test("getHealth should handle errors gracefully", async () => {
        mockFetch(() => Promise.reject(new Error("Network Error")));

        const status = await MonitorService.getHealth("1.2.3.4");
        expect(status.status).toBe("unreachable");
    });
});
