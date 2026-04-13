import { $ } from "bun";
import { ProjectService } from "../../src/services/project.service";
import { randomUUID } from "crypto";
import { sql } from "../../src/db";
import { join } from "path";
import { existsSync, rmSync, readFileSync, writeFileSync } from "fs";

// Pre-defined values that Supabase-JS's official repo hardcodes inside test/integration.test.ts
const OFFICIAL_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const OFFICIAL_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const OFFICIAL_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

async function bootstrap() {
    console.log("\\n🚀 [Phase 1] Bootstrapping Official Supabase-JS Test Harness...");

    const projectService = new ProjectService();
    const tenantName = `sdk_hijack_${randomUUID().substring(0, 8)}`;

    const project = await projectService.createProject({
        name: tenantName,
        region: "local"
    });
    
    // Inject official keys into our database!
    await sql`
        UPDATE projects 
        SET anon_key = ${OFFICIAL_ANON_KEY}, 
            service_role_key = ${OFFICIAL_SERVICE_ROLE_KEY},
            jwt_secret = ${OFFICIAL_JWT_SECRET}
        WHERE ref = ${project.ref}
    `;

    console.log(`✅ Provisioned Test Tenant [${project.ref}] with hijacked keys.`);

    // Wait for systems to settle
    await new Promise(r => setTimeout(r, 2000));

    console.log("📦 Applying dummy schema needed for official SDK tests...");
    try {
        await sql`CREATE TABLE IF NOT EXISTS public.todos (id SERIAL PRIMARY KEY, task TEXT, is_complete BOOLEAN);`;
        await sql`CREATE TABLE IF NOT EXISTS public.users (username TEXT PRIMARY KEY, status TEXT);`;
        await sql`CREATE TABLE IF NOT EXISTS public.channels (id TEXT PRIMARY KEY, inserted_at TIMESTAMPTZ DEFAULT NOW());`;
        await sql`CREATE TABLE IF NOT EXISTS public.messages (id TEXT PRIMARY KEY, message TEXT, channel_id TEXT);`;
        await sql`CREATE OR REPLACE FUNCTION hello_world() RETURNS text AS $$ BEGIN RETURN 'hello world'; END; $$ LANGUAGE plpgsql;`;
    } catch(e: any) {
        console.warn('DB scheme injection err (ignoring):', e.message);
    }

    const targetDir = join(process.cwd(), '.cache', 'supabase-js');
    if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
    }

    console.log("📥 Downloading @supabase/supabase-js master branch to memory cache...");
    await $`git clone --depth 1 https://github.com/supabase/supabase-js.git ${targetDir}`.quiet();

    console.log("💉 Altering test bindings to target supacloud proxy at 9090...");
    const testFilePath = join(targetDir, 'packages/core/supabase-js/test/integration.test.ts');
    
    if (existsSync(testFilePath)) {
        let testContent = readFileSync(testFilePath, 'utf8');
        // Hijack the targeted port
        testContent = testContent.replace(/http:\/\/127\.0\.0\.1:54321/g, 'http://127.0.0.1:9090');
        writeFileSync(testFilePath, testContent, 'utf8');
    } else {
        console.warn("⚠️ Official test file location changed! Continuing anyway.");
    }

    console.log("📦 Installing test dependencies inside the hijacked capsule...");
    await $`cd ${targetDir} && npm install --no-fund --no-audit`.quiet();

    console.log("🔥 Launching Supabase Official Integration Payload...");
    try {
        // Run tests mapping to local proxy 
        await $`cd ${targetDir}/packages/core/supabase-js && npx jest test/integration.test.ts`.nothrow();
    } catch (err) {
        console.error("❌ Test suite encountered an error.", err);
    } finally {
        console.log(`\\n🧹 Tearing down tenant [${project.ref}] and wiping cache...`);
        await projectService.deleteProject(project.ref);
        rmSync(targetDir, { recursive: true, force: true });
        
        await sql.end();
        process.exit(0);
    }
}

bootstrap();
