import { describe, it, expect, beforeAll } from "bun:test";
import { app } from "../src/index";

describe("Management API Integration Tests", () => {
    const baseUrl = "http://localhost";

    describe("Organizations", () => {
        it("should list organizations", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/organizations`, {
                    headers: {
                        Authorization: "Bearer dev-master-token", // 假设 authMiddleware 在开发环境/测试环境有特定处理或简单绕过
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
                        Authorization: "Bearer dev-master-token",
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
                        Authorization: "Bearer dev-master-token",
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
                        Authorization: "Bearer test-token",
                    },
                })
            );

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(Array.isArray(data)).toBe(true);
        });

        it("should return 404 for non-existent project", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/non-existent`, {
                    headers: {
                        Authorization: "Bearer test-token",
                    },
                })
            );

            expect(response.status).toBe(404);
        });
    });
});
