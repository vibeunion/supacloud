import { expect, test, describe, spyOn } from "bun:test";
import { GatewayService } from "../services/gateway.service";
import { shellService } from "../services/shell.service";

describe("GatewayService 集成 Mock 测试", () => {
    test("applyConfig 应该能正确编排多个网关原子操作", async () => {
        // 创建 Spy 以拦截 Shell 调用
        const shellSpy = spyOn(shellService, "execute").mockImplementation(async (script, args) => {
            return { success: true, stdout: "mocked success", output: "mocked success" };
        });

        const projectRef = "test-ref-123";
        const config = {
            rateLimitTier: 'pro' as const,
            corsOrigins: '*',
            jwtEnabled: true,
            jwtSecret: 'super-secret-key'
        };

        const result = await GatewayService.applyConfig(projectRef, config);

        expect(result.success).toBe(true);

        // 验证调用的脚本和参数
        expect(shellSpy).toHaveBeenCalledWith('gateway_manager.sh', ['setup-project', projectRef, config.jwtSecret]);
        expect(shellSpy).toHaveBeenCalledWith('gateway_manager.sh', ['set-rate-limit', projectRef, config.rateLimitTier]);
        expect(shellSpy).toHaveBeenCalledWith('gateway_manager.sh', ['set-cors', projectRef, config.corsOrigins]);
        expect(shellSpy).toHaveBeenCalledWith('gateway_manager.sh', ['enable-jwt', projectRef]);

        shellSpy.mockRestore();
    });

    test("当底层脚本报错时，Service 应该能正确感应并记录错误", async () => {
        const shellSpy = spyOn(shellService, "execute").mockImplementation(async () => {
            return { success: false, output: "", error: "critical shell error" };
        });

        const success = await GatewayService.setRateLimit("ref", "free");
        expect(success).toBe(false);

        shellSpy.mockRestore();
    });
});
