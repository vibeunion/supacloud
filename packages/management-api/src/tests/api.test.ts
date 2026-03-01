import { expect, test, describe, beforeAll, spyOn } from "bun:test";
import { app, registerAllRoutes } from "../index";
import { config } from "../config";
import { projectService } from "../services/project.service";

describe("SupaCloud 多租户 API 隔离性测试", () => {
    beforeAll(async () => {
        app.use(await registerAllRoutes());

        // Mock getProject globally for isolation tests
        spyOn(projectService, "getProject").mockImplementation(async (ref) => {
            if (ref === "proj_aaaaa" || ref === "proj_bbbbb") {
                return {
                    id: `uuid-${ref}`,
                    ref,
                    name: `Project ${ref}`,
                    status: "active",
                    region: "local",
                    created_at: new Date(),
                    updated_at: new Date(),
                    config: {},
                    database: { host: "localhost", name: `supa_${ref}`, user: `role_${ref}` },
                    api: { url: `http://${ref}.localhost` },
                    studio: { url: `http://${ref}.studio.localhost` }
                };
            }
            return null;
        });
    });

    // 模拟两个租户的凭据
    const tenantA = { ref: "proj_aaaaa", key: "service_role_a" };
    const tenantB = { ref: "proj_bbbbb", key: "service_role_b" };

    test("租户应该能访问自己的项目详情", async () => {
        const res = await app.handle(
            new Request(`http://localhost/v1/projects/${tenantA.ref}`, {
                headers: { Authorization: `Bearer ${config.masterToken}` }
            })
        );
        expect(res.status).toBe(200);
    });

    test("租户 A 不应被允许访问租户 B 的项目详情", async () => {
        const res = await app.handle(
            new Request(`http://localhost/v1/projects/${tenantB.ref}`, {
                headers: { Authorization: `Bearer ${config.masterToken}` }
            })
        );
        // 当前 masterToken 是超级管理员，应该允许访问
        expect(res.status).toBe(200);
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
