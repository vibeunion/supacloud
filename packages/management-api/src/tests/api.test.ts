import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { app } from "../index";

describe("SupaCloud 多租户 API 隔离性测试", () => {
    // 模拟两个租户的凭据
    const tenantA = { ref: "proj_aaaaa", key: "service_role_a" };
    const tenantB = { ref: "proj_bbbbb", key: "service_role_b" };

    test("租户应该能访问自己的项目详情", async () => {
        // 注：由于测试环境没有真实数据库，这里可能会返回 404 或 500
        // 我们主要验证认证逻辑是否被透传，以及隔离逻辑是否触发
        const res = await app.handle(
            new Request(`http://localhost/v1/projects/${tenantA.ref}`, {
                headers: { Authorization: `Bearer ${tenantA.key}` }
            })
        );

        // 如果认证失败会是 401，我们预期是进入业务逻辑 (即便最后因为无 DB 报错)
        expect(res.status).not.toBe(401);
    });

    test("租户 A 不应被允许访问租户 B 的项目详情", async () => {
        const res = await app.handle(
            new Request(`http://localhost/v1/projects/${tenantB.ref}`, {
                headers: { Authorization: `Bearer ${tenantA.key}` }
            })
        );

        // 核心安全红线：纵向越权验证
        // 预期返回 403 Forbidden 或业务逻辑层面的拒绝
        expect(res.status).toBe(403);
    });

    test("未通过认证的项目创建请求应该被拒绝", async () => {
        const res = await app.handle(
            new Request("http://localhost/v1/projects", {
                method: "POST",
                body: JSON.stringify({ name: "Hacker Project" }),
                headers: { "Content-Type": "application/json" }
            })
        );
        expect(res.status).toBe(401);
    });
});
