import { expect, test, describe } from "bun:test";
import { jwtService } from "../services/jwt.service";

describe("JwtService 单元测试", () => {
    test("应该能生成指定长度的 Secret", () => {
        const secret = jwtService.generateSecret();
        expect(secret.length).toBe(40);
    });

    test("应该能生成符合格式要求的 ProjectRef", () => {
        const ref = jwtService.generateProjectRef();
        expect(ref.length).toBe(10);
        expect(ref).toBe(ref.toLowerCase());
    });

    test("生成的 JWT 应该具有正确的三段式结构", async () => {
        const secret = "test-secret-at-least-32-chars-long-123456";
        const token = await jwtService.generateAnonKey(secret);
        const parts = token.split(".");
        expect(parts.length).toBe(3);

        // 验证 Header
        const header = JSON.parse(atob(parts[0]));
        expect(header.alg).toBe("HS256");
        expect(header.typ).toBe("JWT");

        // 验证 Payload 角色
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        expect(payload.role).toBe("anon");
        expect(payload.iss).toBe("supabase");
    });

    test("generateKeySet 应该返回完整的凭据集", async () => {
        const keys = await jwtService.generateKeySet();
        expect(keys.jwtSecret.length).toBe(40);
        expect(keys.anonKey.split(".").length).toBe(3);
        expect(keys.serviceRoleKey.split(".").length).toBe(3);
    });
});
