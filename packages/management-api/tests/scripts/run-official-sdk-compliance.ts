import { $ } from "bun";
import { ProjectService } from "../../src/services/project.service";
import { randomUUID } from "crypto";
import { sql, getProjectDb, resolveDbName, invalidateDbNameCache } from "../../src/db";
import { join } from "path";
import {
  existsSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
} from "fs";
import { tmpdir } from "os";

const OFFICIAL_ANON_KEY =
  process.env.TEST_SUPABASE_ANON_KEY ?? "anon-key-not-set";
const OFFICIAL_SERVICE_ROLE_KEY =
  process.env.TEST_SUPABASE_SERVICE_KEY ?? "service-key-not-set";
const OFFICIAL_JWT_SECRET =
  "super-secret-jwt-token-with-at-least-32-characters-long";

async function bootstrap() {
  console.log(
    "\n🚀 [Phase 1] Bootstrapping Official Supabase-JS Test Harness...",
  );

  const projectService = new ProjectService();
  const tenantName = `sdkhijack${randomUUID().replace(/-/g, '').substring(0, 8)}`;

  const project = await projectService.createProject({
    name: tenantName,
    region: "local",
  });

  await sql`
        UPDATE projects
        SET anon_key = ${OFFICIAL_ANON_KEY},
            service_role_key = ${OFFICIAL_SERVICE_ROLE_KEY},
            jwt_secret = ${OFFICIAL_JWT_SECRET}
        WHERE ref = ${project.ref}
    `;

  console.log(
    `✅ Provisioned Test Tenant [${project.ref}] with hijacked keys.`,
  );

  await new Promise((r) => setTimeout(r, 2000));

  console.log(
    "🌉 Wiring test tenant to shared CI containers (CI Tenant Bridge)...",
  );
  try {
    // Wire the SDK test tenant to the shared CI containers first so all later
    // schema/storage seeding targets the real shared CI database context.
    await sql`
            UPDATE projects
            SET db_name = 'postgres',
                db_user = 'supabase_admin',
                db_password = 'postgres',
                status = 'active',
                config = COALESCE(config, '{}'::jsonb) || jsonb_build_object(
                  'postgrest_port', 3000,
                  'gotrue_port', 9999,
                  'realtime_port', 4000
                )
            WHERE ref = ${project.ref}
        `;
    invalidateDbNameCache(project.ref);
    // Register Realtime tenant so WebSocket subscriptions work
    try {
      const { RealtimeService } = await import("../../src/services/realtime.service");
      const realtimeService = new RealtimeService();
      await realtimeService.ensureSupabaseAdminReplication();
      let registered = false;
      for (let attempt = 1; attempt <= 5; attempt++) {
        registered = await realtimeService.registerTenant({
          projectRef: project.ref,
          dbName: "postgres",
          dbUser: "supabase_admin",
          dbPassword: "postgres",
          jwtSecret: OFFICIAL_JWT_SECRET,
        });
        if (registered) break;
        console.warn(`[SDK Compliance] Realtime registration attempt ${attempt}/5 failed, retrying in 2s...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (registered) {
        console.log(`✅ Realtime tenant registered for [${project.ref}]`);
      } else {
        console.warn(`⚠️ Realtime tenant registration failed for [${project.ref}] after 5 attempts`);
      }
    } catch (e: any) {
      console.warn("⚠️ Realtime tenant registration error:", e.message?.substring(0, 80));
    }
    console.log(
      `✅ CI Bridge active: tenant ${project.ref} → PostgREST:3000, GoTrue:9999, Realtime:4000`,
    );
  } catch (err: any) {
    console.warn(
      "⚠️ CI Bridge wiring failed (continuing):",
      err.message?.substring(0, 120),
    );
  }

  console.log("📦 Applying official SDK schema (same as supabase-js migrations)...");
  try {
    const dbName = await resolveDbName(project.ref);
    const projectDb = getProjectDb(dbName);
    // Match official supabase-js migration: 20250422000000_create_todos_table.sql
    await projectDb`DROP TABLE IF EXISTS public.todos CASCADE`;
    await projectDb`CREATE TABLE IF NOT EXISTS public.todos (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task TEXT NOT NULL, is_complete BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), user_id UUID REFERENCES auth.users(id))`;
    await projectDb`ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY`;
    await projectDb`CREATE POLICY "Allow anonymous read access" ON public.todos FOR SELECT TO anon USING (true)`;
    await projectDb`CREATE POLICY "Allow anonymous insert access" ON public.todos FOR INSERT TO anon WITH CHECK (true)`;
    await projectDb`CREATE POLICY "Allow anonymous delete access" ON public.todos FOR DELETE TO anon USING (true)`;
    await projectDb`CREATE POLICY "Allow authenticated read own todos" ON public.todos FOR SELECT TO authenticated USING (auth.uid() = user_id)`;
    await projectDb`CREATE POLICY "Allow authenticated insert own todos" ON public.todos FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)`;
    await projectDb`CREATE POLICY "Allow authenticated update own todos" ON public.todos FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)`;
    await projectDb`CREATE POLICY "Allow authenticated delete own todos" ON public.todos FOR DELETE TO authenticated USING (auth.uid() = user_id)`;
    await projectDb`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role`;

    // Add Realtime RLS policies required by the broadcast test
    try {
      await projectDb`CREATE POLICY "authenticated can read all messages on topic" ON "realtime"."messages" FOR SELECT TO authenticated USING ( realtime.topic() like '%channel%' )`;
      await projectDb`CREATE POLICY "authenticated can insert messages on topic" ON "realtime"."messages" FOR INSERT TO authenticated WITH CHECK (realtime.topic() like '%channel%')`;
      await projectDb`CREATE POLICY "anon can read all messages on topic" ON "realtime"."messages" FOR SELECT TO anon USING ( realtime.topic() like '%channel%' )`;
      await projectDb`CREATE POLICY "anon can insert messages on topic" ON "realtime"."messages" FOR INSERT TO anon WITH CHECK (realtime.topic() like '%channel%')`;
      
      await projectDb`GRANT USAGE ON SCHEMA realtime TO postgres, anon, authenticated, service_role`;
      await projectDb`GRANT ALL ON ALL TABLES IN SCHEMA realtime TO postgres, anon, authenticated, service_role`;
      await projectDb`GRANT ALL ON ALL ROUTINES IN SCHEMA realtime TO postgres, anon, authenticated, service_role`;
      await projectDb`GRANT ALL ON ALL SEQUENCES IN SCHEMA realtime TO postgres, anon, authenticated, service_role`;
      
      console.log("✅ Realtime RLS policies and grants applied.");
    } catch (e: any) {
      console.warn("⚠️ Realtime RLS policies skipped:", e.message?.substring(0, 80));
    }
    await projectDb`GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO anon, authenticated, service_role`;
    // Storage: seed logical bucket metadata in the bridged/shared database.
    try {
      await projectDb`INSERT INTO storage.buckets (id, name, public) VALUES ('test-bucket', 'test-bucket', false) ON CONFLICT (id) DO NOTHING`;
    } catch (_) {}
    // Create the physical S3/MinIO bucket after the tenant bridge is active.
    try {
      const { StorageService } = await import("../../src/services/storage.service");
      const s3Result = await StorageService.createBucket(project.ref);
      if (!s3Result.success) {
        console.warn("[SDK Compliance] S3 bucket creation warning:", s3Result.error);
      } else {
        console.log("✅ S3 physical bucket created for", project.ref);
      }
    } catch (e: any) {
      console.warn("[SDK Compliance] S3 bucket creation skipped:", e.message?.substring(0, 80));
    }
    await projectDb`NOTIFY pgrst, 'reload schema'`;
    console.log("✅ Official SDK schema applied to project database:", dbName);
  } catch (e: any) {
    console.warn("DB schema injection err (ignoring):", e.message);
  }

  // Clone to /tmp to completely isolate from parent project's node_modules.
  // TypeScript walks up parent directories resolving types, and cloning inside
  // our project tree causes bun-types (from workspace root) to pollute globals.
  const targetDir = join(tmpdir(), "supacloud-sdk-test");
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }

  console.log(
    "📥 Downloading @supabase/supabase-js master branch to memory cache...",
  );
  await $`git clone --depth 1 https://github.com/supabase/supabase-js.git ${targetDir}`.quiet();

  console.log("💉 Altering test bindings to target supacloud proxy at 9090...");
  const possibleTestPaths = [
    join(targetDir, "packages/core/supabase-js/test/integration.test.ts"),
    join(targetDir, "test/integration.test.ts"),
    join(targetDir, "packages/supabase-js/test/integration.test.ts"),
  ];

  let testFilePath: string | null = null;
  for (const p of possibleTestPaths) {
    if (existsSync(p)) {
      testFilePath = p;
      break;
    }
  }

  if (testFilePath) {
    let testContent = readFileSync(testFilePath, "utf8");
    testContent = testContent.replace(
      /http:\/\/127\.0\.0\.1:54321/g,
      "http://127.0.0.1:9090",
    );
    testContent = testContent.replace(
      /http:\/\/localhost:54321/g,
      "http://127.0.0.1:9090",
    );
    testContent = testContent.replace(
      "    wsTransport = require('ws')",
      "    wsTransport = require('ws')\n    ;(globalThis as any).WebSocket ??= wsTransport",
    );
    writeFileSync(testFilePath, testContent, "utf8");
    console.log(`✅ Patched test file: ${testFilePath}`);
  } else {
    console.warn(
      "⚠️ Official test file location changed! Attempting directory scan...",
    );
    try {
      const findResult =
        await $`find ${targetDir} -name "integration.test.ts" -type f`.quiet();
      const found = findResult.text().trim().split("\n").filter(Boolean);
      if (found.length > 0) {
        let testContent = readFileSync(found[0], "utf8");
        testContent = testContent.replace(
          /http:\/\/127\.0\.0\.1:54321/g,
          "http://127.0.0.1:9090",
        );
        testContent = testContent.replace(
          /http:\/\/localhost:54321/g,
          "http://127.0.0.1:9090",
        );
        testContent = testContent.replace(
          "    wsTransport = require('ws')",
          "    wsTransport = require('ws')\n    ;(globalThis as any).WebSocket ??= wsTransport",
        );
        writeFileSync(found[0], testContent, "utf8");
        console.log(`✅ Patched discovered test file: ${found[0]}`);
      } else {
        console.error(
          "❌ Could not find any integration.test.ts in the cloned repo!",
        );
      }
    } catch {
      console.error("❌ Failed to scan for test files.");
    }
  }

  console.log("📦 Installing test dependencies inside the hijacked capsule...");
  try {
    // supabase-js is a monorepo — we need to install and build all workspaces
    await $`cd ${targetDir} && npm install --no-fund --no-audit`.quiet();
    await $`cd ${targetDir} && npm install --no-save --no-fund --no-audit ws@^8`.quiet();
    await $`cd ${targetDir} && npm run build --workspaces --if-present`
      .quiet()
      .nothrow();
  } catch (e: any) {
    console.warn(
      "⚠️ Workspace build partial failure (continuing):",
      e.message?.substring(0, 120),
    );
  }

  console.log("🔥 Launching Supabase Official Integration Payload...");
  let testExitCode = 0;
  try {
    // Try monorepo workspace path first, fall back to root
    const workspacePaths = [
      join(targetDir, "packages/core/supabase-js"),
      join(targetDir, "packages/supabase-js"),
      targetDir,
    ];
    let testCwd = targetDir;
    for (const p of workspacePaths) {
      if (existsSync(join(p, "test", "integration.test.ts"))) {
        testCwd = p;
        break;
      }
    }
    const testResult =
      await $`cd ${testCwd} && SUPABASE_URL=http://127.0.0.1:9090 SUPABASE_ANON_KEY=${OFFICIAL_ANON_KEY} SUPABASE_SERVICE_ROLE_KEY=${OFFICIAL_SERVICE_ROLE_KEY} npx jest test/integration.test.ts --no-cache --forceExit`.nothrow();
    testExitCode = testResult.exitCode;
    console.log(`📋 Test exit code: ${testExitCode}`);
  } catch (err) {
    console.error("❌ Test suite encountered an error.", err);
    testExitCode = 1;
  } finally {
    console.log(
      `\n🧹 Tearing down tenant [${project.ref}] and wiping cache...`,
    );
    await projectService.deleteProject(project.ref);
    rmSync(targetDir, { recursive: true, force: true });

    // NOTE: Do NOT call sql.end() here — this script runs mid-pipeline.
    // Closing the shared connection pool would crash the background API server
    // and poison subsequent test phases (CLI compliance, OpenAPI crawler).

    if (testExitCode !== 0) {
      console.error(
        "❌ SDK parity compliance: some tests FAILED — blocking CI gate",
      );
      process.exit(1);
    } else {
      console.log("✅ SDK parity compliance: all tests passed");
      process.exit(0);
    }
  }
}

bootstrap();
