import { $ } from "bun";
import { ProjectService } from "../../src/services/project.service";
import { sql } from "../../src/db";
import { join } from "path";
import { writeFileSync, existsSync, rmSync, mkdirSync } from "fs";

async function run() {
    console.log("\\n🚀 [CLI Compliance] Starting Supabase Official CLI Validation Protocol...");

    const projectService = new ProjectService();
    // CLI expects a 20 character ref conforming to certain shapes. We use exactly 20.
    const rawRef = "clicompliancetestref"; 

    // Create deterministic test tenant
    let project;
    try {
        project = await projectService.createProject({
            name: "cli_compliance_harness",
            region: "local"
        });
        
        // Force the ref to the specific 20 char string (since CLI strict checks length)
        await sql`UPDATE projects SET ref = ${rawRef} WHERE id = ${project.id}`;
        project.ref = rawRef;
        
        console.log(`✅ Provisioned 20-char CLI Project Ref [${rawRef}]`);
    } catch(e: any) {
        console.error("Failed to provision CLI test tenant:", e);
        process.exit(1);
    }

    // Give DB time to settle
    await new Promise(r => setTimeout(r, 1000));

    const testDir = join(process.cwd(), '.cache', 'cli-harness');
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });

    // Generate dynamic TOML profile
    const profilePath = join(testDir, 'test-profile.toml');
    writeFileSync(profilePath, `
name = "cli-test"
api_url = "http://127.0.0.1:9090"
dashboard_url = "http://127.0.0.1:9090"
project_host = "supacloud.local"
    `);

    console.log(`✅ Injecting CLI Profile Intercept payload...`);

    // Create a dummy migration folder to verify push capability
    const migrationDir = join(testDir, 'supabase', 'migrations');
    mkdirSync(migrationDir, { recursive: true });
    writeFileSync(
        join(migrationDir, '20230101000000_dummy_migration.sql'),
        `CREATE TABLE IF NOT EXISTS public.cli_test_harness (id SERIAL PRIMARY KEY, note TEXT);`
    );

    const SUPER_TOKEN = 'sbp_0102030405060708091011121314151617181920';

    try {
        console.log("🔗 Executing [supabase link]...");
        const linkResult = await $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx supabase@latest link --project-ref ${rawRef} --profile ${profilePath} -p postgres --yes --workdir ${testDir}`.nothrow();
        
        if (linkResult.exitCode !== 0) {
            console.error("❌ CLI [link] Failed!", linkResult.stderr.toString());
            process.exit(1);
        } else {
            console.log("✅ CLI [link] Success!");
        }

        console.log("⬆️  Executing [supabase db push]...");
        const pushResult = await $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx supabase@latest db push --profile ${profilePath} -p postgres --workdir ${testDir}`.nothrow();
        
        if (pushResult.exitCode !== 0) {
            console.error("❌ CLI [db push] Failed!", pushResult.stderr.toString());
            process.exit(1);
        } else {
            console.log("✅ CLI [db push] Success! Migration applied natively through official CLI.");
        }
        
    } finally {
        console.log(`🧹 Tearing down tenant [${project.id}]...`);
        // Cleanup projects table 
        await sql`DELETE FROM projects WHERE id = ${project.id}`;
        rmSync(testDir, { recursive: true, force: true });
        await sql.end();
        process.exit(0);
    }
}

run();
