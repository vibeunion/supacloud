import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ProjectService } from "../../src/services/project.service";
import { databaseService } from "../../src/services/database.service";
import { config } from "../../src/config";
import { randomUUID } from "crypto";

// The local API base URL for SupaCloud E2E tests
// Since SupaCloud management-api routes /v1/* to management and /* to tenant gateway via the proxy
// We connect to the proxy port. Usually port 9090 is the local dev server.
const PROXY_URL = process.env.TEST_SUPABASE_URL || `http://${config.baseDomain || '127.0.0.1'}:9090`;

describe("SDK E2E Compliance Suite", () => {
    let projectService: ProjectService;
    let tenantRef: string;
    let anonKey: string;
    let serviceKey: string;
    let supabase: SupabaseClient;
    let supabaseAdmin: SupabaseClient;

    let isBooted = false;

    beforeAll(async () => {
        try {
            await fetch(PROXY_URL);
        } catch {
            console.warn(`[E2E] Proxy server not running at ${PROXY_URL}. Skipping compliance tests.`);
            return;
        }
        
        // 1. Create a Test Tenant Lifecycle
        projectService = new ProjectService();
        
        const tenantName = `e2e_test_${randomUUID().substring(0, 8)}`;
        console.log(`[E2E] Bootstrapping test tenant: ${tenantName}...`);
        
        // This triggers the full creation lifecycle (DB creation, roles, auth config, running migrations)
        // Ensure you have docker-compose.dev.yml running so that PostgreSQL / Pigsty is available
        const project = await projectService.createProject({
            name: tenantName,
            region: "local"
        });
        
        tenantRef = project.ref;
        const keys = await projectService.getApiKeys(tenantRef);
        if (!keys) throw new Error("Failed to generate API keys for test tenant");

        anonKey = keys.anon_key;
        serviceKey = keys.service_role_key;

        console.log(`[E2E] Tenant ${tenantRef} created successfully.`);

        if (process.env.TEST_FIXED_JWT_SECRET) {
            console.log(`[E2E] Running in CI mode, redirecting tenant proxy ports to local docker containers (3000/9999)`);
            const { sql } = await import('../../src/db');
            await sql`UPDATE project_config SET postgrest_port = 3000, gotrue_port = 9999 WHERE project_ref = ${tenantRef}`;
        }

        // Wait a small moment for dynamic routing configs to settle
        await new Promise(r => setTimeout(r, 2000));

        // Create an RPC endpoint securely in the DB because Supabase JS uses RPC for some generic execs
        const { sql } = await import('../../src/db');
        await sql`
            CREATE OR REPLACE FUNCTION public.exec_sql(query text) RETURNS void AS $$
            BEGIN
                EXECUTE query;
            END;
            $$ LANGUAGE plpgsql SECURITY DEFINER;
        `;

        // 2. Instantiate Official `@supabase/supabase-js` clients
        // The URL format must match our sdk-proxy interception strategy
        supabase = createClient(PROXY_URL, anonKey, {
            auth: {
                persistSession: false,
                autoRefreshToken: false
            },
            global: {
                headers: {
                    'x-project-ref': tenantRef // Support generic dev environments where Host parsing might fail
                }
            }
        });

        supabaseAdmin = createClient(PROXY_URL, serviceKey, {
            auth: {
                persistSession: false,
                autoRefreshToken: false
            },
            global: {
                headers: {
                    'x-project-ref': tenantRef
                }
            }
        });

        isBooted = true;
    });

    afterAll(async () => {
        if (!isBooted) return;
        console.log(`[E2E] Tearing down test tenant: ${tenantRef}...`);
        // We pause or delete the project to keep the dev environment clean
        try { 
            const { sql } = await import('../../src/db');
            await sql`DROP FUNCTION IF EXISTS public.exec_sql(text);`; 
        } catch(e){}
        await projectService.deleteProject(tenantRef);
    });

    describe("Auth API (GoTrue Compliance)", () => {
        const testEmail = `test_${randomUUID()}@example.com`;
        const testPassword = "SuperSecurePassword123!";

        test("signUp - Email/Password", async () => {
            if (!isBooted) return;
            const { data, error } = await supabase.auth.signUp({
                email: testEmail,
                password: testPassword
            });
            expect(error).toBeNull();
            expect(data.user).not.toBeNull();
            expect(data.user?.email).toBe(testEmail);
        });

        test("signInWithPassword", async () => {
            if (!isBooted) return;
            const { data, error } = await supabase.auth.signInWithPassword({
                email: testEmail,
                password: testPassword
            });
            expect(error).toBeNull();
            expect(data.session).not.toBeNull();
            expect(data.session?.access_token).toBeDefined();
        });

        test("getSession & signOut", async () => {
            if (!isBooted) return;
            const { data: sessionData } = await supabase.auth.getSession();
            expect(sessionData.session).toBeDefined(); // From sign in

            const { error: signOutError } = await supabase.auth.signOut();
            expect(signOutError).toBeNull();

            const { data: noSessionData } = await supabase.auth.getSession();
            expect(noSessionData.session).toBeNull();
        });

        test("admin.listUsers", async () => {
            if (!isBooted) return;
            const { data, error } = await supabaseAdmin.auth.admin.listUsers();
            expect(error).toBeNull();
            expect(data.users).toBeInstanceOf(Array);
            expect(data.users.length).toBeGreaterThan(0);
        });
    });

    describe("PostgREST API Compliance", () => {
        const tableName = "e2e_items";

        beforeAll(async () => {
            if (!isBooted) return;
            // Create a test table using Service Role bypassing RLS
            await supabaseAdmin.rpc('exec_sql', { 
                query: `
                    CREATE TABLE IF NOT EXISTS public.${tableName} (
                        id SERIAL PRIMARY KEY,
                        name TEXT NOT NULL,
                        created_at TIMESTAMPTZ DEFAULT NOW()
                    );
                    ALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY;
                    CREATE POLICY "Enable read access for all users" ON public.${tableName} FOR SELECT USING (true);
                    CREATE POLICY "Enable insert for authenticated users only" ON public.${tableName} FOR INSERT WITH CHECK (auth.role() = 'authenticated');
                `
            });
        });

        test("db insert & select", async () => {
            if (!isBooted) return;
            // We simulate skipping auth for service role first to ensure DB works
            const { data: inserted, error: insertError } = await supabaseAdmin
                .from(tableName)
                .insert([{ name: 'Test Box' }])
                .select()
                .single();
            
            expect(insertError).toBeNull();
            expect(inserted.name).toBe('Test Box');

            const { data: selected, error: selectError } = await supabaseAdmin
                .from(tableName)
                .select('*')
                .eq('id', inserted.id)
                .single();
            
            expect(selectError).toBeNull();
            expect(selected.name).toBe('Test Box');
        });

        test("db update & delete", async () => {
            if (!isBooted) return;
            const { data: inserted } = await supabaseAdmin
                .from(tableName)
                .insert([{ name: 'To Update' }])
                .select()
                .single();
            
            const { data: updated, error: updateError } = await supabaseAdmin
                .from(tableName)
                .update({ name: 'Updated!' })
                .eq('id', inserted.id)
                .select()
                .single();

            expect(updateError).toBeNull();
            expect(updated.name).toBe('Updated!');

            const { error: deleteError } = await supabaseAdmin
                .from(tableName)
                .delete()
                .eq('id', inserted.id);

            expect(deleteError).toBeNull();
        });
    });

    describe("Storage API Compliance", () => {
        const bucketName = `test_bucket_${randomUUID().substring(0, 5)}`;
        const fileName = "hello.txt";

        test("createBucket", async () => {
            if (!isBooted || process.env.TEST_FIXED_JWT_SECRET) return;
            const { data, error } = await supabaseAdmin.storage.createBucket(bucketName, { public: true });
            expect(error).toBeNull();
            expect(data?.name).toBe(bucketName);
        });

        test("upload file", async () => {
            if (!isBooted || process.env.TEST_FIXED_JWT_SECRET) return;
            const fileBlob = new Blob(["Hello SupaCloud!"], { type: "text/plain" });
            const { data, error } = await supabaseAdmin.storage.from(bucketName).upload(fileName, fileBlob);
            expect(error).toBeNull();
            expect(data?.path).toBe(fileName);
        });

        test("download file", async () => {
            if (!isBooted || process.env.TEST_FIXED_JWT_SECRET) return;
            const { data, error } = await supabaseAdmin.storage.from(bucketName).download(fileName);
            expect(error).toBeNull();
            const text = await data?.text();
            expect(text).toBe("Hello SupaCloud!");
        });

        test("list files", async () => {
            if (!isBooted || process.env.TEST_FIXED_JWT_SECRET) return;
            const { data, error } = await supabaseAdmin.storage.from(bucketName).list();
            expect(error).toBeNull();
            expect(data).toBeInstanceOf(Array);
            expect(data?.find(f => f.name === fileName)).toBeDefined();
        });

        test("getPublicUrl", async () => {
            if (!isBooted || process.env.TEST_FIXED_JWT_SECRET) return;
            const { data } = supabaseAdmin.storage.from(bucketName).getPublicUrl(fileName);
            expect(data.publicUrl).toBeDefined();
            expect(data.publicUrl).toContain(PROXY_URL);
        });
    });

    describe("Realtime / postgres_changes Compliance", () => {
        test("channel.on('postgres_changes').subscribe", async () => {
            if (!isBooted || process.env.TEST_FIXED_JWT_SECRET) return;
            const channelName = "db-changes";
            const channel = supabaseAdmin.channel(channelName);
            
            let receivedEvent: any = null;

            channel.on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'e2e_items'
            }, (payload) => {
                receivedEvent = payload;
            });

            await new Promise<void>((resolve, reject) => {
                channel.subscribe((status, err) => {
                    if (status === 'SUBSCRIBED') resolve();
                    else if (status === 'CHANNEL_ERROR') reject(err);
                });
            });

            // Trigger an insert to fire WAL
            await supabaseAdmin.from('e2e_items').insert([{ name: 'Realtime Trigger' }]);

            // Wait up to 3 seconds for realtime broadcast
            for(let i=0; i<30; i++) {
                if(receivedEvent) break;
                await new Promise(r => setTimeout(r, 100));
            }

            expect(receivedEvent).not.toBeNull();
            expect(receivedEvent.eventType).toBe('INSERT');

            supabaseAdmin.removeChannel(channel);
        }, 10000); // Give it enough timeout leeway
    });
});
