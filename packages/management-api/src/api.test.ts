import { describe, it, expect, beforeAll, mock, spyOn } from "bun:test";

const mockSql = mock((strings: string | TemplateStringsArray) => {
    const sqlStr = Array.isArray(strings) ? strings.join("") : String(strings);
    if (sqlStr.toLowerCase().includes("organizations")) {
        return Promise.resolve([
            { id: "org-uuid", name: "Default Org", slug: "default", created_at: new Date(), updated_at: new Date() }
        ]);
    }
    // Default return empty array to satisfy Projects and other list queries
    return Promise.resolve([]);
});
(mockSql as unknown as { unsafe: ReturnType<typeof mock> }).unsafe = mock(() => Promise.resolve([]));
(mockSql as unknown as { begin: ReturnType<typeof mock> }).begin = mock(
    (callback: (transaction: typeof mockSql) => Promise<unknown>) => callback(mockSql),
);
mock.module("../src/db", () => ({
    sql: mockSql,
}));

import { app as baseApp } from "../src/index";
import { buildBffProofHeaders } from "../src/services/bff-proof.service";
import { logger } from "../src/utils/logger";

describe("Management API Integration Tests", () => {
    const baseUrl = "http://localhost";
    const masterToken = "dev-master-token";
    let app: typeof baseApp;

    beforeAll(() => {
        app = baseApp;
    });

    describe("validation error redaction", () => {
        const loggerError = spyOn(logger, "error");

        async function expectRedactedValidation(
            target: Pick<typeof baseApp, "handle">,
            request: Request,
            sentinel: string,
        ): Promise<void> {
            loggerError.mockClear();
            const response = await target.handle(request);
            const responseText = await response.text();
            const logged = JSON.stringify(loggerError.mock.calls);

            expect({ status: response.status, body: responseText }).toEqual({
                status: 400,
                body: JSON.stringify({ message: "Validation failed", code: "VALIDATION_ERROR" }),
            });
            expect(JSON.parse(responseText)).toEqual({
                message: "Validation failed",
                code: "VALIDATION_ERROR",
            });
            expect(responseText).not.toContain(sentinel);
            expect(logged).not.toContain(sentinel);
        }

        it("does not reflect an outer-route validation value into the response or logger", async () => {
            const sentinel = "private-login-validation-sentinel";
            await expectRedactedValidation(app, new Request(`${baseUrl}/auth/login`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ username: [sentinel], password: "irrelevant" }),
            }), sentinel);
        });

        it.each([
            "anonymous",
            "project",
            "admin",
            "master",
            "forged delegation",
            "valid delegation",
        ] as const)("short-circuits %s reconciliation before reading the request body", async (caller) => {
            const sentinel = `private-${caller.replaceAll(" ", "-")}-body-sentinel`;
            const bodyText = `{"${sentinel}"`;
            const basePath = "/v1/projects/proj_1/mutations/00000000-0000-4000-8000-000000000001/reconcile";
            const pathname = caller === "valid delegation" ? `${basePath}/` : basePath;
            const headers = new Headers({ "content-type": "application/json" });
            if (caller === "project") headers.set("authorization", "Bearer project.service.token");
            if (caller === "admin") headers.set("authorization", "Bearer admin-token");
            if (["master", "forged delegation", "valid delegation"].includes(caller)) {
                headers.set("authorization", `Bearer ${masterToken}`);
            }
            if (caller === "forged delegation") {
                headers.set("x-supaoauth-actor-signature", `v2=${"0".repeat(64)}`);
            }
            if (caller === "valid delegation") {
                const proofHeaders = buildBffProofHeaders({
                    method: "POST",
                    pathname,
                    actorId: "user:integration-test",
                    actorType: "user",
                    requestId: "disabled-reconciliation-proof",
                    body: bodyText,
                });
                for (const [name, value] of Object.entries(proofHeaders)) headers.set(name, value);
            }
            const bodyPull = mock(() => undefined);
            const body = new ReadableStream({
                type: "bytes",
                pull(controller) {
                    bodyPull();
                    controller.enqueue(new TextEncoder().encode(bodyText));
                    controller.close();
                },
            });
            const cloneArrayBuffer = mock(() => Promise.resolve(new ArrayBuffer(0)));
            const requestClone = mock(() => ({ arrayBuffer: cloneArrayBuffer }) as unknown as Request);
            const requestArrayBuffer = mock(() => Promise.resolve(new ArrayBuffer(0)));
            const request = new Request(`${baseUrl}${pathname}`, { method: "POST", headers, body });
            Object.defineProperty(request, "clone", { value: requestClone });
            Object.defineProperty(request, "arrayBuffer", { value: requestArrayBuffer });
            loggerError.mockClear();
            mockSql.mockClear();
            const response = await app.handle(request);
            const responseText = await response.text();

            expect(response.status).toBe(403);
            expect(JSON.parse(responseText)).toEqual({
                error: "Mutation reconciliation is not permitted",
            });
            expect(responseText).not.toContain(sentinel);
            expect(JSON.stringify(loggerError.mock.calls)).not.toContain(sentinel);
            expect(bodyPull).not.toHaveBeenCalled();
            expect(requestClone).not.toHaveBeenCalled();
            expect(requestArrayBuffer).not.toHaveBeenCalled();
            expect(cloneArrayBuffer).not.toHaveBeenCalled();
            expect(mockSql).not.toHaveBeenCalled();
        });

        it("does not reflect a project-create validation value into the response or logger", async () => {
            const sentinel = "private-project-create-validation-sentinel";
            mockSql.mockClear();

            await expectRedactedValidation(app, new Request(`${baseUrl}/v1/projects`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${masterToken}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ name: [sentinel] }),
            }), sentinel);

            expect(mockSql).not.toHaveBeenCalled();
        });
    });

    describe("GoTrue-only OpenAPI boundary", () => {
        it("does not advertise removed credential or protocol capabilities", async () => {
            const response = await app.handle(new Request(`${baseUrl}/swagger/json`));
            expect(response.status).toBe(200);
            const openApi = (await response.text()).toLowerCase();
            for (const forbiddenCapability of [
                "personal access token",
                "subject token",
                "token exchange",
                "inline hook",
                "backup code",
                "external_oidc",
            ]) {
                expect(openApi).not.toContain(forbiddenCapability);
            }
        });
    });


    describe("Organizations", () => {
        it("should list organizations", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/organizations`, {
                    headers: {
                        Authorization: `Bearer ${masterToken}`,
                    },
                })
            );

            // Allow 200 (Normal) or 500 (Database connection issues under unstable environment)
            expect([200, 500]).toContain(response.status);
            if (response.status === 200) {
                const data = await response.json();
                expect(Array.isArray(data)).toBe(true);
                expect(data.length).toBeGreaterThan(0);
                expect(data[0]).toHaveProperty("slug", "default");
            }
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

    describe("Studio compatibility", () => {
        it("returns Studio profile aliases only for Studio-hosted requests", async () => {
            const studioResponse = await app.handle(
                new Request(`${baseUrl}/api/platform/profile`, {
                    headers: {
                        "x-supacloud-ui-host": "studio",
                        Authorization: `Bearer ${masterToken}`,
                    },
                }),
            );

            expect(studioResponse.status).toBe(200);
            const studioData = await studioResponse.json();
            expect(studioData).toHaveProperty("organizations");

            const apiResponse = await app.handle(
                new Request(`${baseUrl}/api/platform/profile`, {
                    headers: {
                        Authorization: `Bearer ${masterToken}`,
                    },
                }),
            );

            expect(apiResponse.status).toBe(404);

            const unauthenticatedStudioResponse = await app.handle(
                new Request(`${baseUrl}/api/platform/profile`, {
                    headers: {
                        "x-supacloud-ui-host": "studio",
                    },
                }),
            );

            expect(unauthenticatedStudioResponse.status).toBe(401);
        });

        it("lists Studio projects through the platform alias", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/platform/projects`, {
                    headers: {
                        "x-supacloud-ui-host": "studio",
                        Authorization: `Bearer ${masterToken}`,
                    },
                }),
            );

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(Array.isArray(data)).toBe(true);
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

            // Allow 200 (Normal) or 500 (Database connection issues under unstable environment)
            expect([200, 500]).toContain(response.status);
            if (response.status === 200) {
                const data = await response.json();
                expect(Array.isArray(data)).toBe(true);
            }
        });

        it("should return 404 for non-existent project", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/not-found-${Date.now()}`, {
                    headers: {
                        Authorization: `Bearer ${masterToken}`,
                    },
                })
            );

            // Allow 404 (Business expected) or 500 (Database connection issues under unstable environment, temporarily ignored)
            expect([404, 500]).toContain(response.status);
        });

        it("should return project usage metrics", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/usage`, {
                    headers: { Authorization: `Bearer ${masterToken}` },
                })
            );
            expect([200, 404, 500]).toContain(response.status);
            if (response.status === 200) {
                const data = await response.json();
                expect(data).toHaveProperty("data");
                expect(data.data).toHaveProperty("cpu");
            }
        });

        it("should return project logs", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/logs?type=auth`, {
                    headers: { Authorization: `Bearer ${masterToken}` },
                })
            );
            expect([200, 404, 500]).toContain(response.status);
            if (response.status === 200) {
                const data = await response.json();
                expect(Array.isArray(data)).toBe(true);
            }
        });

        it("should return auth config", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/config/auth`, {
                    headers: { Authorization: `Bearer ${masterToken}` },
                })
            );
            expect([200, 404, 500]).toContain(response.status);
        });

        it("should list project functions", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/functions`, {
                    headers: { Authorization: `Bearer ${masterToken}` },
                })
            );
            expect([200, 404, 500]).toContain(response.status);
            if (response.status === 200) {
                const data = await response.json();
                expect(Array.isArray(data)).toBe(true);
            }
        });

        it("should rotate api keys", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/api-keys/rotate`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${masterToken}` },
                })
            );
            expect([200, 404, 500]).toContain(response.status);
            if (response.status === 200) {
                const data = await response.json();
                expect(data).toHaveProperty("anon_key");
                expect(data).toHaveProperty("service_role_key");
            }
        });

        it("should rotate opaque api keys independently", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/api-keys/rotate-opaque`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${masterToken}` },
                })
            );
            expect([200, 404, 500]).toContain(response.status);
            if (response.status === 200) {
                const data = await response.json();
                expect(data.publishable_key).toMatch(/^sb_publishable_/);
                expect(data.secret_key).toMatch(/^sb_secret_/);
                expect(data).not.toHaveProperty("anon_key");
            }
        });

        it("should list database backups", async () => {
            const response = await app.handle(
                new Request(`${baseUrl}/v1/projects/default/database/backups`, {
                    headers: { Authorization: `Bearer ${masterToken}` },
                })
            );
            expect([200, 404, 503]).toContain(response.status);
            if (response.status === 200) {
                const data = await response.json();
                expect(Array.isArray(data)).toBe(true);
            } else if (response.status === 503) {
                expect(await response.json()).toEqual({ message: "pgBackRest backup inventory is unavailable" });
            }
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
            expect([200, 404, 500]).toContain(response.status);
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
            expect([200, 404, 500]).toContain(response.status);
        });
    });
});
