import { describe, it, expect } from "bun:test";
import { app } from "../src/index";

describe("Management API Integration Tests", () => {
    const baseUrl = "http://localhost";
    const masterToken = "dev-master-token";

    describe("Organizations", () => {
        it("should list organizations", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/organizations`, {
                    headers: {
                        Authorization: `Bearer ${masterToken}`,
                    },
                })
            );

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBeGreaterThan(0);
            expect(data[0]).toHaveProperty("slug", "default");
        });
    });

    describe("User Profile", () => {
        it("should return user profile", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/profile`, {
                    headers: {
                        Authorization: `Bearer ${masterToken}`,
                    },
                })
            );

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data).toHaveProperty("primary_email");
            expect(data).toHaveProperty("username");
        });

        it("should return current user (me)", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/me`, {
                    headers: {
                        Authorization: `Bearer ${masterToken}`,
                    },
                })
            );

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data).toHaveProperty("email");
        });
    });

    describe("Projects", () => {
        it("should list projects", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects`, {
                    headers: {
                        Authorization: `Bearer ${masterToken}`,
                    },
                })
            );

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(Array.isArray(data)).toBe(true);
        });

        it("should return 404 for non-existent project", async () => {
            // 注意：如果数据库查询在测试环境中返回了意料之外的结果，请检查此处
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/non_existent_ref_123`, {
                    headers: {
                        Authorization: `Bearer ${masterToken}`,
                    },
                })
            );

            expect(response.status).toBe(404);
        });
    });
});
