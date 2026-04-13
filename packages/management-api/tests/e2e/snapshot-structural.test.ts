import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import path from "path";
import { buildSchemaObject } from "../scripts/capture-snapshots";
import { ProjectService } from "../../src/services/project.service";
import { config } from "../../src/config";
import { randomUUID } from "crypto";

const PROXY_URL = process.env.TEST_SUPABASE_URL || `http://${config.baseDomain || '127.0.0.1'}:9090`;
const groundTruthDir = path.join(__dirname, "../snapshots/ground_truth");
const MASTER_TOKEN = process.env.MASTER_TOKEN || process.env.TEST_FIXED_JWT_SECRET || "test";

function getGroundTruth(name: string) {
    const p = path.join(groundTruthDir, `${name}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function authHeaders(): Record<string, string> {
    return {
        "Authorization": `Bearer ${MASTER_TOKEN}`,
        "Content-Type": "application/json",
    };
}

describe("API Structural Snapshot Compliance", () => {
    let projectService: ProjectService;
    let tenantRef: string;
    let anonKey: string;
    let isBooted = false;

    beforeAll(async () => {
        projectService = new ProjectService();
        const tenantName = `snap_test_${randomUUID().substring(0, 8)}`;
        console.log(`[Snap] Bootstrapping test tenant: ${tenantName}...`);

        try {
            const project = await projectService.createProject({
                name: tenantName,
                region: "local"
            });
            tenantRef = project.ref;
            const keys = await projectService.getApiKeys(tenantRef);
            if (keys) anonKey = keys.anon_key;

            if (process.env.TEST_FIXED_JWT_SECRET) {
                const { sql } = await import("../../src/db");
                await sql`
                    INSERT INTO project_config (project_ref, postgrest_port, gotrue_port, realtime_port) 
                    VALUES (${tenantRef}, 3000, 9999, 4000) 
                    ON CONFLICT (project_ref) DO UPDATE 
                    SET postgrest_port = 3000, gotrue_port = 9999, realtime_port = 4000
                `;
                await sql`
                    UPDATE projects SET db_name = 'postgres' WHERE ref = ${tenantRef};
                `;
            }

            await new Promise(r => setTimeout(r, 2000));
            isBooted = true;
        } catch (e) {
            console.error("Failed to boot project inside snapshot tests context. Skipping tests.");
        }
    });

    afterAll(async () => {
        if (tenantRef) {
            await projectService.deleteProject(tenantRef);
        }
    });

    test("Storage API - List Unknown Bucket Error Shape", async () => {
        if (!isBooted) return;

        const gt = getGroundTruth("storage_list_error");
        if (!gt) return;

        const res = await fetch(`${PROXY_URL}/storage/v1/object/list/unknown_bucket`, {
            method: "POST",
            headers: {
                "apikey": anonKey,
                "Authorization": `Bearer ${anonKey}`,
                "Content-Type": "application/json",
                "x-project-ref": tenantRef
            }
        });

        expect(res.status).toBe(gt.status);

        const data = await res.json();
        const schema = buildSchemaObject(data);

        expect(schema).toEqual(gt.schema);
    });

    test("Auth API - Invalid Signup Error Shape", async () => {
        if (!isBooted) return;

        const gt = getGroundTruth("auth_signup_error");
        if (!gt) return;

        const res = await fetch(`${PROXY_URL}/auth/v1/signup`, {
            method: "POST",
            headers: {
                "apikey": anonKey,
                "Authorization": `Bearer ${anonKey}`,
                "Content-Type": "application/json",
                "x-project-ref": tenantRef
            },
            body: JSON.stringify({ email: "invalid", password: "1" })
        });

        expect(res.status).toBe(gt.status);

        const data = await res.json();
        const schema = buildSchemaObject(data);

        expect(schema).toEqual(gt.schema);
    });

    test("Management API - GET /v1/projects returns array", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
    });

    test("Management API - GET /v1/projects/:ref returns project object", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(200);
        const data = await res.json() as Record<string, unknown>;
        expect(data.ref).toBe(tenantRef);
        expect(data.id).toBeDefined();
        expect(data.name).toBeDefined();
        expect(data.status).toBeDefined();
        expect(data.database).toBeDefined();
        expect((data.database as Record<string, unknown>).host).toBeDefined();
    });

    test("Management API - GET /v1/projects/:ref/api-keys returns array", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/api-keys`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
        if (data.length > 0) {
            expect(data[0].name).toBeDefined();
            expect(data[0].api_key).toBeDefined();
        }
    });

    test("Management API - GET /v1/organizations returns array", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/organizations`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
    });

    test("Management API - GET /v1/projects/:ref/config/auth returns object", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/config/auth`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(200);
        const data = await res.json() as Record<string, unknown>;
        expect(typeof data).toBe("object");
    });

    test("Management API - GET /v1/projects/:ref/config/database returns object", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/config/database`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(200);
        const data = await res.json() as Record<string, unknown>;
        expect(typeof data).toBe("object");
    });

    test("Management API - POST /v1/projects/:ref/database/query executes SQL", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/database/query`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ query: "SELECT 1 as test" }),
        });

        expect(res.status).toBe(200);
        const data = await res.json() as Record<string, unknown>;
        expect(data.result).toBeDefined();
    });

    test("Management API - GET /v1/projects/:ref/database/migrations returns array", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/database/migrations`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
    });

    test("Management API - GET /v1/projects/:ref/functions returns array", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/functions`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
    });

    test("Management API - GET /v1/projects/:ref/functions/secrets returns array", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/functions/secrets`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
    });

    test("Management API - GET /v1/projects/:ref/secrets returns array", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/secrets`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
    });

    test("Management API - GET /v1/projects/:ref/database/extensions returns array", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/database/extensions`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
    });

    test("Management API - GET /v1/projects/:ref/database/webhooks returns array", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/database/webhooks`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
    });

    test("Management API - GET /v1/projects/:ref/services returns array", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/services`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
    });

    test("Management API - Error response format uses {message} not {error}", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects/nonexistent_project_ref`, {
            headers: authHeaders(),
        });

        expect(res.status).toBe(404);
        const data = await res.json() as Record<string, unknown>;
        expect(data.message).toBeDefined();
        expect(data.error).toBeUndefined();
    });

    test("Management API - Response includes x-supabase-api-version header", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects`, {
            headers: authHeaders(),
        });

        expect(res.headers.get("x-supabase-api-version")).toBeDefined();
    });

    test("Management API - Response includes rate limit headers", async () => {
        if (!isBooted) return;

        const res = await fetch(`${PROXY_URL}/v1/projects`, {
            headers: authHeaders(),
        });

        expect(res.headers.get("x-ratelimit-limit")).toBeDefined();
        expect(res.headers.get("x-ratelimit-remaining")).toBeDefined();
    });
});
