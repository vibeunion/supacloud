import { describe, test, expect, spyOn } from "bun:test";
import { GatewayService } from "../../src/services/gateway.service";
import { shellService } from "../../src/services/shell.service";

describe("GatewayService", () => {
    test("setRateLimit should call gateway_manager.sh with pro tier", async () => {
        const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });

        const result = await GatewayService.setRateLimit("test-ref", "pro");
        expect(result).toBe(true);
        expect(spy).toHaveBeenCalledWith("gateway_manager.sh", ["set-rate-limit", "test-ref", "pro"]);

        spy.mockRestore();
    });

    test("setCors should call gateway_manager.sh with origins", async () => {
        const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });

        const result = await GatewayService.setCors("test-ref", "https://example.com");
        expect(result).toBe(true);
        expect(spy).toHaveBeenCalledWith("gateway_manager.sh", ["set-cors", "test-ref", "https://example.com"]);

        spy.mockRestore();
    });

    test("applyConfig should combine multiple calls", async () => {
        const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });

        const result = await GatewayService.applyConfig("test-ref", {
            rateLimitTier: 'enterprise',
            jwtEnabled: true
        });

        expect(result.success).toBe(true);
        expect(spy).toHaveBeenCalledTimes(2); // set-rate-limit and enable-jwt

        spy.mockRestore();
    });
});
