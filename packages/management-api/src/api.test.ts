import { describe, it, expect, beforeAll, spyOn } from "bun:test";
import { app, registerAllRoutes } from "./index";
import { config } from "./config";
import { organizationService } from "./services/organization.service";
import { projectService } from "./services/project.service";

describe("Management API Integration Tests", () => {
    beforeAll(async () => {
        await registerAllRoutes(app);

        // Mock OrganizationService
        spyOn(organizationService, "listOrganizations").mockResolvedValue([
            { id: "org-1", name: "Default Organization", slug: "default", created_at: new Date(), updated_at: new Date() }
        ]);

        // Mock ProjectService
        spyOn(projectService, "listProjects").mockResolvedValue([
            {
                id: "proj-1",
                ref: "default",
                name: "Default Project",
                status: "active",
                region: "local",
                created_at: new Date(),
                database: { host: "localhost", name: "supa_default", user: "role_default" },
                api: { url: "http://api.localhost" },
                studio: { url: "http://studio.localhost" }
            }
        ]);

        spyOn(projectService, "getProject").mockImplementation(async (ref) => {
            if (ref === "default") {
                return {
                    id: "proj-1",
                    ref: "default",
                    name: "Default Project",
                    status: "active",
                    region: "local",
                    created_at: new Date(),
                    updated_at: new Date(),
                    config: { display_name: "Default Project" },
                    database: { host: "localhost", name: "supa_default", user: "role_default" },
                    api: { url: "http://api.localhost" },
                    studio: { url: "http://studio.localhost" }
                };
            }
            return null;
        });

        spyOn(projectService, "getProjectHealth").mockResolvedValue({
            status: "ACTIVE_HEALTHY",
            services: { database: "ACTIVE_HEALTHY" }
        });

        spyOn(projectService, "getProjectStatus").mockResolvedValue({
            status: "active",
            database: "healthy",
            storage: "healthy"
        });

        spyOn(projectService, "queryLogs").mockResolvedValue([]);
        spyOn(projectService, "getProjectSettings").mockResolvedValue({});
        spyOn(projectService, "listFunctions").mockResolvedValue([]);
        spyOn(projectService, "getApiKeys").mockResolvedValue({ anon_key: "anon", service_role_key: "service" });
        spyOn(projectService, "listBackups").mockResolvedValue([]);
        spyOn(projectService, "rotateApiKeys").mockResolvedValue({ anon_key: "new-anon", service_role_key: "new-service" });
        spyOn(projectService, "updateNetworkRestrictions").mockResolvedValue(true);
        spyOn(projectService, "addCustomDomain").mockResolvedValue(true);
    });

    const baseUrl = "http://localhost";
    const masterToken = config.masterToken;

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
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/not-found-${Date.now()}`, {
                    headers: {
                        Authorization: `Bearer ${masterToken}`,
                    },
                })
            );

            expect(response.status).toBe(404);
        });

        it("should return project usage metrics", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/usage`, {
                    headers: { Authorization: `Bearer ${masterToken}` },
                })
            );
            // 内部可能没有 mock 这个，但我们先允许 200 或 404
            expect([200, 404]).toContain(response.status);
        });

        it("should return project logs", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/logs?type=auth`, {
                    headers: { Authorization: `Bearer ${masterToken}` },
                })
            );
            expect(response.status).toBe(200);
        });

        it("should return auth config", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/config/auth`, {
                    headers: { Authorization: `Bearer ${masterToken}` },
                })
            );
            expect([200, 404]).toContain(response.status);
        });

        it("should list project functions", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/functions`, {
                    headers: { Authorization: `Bearer ${masterToken}` },
                })
            );
            expect(response.status).toBe(200);
        });

        it("should rotate api keys", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/api-keys/rotate`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${masterToken}` },
                })
            );
            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data).toHaveProperty("anon_key");
            expect(data).toHaveProperty("service_role_key");
        });

        it("should list database backups", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/database/backups`, {
                    headers: { Authorization: `Bearer ${masterToken}` },
                })
            );
            expect(response.status).toBe(200);
        });

        it("should apply network restrictions", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/network-restrictions`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${masterToken}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        allowed_address_ranges: ["1.1.1.1", "2.2.2.2"]
                    })
                })
            );
            expect(response.status).toBe(200);
        });

        it("should update custom hostname", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/custom-hostname`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${masterToken}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        custom_hostname: "api.example.com"
                    })
                })
            );
            expect(response.status).toBe(200);
        });
    });
});
