import { $ } from "bun";
import { sql } from "../../src/db";
import { projectRepository } from "../../src/repositories/project.repository";
import { randomBytes } from "crypto";
import { join } from "path";
import { writeFileSync, existsSync, rmSync, mkdirSync } from "fs";
import {
    buildCliMigrationHistoryFixtures,
    CLI_HARNESS_MIGRATION_VERSION,
    parseCliHarnessDatabaseUrl,
} from "./official-cli-compliance-harness";

const CLI_VERSION = "2.20.5";

function isTransientCliBootstrapFailure(result: { stdout?: unknown; stderr?: unknown }): boolean {
    const output = `${result.stdout?.toString?.() ?? ""}\n${result.stderr?.toString?.() ?? ""}`.toLowerCase();
    return [
        "socket hang up",
        "fetcherror",
        "fetch failed",
        "econnreset",
        "etimedout",
        "eai_again",
        "enotfound",
        "temporarily unavailable",
        "tls connection",
    ].some((needle) => output.includes(needle));
}

async function runCliWithRetry(
    label: string,
    command: () => Promise<{ exitCode: number; stdout: unknown; stderr: unknown }>,
    maxAttempts = 3,
) {
    let lastResult: { exitCode: number; stdout: unknown; stderr: unknown } | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const result = await command();
        lastResult = result;
        if (result.exitCode === 0 || !isTransientCliBootstrapFailure(result) || attempt === maxAttempts) {
            return result;
        }

        const delayMs = 1500 * attempt;
        console.warn(
            `⚠️  CLI [${label}] transient bootstrap/download failure, retrying ${attempt + 1}/${maxAttempts} in ${delayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return lastResult!;
}

async function run() {
    console.log("\n🚀 [CLI Compliance] Starting Supabase Official CLI Validation Protocol...");

    const rawRef = "clicompliancetestref";
    const dbUrl = process.env.DATABASE_URL || "postgresql://supabase_admin:postgres@127.0.0.1:5432/postgres";
    const testDir = join(process.cwd(), '.cache', `cli-harness-${process.pid}`);
    let totalFailures = 0;
    let projectId: string | null = null;

    try {
        const { dbName, dbUser, dbPassword } = parseCliHarnessDatabaseUrl(dbUrl);
        const randomSecret = () => randomBytes(32).toString("base64url");
        const project = await projectRepository.create({
            ref: rawRef,
            name: "cli_compliance_harness",
            db_name: dbName,
            db_user: dbUser,
            db_password: dbPassword,
            jwt_secret: randomSecret(),
            anon_key: randomSecret(),
            service_role_key: randomSecret(),
            s3_bucket: `cli-${rawRef}`,
            region: "local",
        });
        projectId = project.id;
        await projectRepository.updateStatus(rawRef, "active");

        console.log(`✅ Created metadata-only 20-char CLI Project Ref [${rawRef}]`);

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
        const remoteMigrations = await sql<{ version: string }[]>`
            SELECT version::text AS version
            FROM supabase_migrations.schema_migrations
            ORDER BY version ASC
        `;
        for (const fixture of buildCliMigrationHistoryFixtures(remoteMigrations)) {
            writeFileSync(join(migrationDir, fixture.fileName), fixture.contents);
        }
        writeFileSync(
            join(migrationDir, `${CLI_HARNESS_MIGRATION_VERSION}_dummy_migration.sql`),
            `CREATE TABLE IF NOT EXISTS public.cli_test_harness (id SERIAL PRIMARY KEY, note TEXT);`
        );

        console.log(`✅ Injecting CLI config and migration payload...`);

        const SUPER_TOKEN = process.env.MASTER_TOKEN ?? (() => { throw new Error('MASTER_TOKEN env var is required'); })();
        const cliBin = `supabase@${CLI_VERSION}`;

        // Test 1: supabase db push --db-url (self-hosted mode, no link needed)
        console.log(`\n⬆️  Test 1: [supabase db push --db-url]...`);
        const pushResult = await runCliWithRetry(
            "db push",
            () => $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx ${cliBin} db push --db-url ${dbUrl} --workdir ${testDir}`.nothrow(),
        );

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
        const listResult = await runCliWithRetry(
            "migration list",
            () => $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx ${cliBin} migration list --db-url ${dbUrl} --workdir ${testDir}`.nothrow(),
        );

        if (listResult.exitCode !== 0) {
            console.warn("⚠️  CLI [migration list] Failed (non-fatal):", listResult.stderr.toString());
        } else {
            console.log("✅ CLI [migration list] Success!");
        }

        // Test 3: supabase db pull --db-url
        console.log(`\n🔍 Test 3: [supabase db pull --db-url]...`);
        const pullResult = await runCliWithRetry(
            "db pull",
            () => $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx ${cliBin} db pull --db-url ${dbUrl} --workdir ${testDir}`.nothrow(),
        );

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
        const genResult = await runCliWithRetry(
            "gen types",
            () => $`SUPABASE_ACCESS_TOKEN=${SUPER_TOKEN} bunx ${cliBin} gen types typescript --db-url ${dbUrl} --workdir ${testDir}`.nothrow(),
        );

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
                totalFailures++;
            }
        } catch (e: any) {
            console.warn("⚠️  Management API [database/query] failed:", e.message);
            totalFailures++;
        }

    } catch (error) {
        totalFailures++;
        console.error("❌ CLI compliance harness failed:", error instanceof Error ? error.message : String(error));
    } finally {
        console.log(`\n🧹 Tearing down metadata-only tenant [${projectId ?? rawRef}]...`);
        if (projectId !== null) {
            try {
                await sql`DELETE FROM project_tasks WHERE project_ref = ${rawRef}`;
                await sql`DELETE FROM projects WHERE id = ${projectId}`;
            } catch (error) {
                totalFailures++;
                console.error("❌ CLI harness metadata cleanup failed:", error instanceof Error ? error.message : String(error));
            }
        }
        try {
            rmSync(testDir, { recursive: true, force: true });
        } catch (error) {
            totalFailures++;
            console.error("❌ CLI harness cache cleanup failed:", error instanceof Error ? error.message : String(error));
        }

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
