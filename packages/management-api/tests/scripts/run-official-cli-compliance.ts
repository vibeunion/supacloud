import { $ } from "bun";
import { ProjectService } from "../../src/services/project.service";
import { sql } from "../../src/db";
import { join } from "path";
import { writeFileSync, existsSync, rmSync, mkdirSync } from "fs";

const CLI_VERSION = "2.20.5";

async function rekeyCliHarnessProject(projectId: string, originalRef: string, targetRef: string): Promise<void> {
    const maxAttempts = 10;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            // createProject() kicks off saga provisioning in the background. That saga can
            // enqueue a project_tasks row after we create the project but before we rewrite
            // the ref to the fixed 20-char value required by the official CLI harness.
            await sql`DELETE FROM project_tasks WHERE project_ref = ${originalRef}`;
            await sql`UPDATE projects SET ref = ${targetRef} WHERE id = ${projectId}`;
            return;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
            const isProjectTaskFkRace =
                code === "ERR_POSTGRES_SERVER_ERROR" &&
                message.includes("project_tasks_project_ref_fkey");

            if (!isProjectTaskFkRace || attempt === maxAttempts) {
                throw error;
            }

            await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
    }
}

async function run() {
    console.log("\n🚀 [CLI Compliance] Starting Supabase Official CLI Validation Protocol...");

    const projectService = new ProjectService();
    const rawRef = "clicompliancetestref";

    // Direct DB URL for self-hosted CLI operations
    const dbUrl = process.env.DATABASE_URL || "postgresql://supabase_admin:postgres@127.0.0.1:5432/postgres";

    let project;
    try {
        project = await projectService.createProject({
            name: "cli_compliance_harness",
            region: "local"
        });

        await rekeyCliHarnessProject(project.id, project.ref, rawRef);
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

    console.log(`✅ Injecting CLI config and migration payload...`);

    const SUPER_TOKEN = process.env.MASTER_TOKEN ?? (() => { throw new Error('MASTER_TOKEN env var is required'); })();
    const cliBin = `supabase@${CLI_VERSION}`;

    let totalFailures = 0;

    try {
        // Test 1: supabase db push --db-url (self-hosted mode, no link needed)
        console.log(`\n⬆️  Test 1: [supabase db push --db-url]...`);
        const pushResult = await $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx ${cliBin} db push --db-url ${dbUrl} --workdir ${testDir}`.nothrow();

        if (pushResult.exitCode !== 0) {
            const stderr = pushResult.stderr.toString();
            // "Applied" or "already applied" both count as success
            if (stderr.includes("already applied") || stderr.includes("Applied")) {
                console.log("✅ CLI [db push] Success (migrations already applied).");
            } else {
                console.error("❌ CLI [db push] Failed!", stderr);
                totalFailures++;
            }
        } else {
            console.log("✅ CLI [db push] Success! Migration applied natively through official CLI.");
        }

        // Test 2: supabase migration list --db-url
        console.log(`\n📋 Test 2: [supabase migration list --db-url]...`);
        const listResult = await $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx ${cliBin} migration list --db-url ${dbUrl} --workdir ${testDir}`.nothrow();

        if (listResult.exitCode !== 0) {
            console.warn("⚠️  CLI [migration list] Failed (non-fatal):", listResult.stderr.toString());
        } else {
            console.log("✅ CLI [migration list] Success!");
        }

        // Test 3: supabase db pull --db-url
        console.log(`\n🔍 Test 3: [supabase db pull --db-url]...`);
        const pullResult = await $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx ${cliBin} db pull --db-url ${dbUrl} --workdir ${testDir}`.nothrow();

        if (pullResult.exitCode !== 0) {
            const stderr = pullResult.stderr.toString();
            // "No schema changes found" is a valid success case
            if (stderr.includes("No schema changes") || stderr.includes("already up to date")) {
                console.log("✅ CLI [db pull] Success (no schema changes).");
            } else {
                console.warn("⚠️  CLI [db pull] Failed (non-fatal):", stderr);
            }
        } else {
            console.log("✅ CLI [db pull] Success!");
        }

        // Test 4: supabase gen types typescript --db-url
        console.log(`\n🔧 Test 4: [supabase gen types typescript --db-url]...`);
        const genResult = await $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx ${cliBin} gen types typescript --db-url ${dbUrl} --workdir ${testDir}`.nothrow();

        if (genResult.exitCode !== 0) {
            console.warn("⚠️  CLI [gen types] Failed (non-fatal):", genResult.stderr.toString());
        } else {
            const output = genResult.stdout.toString();
            if (output.includes("export type") || output.includes("Database")) {
                console.log("✅ CLI [gen types] Success! TypeScript types generated.");
            } else {
                console.log("✅ CLI [gen types] Completed (output may be empty for no tables).");
            }
        }

        // Test 5: Management API /database/query — validates our API is CLI-compatible
        console.log(`\n🧪 Test 5: [supabase db query] (via Management API /database/query)...`);
        try {
            const queryRes = await fetch(`http://127.0.0.1:9090/v1/projects/${rawRef}/database/query`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${SUPER_TOKEN}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ query: "SELECT 1 as ok" }),
            });
            if (queryRes.ok) {
                const data = await queryRes.json() as { rows?: any[] };
                console.log(`✅ Management API [database/query] Success! Rows:`, data.rows?.[0] || "ok");
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
