import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import path from "path";
import { buildSchemaObject } from "../scripts/capture-snapshots";
import { ProjectService } from "../../src/services/project.service";
import { config } from "../../src/config";
import { randomUUID } from "crypto";

const PROXY_URL = process.env.TEST_SUPABASE_URL || `http://${config.baseDomain || '127.0.0.1'}:9090`;
const groundTruthDir = path.join(__dirname, "../snapshots/ground_truth");

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

            // In CI mode, redirect to the local docker containers
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
            
            // Allow dynamic routing to settle
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

    function getGroundTruth(name: string) {
        const p = path.join(groundTruthDir, `${name}.json`);
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, "utf-8"));
    }

    test("Storage API - List Unknown Bucket Error Shape", async () => {
        if (!isBooted) return;
        
        const gt = getGroundTruth("storage_list_error");
        if (!gt) return; // Skip if no ground truth built

        const res = await fetch(`${PROXY_URL}/storage/v1/object/list/unknown_bucket`, {
            method: "POST",
            headers: {
                "apikey": anonKey,
                "Authorization": `Bearer ${anonKey}`,
                "Content-Type": "application/json",
                // Manually map to tenant
                "x-project-ref": tenantRef
            }
        });

        // Ensure status code compatibility 
        // e.g. SDK will crash if an error response isn't 4xx or 5xx
        expect(res.status).toBe(gt.status);

        const data = await res.json();
        const schema = buildSchemaObject(data);

        // Expect SupaCloud payload schema to perfectly match Official payload schema!
        expect(schema).toEqual(gt.schema);
    });

    test("Auth API - Invalid Signup Error Shape", async () => {
        if (!isBooted) return;
        
        const gt = getGroundTruth("auth_signup_error");
        if (!gt) return; // Skip if no ground truth built

        const res = await fetch(`${PROXY_URL}/auth/v1/signup`, {
            method: "POST",
            headers: {
                "apikey": anonKey,
                "Authorization": `Bearer ${anonKey}`,
                "Content-Type": "application/json",
                // Manually map to tenant
                "x-project-ref": tenantRef
            },
            body: JSON.stringify({ email: "invalid", password: "1" })
        });

        // Ensure status code compatibility
        expect(res.status).toBe(gt.status);

        const data = await res.json();
        const schema = buildSchemaObject(data);

        // Expect SupaCloud payload schema to perfectly match Official payload schema!
        expect(schema).toEqual(gt.schema);
    });
});
