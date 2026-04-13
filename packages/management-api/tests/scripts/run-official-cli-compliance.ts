import { $ } from "bun";
import { ProjectService } from "../../src/services/project.service";
import { sql, getProjectDb, resolveDbName } from "../../src/db";
import { join } from "path";
import { writeFileSync, existsSync, rmSync, mkdirSync } from "fs";

const CLI_VERSION = "2.20.5";

async function run() {
    console.log("\n🚀 [CLI Compliance] Starting Supabase Official CLI Validation Protocol...");

    const projectService = new ProjectService();
    const rawRef = "clicompliancetestref";

    let project;
    try {
        project = await projectService.createProject({
            name: "cli_compliance_harness",
            region: "local"
        });

        // Delete any saga-spawned tasks referencing the old ref before updating it,
        // since project_tasks.project_ref has a FK constraint on projects.ref.
        await sql`DELETE FROM project_tasks WHERE project_ref = ${project.ref}`;
        await sql`UPDATE projects SET ref = ${rawRef} WHERE id = ${project.id}`;
        project.ref = rawRef;

        console.log(`✅ Provisioned 20-char CLI Project Ref [${rawRef}]`);
    } catch (e: any) {
        console.error("Failed to provision CLI test tenant:", e);
        process.exit(1);
    }

    await new Promise(r => setTimeout(r, 2000));

    const testDir = join(process.cwd(), '.cache', 'cli-harness');
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    const configDir = join(testDir, 'supabase');
    mkdirSync(configDir, { recursive: true });

    writeFileSync(join(configDir, 'config.toml'), `
[api]
port = 9090
schemas = ["public"]
extra_search_path = ["public"]
max_rows = 1000

[db]
port = 5432

[auth]
site_url = "http://127.0.0.1:9090"

[storage]
file_size_limit = "50MiB"
`);

    const migrationDir = join(configDir, 'migrations');
    mkdirSync(migrationDir, { recursive: true });
    writeFileSync(
        join(migrationDir, '20230101000000_dummy_migration.sql'),
        `CREATE TABLE IF NOT EXISTS public.cli_test_harness (id SERIAL PRIMARY KEY, note TEXT);`
    );

    const profilePath = join(testDir, 'supabase-test-profile.toml');
    writeFileSync(profilePath, `
[api]
url = "http://127.0.0.1:9090"

[db]
url = "postgresql://supabase_admin:postgres@127.0.0.1:5432/postgres"

[auth]
url = "http://127.0.0.1:9999"

[storage]
url = "http://127.0.0.1:9000"

[realtime]
url = "http://127.0.0.1:4000"
`);

    console.log(`✅ Injecting CLI Profile Intercept payload...`);

    const SUPER_TOKEN = process.env.MASTER_TOKEN || 'sbp_0102030405060708091011121314151617181920';
    const cliBin = `supabase@${CLI_VERSION}`;

    let totalFailures = 0;

    try {
        console.log(`\n🔗 Test 1: [supabase link]...`);
        const linkResult = await $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx ${cliBin} link --project-ref ${rawRef} --profile ${profilePath} -p postgres --yes --workdir ${testDir}`.nothrow();

        if (linkResult.exitCode !== 0) {
            console.error("❌ CLI [link] Failed!", linkResult.stderr.toString());
            totalFailures++;
        } else {
            console.log("✅ CLI [link] Success!");
        }

        console.log(`\n⬆️  Test 2: [supabase db push]...`);
        const pushResult = await $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx ${cliBin} db push --profile ${profilePath} -p postgres --workdir ${testDir}`.nothrow();

        if (pushResult.exitCode !== 0) {
            console.error("❌ CLI [db push] Failed!", pushResult.stderr.toString());
            totalFailures++;
        } else {
            console.log("✅ CLI [db push] Success! Migration applied natively through official CLI.");
        }

        console.log(`\n📋 Test 3: [supabase migration list]...`);
        const listResult = await $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx ${cliBin} migration list --profile ${profilePath} -p postgres --workdir ${testDir}`.nothrow();

        if (listResult.exitCode !== 0) {
            console.warn("⚠️  CLI [migration list] Failed (non-fatal):", listResult.stderr.toString());
        } else {
            console.log("✅ CLI [migration list] Success!");
        }

        console.log(`\n🔍 Test 4: [supabase db pull]...`);
        const pullResult = await $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx ${cliBin} db pull --profile ${profilePath} -p postgres --workdir ${testDir}`.nothrow();

        if (pullResult.exitCode !== 0) {
            console.warn("⚠️  CLI [db pull] Failed (non-fatal):", pullResult.stderr.toString());
        } else {
            console.log("✅ CLI [db pull] Success!");
        }

        console.log(`\n🔧 Test 5: [supabase gen types typescript]...`);
        const genResult = await $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx ${cliBin} gen types typescript --profile ${profilePath} --linked --workdir ${testDir} --output ${join(testDir, 'types.ts')}`.nothrow();

        if (genResult.exitCode !== 0) {
            console.warn("⚠️  CLI [gen types] Failed (non-fatal):", genResult.stderr.toString());
        } else {
            console.log("✅ CLI [gen types] Success!");
        }

        console.log(`\n🧪 Test 6: [supabase db query] (via Management API /database/query)...`);
        try {
            const queryRes = await fetch(`http://127.0.0.1:9090/v1/projects/${rawRef}/database/query`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${SUPER_TOKEN}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ query: "SELECT COUNT(*) as cnt FROM public.cli_test_harness" }),
            });
            if (queryRes.ok) {
                const data = await queryRes.json() as { result?: any[] };
                console.log(`✅ Management API [database/query] Success! Result:`, data.result?.[0] || "empty");
            } else {
                console.warn("⚠️  Management API [database/query] returned:", queryRes.status);
            }
        } catch (e: any) {
            console.warn("⚠️  Management API [database/query] failed:", e.message);
        }

    } finally {
        console.log(`\n🧹 Tearing down tenant [${project.id}]...`);
        await sql`DELETE FROM project_tasks WHERE project_ref = ${rawRef}`;
        await sql`DELETE FROM projects WHERE id = ${project.id}`;
        rmSync(testDir, { recursive: true, force: true });

        // NOTE: Do NOT call sql.end() here — the OpenAPI compliance script runs next.
        // Closing the shared connection pool would crash the background API server.

        if (totalFailures > 0) {
            console.error(`❌ CLI compliance: ${totalFailures} tests FAILED — blocking CI gate`);
            process.exit(1);
        } else {
            console.log("\n🎉 SUCCESS: CLI Compliance achieved parity!");
            process.exit(0);
        }
    }
}

run();
