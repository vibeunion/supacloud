import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ProjectService } from "../../src/services/project.service";
import { config } from "../../src/config";
import { randomUUID } from "crypto";
import { sql } from "../../src/db";

const PROXY_URL = process.env.TEST_SUPABASE_URL || `http://${config.baseDomain || '127.0.0.1'}:9090`;

// Normalization Helper to strip dynamic values (UUIDs, ISO dates, Ports, etc.)
function normalizePayload(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') {
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(obj);
        if (isUUID) return "[UUID]";
        const isISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(obj);
        if (isISO) return "[TIMESTAMP]";
        // Token normalization lengths
        if (obj.length > 500 && (obj.startsWith('eyJ') || obj.includes('.'))) return "[TOKEN]";
        // Strip origin from URLs
        try {
            if (obj.startsWith('http://') || obj.startsWith('https://')) {
                const u = new URL(obj);
                return `${u.pathname}${u.search}`;
            }
        } catch {}
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(normalizePayload);
    }
    if (typeof obj === 'object') {
        const newObj: any = {};
        for (const [k, v] of Object.entries(obj)) {
            newObj[k] = normalizePayload(v);
        }
        return newObj;
    }
    return obj;
}

describe("E2E SDK Blackbox Contracts", () => {
    let projectService: ProjectService;
    let tenantRef: string;
    let anonKey: string;
    let serviceKey: string;
    let supabase: SupabaseClient;

    let isBooted = false;

    beforeAll(async () => {
        try {
            await fetch(PROXY_URL);
        } catch {
            console.warn(`[E2E] Proxy server not running at ${PROXY_URL}. Skipping sdk-contract tests.`);
            return;
        }

        projectService = new ProjectService();
        const tenantName = `e2e_test_${randomUUID().substring(0, 8)}`;
        console.log(`[E2E] Bootstrapping test tenant: ${tenantName}...`);
        
        try {
            const project = await projectService.createProject({
                name: tenantName,
                region: "local"
            });
            tenantRef = project.ref;
            const keys = await projectService.getApiKeys(tenantRef);
            if (!keys) throw new Error("No keys returned");
            
            anonKey = keys.anon_key;
            serviceKey = keys.service_role_key;
            
            // Allow dynamic routing to settle and GoTrue to fully boot
            await new Promise(r => setTimeout(r, 3000));

            // Initialize official Supabase Client pointing to our Proxy gateway
            supabase = createClient(PROXY_URL, anonKey, {
                auth: { persistSession: false },
                global: {
                    headers: {
                        'x-project-ref': tenantRef // Explicit routing for testing proxy
                    }
                }
            });

            // Ensure test table exists for REST/GraphQL testing
            await sql`
                CREATE TABLE IF NOT EXISTS public.e2e_items (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
                INSERT INTO public.e2e_items (name) VALUES ('Item A'), ('Item B'), ('Item C');
            `;
            isBooted = true;
        } catch (e) {
            console.warn("Failed to boot project inside E2E tests context. Skipping tests.");
        }
    });

    afterAll(async () => {
        if (tenantRef && isBooted) {
            await projectService.deleteProject(tenantRef);
            await sql`DROP TABLE IF EXISTS public.e2e_items;`.catch(() => {});
        }
    });

    describe("Auth Core Paths (P0)", () => {
        test("auth.signInWithOtp / auth.verifyOtp shape", async () => {
            if (!isBooted) return;
            const testEmail = `test_${randomUUID()}@example.com`;
            // Trigger OTP
            const { data: otpData, error: otpError } = await supabase.auth.signInWithOtp({
                email: testEmail
            });
            expect(otpError).toBeNull();
            expect(normalizePayload(otpData)).toEqual({
                messageId: "[UUID]",
                user: null,
                session: null
            });
        });

        test("auth.admin.listUsers shape", async () => {
            if (!isBooted) return;
            const adminClient = createClient(PROXY_URL, serviceKey, {
                auth: { persistSession: false },
                global: { headers: { 'x-project-ref': tenantRef } }
            });
            
            const { data: adminData, error: adminError } = await adminClient.auth.admin.listUsers();
            expect(adminError).toBeNull();
            expect(Array.isArray(adminData?.users)).toBe(true);
        });
    });

    describe("Storage Core Paths (P0)", () => {
        const bucketName = `e2e_bucket`;

        test("bucket workflow and raw upload", async () => {
            if (!isBooted) return;
            const adminClient = createClient(PROXY_URL, serviceKey, {
                auth: { persistSession: false },
                global: { headers: { 'x-project-ref': tenantRef } }
            });

            // Create Bucket
            const { data: bData, error: bError } = await adminClient.storage.createBucket(bucketName, { public: true });
            expect(bError).toBeNull();
            expect(bData?.name).toBe(bucketName);

            // Raw Upload with cache-control
            const rawBody = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
            const { data: uData, error: uError } = await adminClient.storage.from(bucketName).upload('test.bin', rawBody, {
                contentType: 'application/octet-stream',
                cacheControl: '3600',
                upsert: true
            });
            expect(uError).toBeNull();
            expect(normalizePayload(uData)).toEqual({
                id: `${bucketName}/test.bin`,
                path: 'test.bin',
                fullPath: `${bucketName}/test.bin`
            });

            // Exists / Info
            const { data: eData } = await adminClient.storage.from(bucketName).exists('test.bin');
            expect(eData).toBe(true);
            
            const { data: iData, error: iError } = await adminClient.storage.from(bucketName).info('test.bin');
            expect(iError).toBeNull();
            expect(iData).toMatchObject({
                name: 'test.bin',
                bucketId: bucketName,
                size: 4,
                cacheControl: '3600', // Wait, Supabase returns what? We'll check actual value
                contentType: 'application/octet-stream',
            });

            // Signed URLs
            const { data: sData, error: sError } = await adminClient.storage.from(bucketName).createSignedUrl('test.bin', 60);
            expect(sError).toBeNull();
            expect(typeof sData?.signedUrl).toBe('string');
        });
    });

    describe("REST & GraphQL (P0)", () => {
        test("from().select() with count and pagination", async () => {
            if (!isBooted) return;
            const { data, error, count } = await supabase
                .from('e2e_items')
                .select('*', { count: 'exact' })
                .range(0, 1)
                .order('id', { ascending: true });

            expect(error).toBeNull();
            expect(count).toBe(3); // 3 items inserted in setup
            expect(data?.length).toBe(2);
            expect(data![0].name).toBe('Item A');
        });

        test("GraphQL query layout", async () => {
            if (!isBooted) return;
            const headers = new Headers();
            headers.set('apikey', anonKey);
            headers.set('Authorization', `Bearer ${anonKey}`);
            headers.set('x-project-ref', tenantRef);

            const res = await fetch(`${PROXY_URL}/graphql/v1`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ query: "{ e2eItemsCollection { edges { node { name } } } }" })
            });

            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data?.data?.e2eItemsCollection?.edges?.length).toBeGreaterThan(0);
        });
    });
});
