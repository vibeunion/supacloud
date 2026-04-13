/**
 * CI Tenant Bridge
 *
 * Creates a persistent test tenant wired to the shared CI service containers
 * (PostgREST:3000, GoTrue:9999). The official Supabase demo JWT keys are signed
 * with the same secret used by the CI containers, so they work out of the box.
 *
 * This is idempotent — safe to run multiple times.
 *
 * Architecture:
 *   SDK request → Management API sdk-proxy
 *     → looks up project_config → finds {pgrstPort:3000, gotruePort:9999}
 *     → proxies to shared CI containers ✅
 */
import { SQL } from "bun";
import { config } from "../../src/config";

// These are the official Supabase demo keys, signed with CI_JWT_SECRET.
// The CI containers (PostgREST + GoTrue) are configured with the same secret.
export const CI_JWT_SECRET =
  "super-secret-jwt-token-with-at-least-32-characters-long";
export const CI_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
export const CI_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
export const CI_TENANT_REF = "ci_sdk_bridge"; // ≤20 chars, fixed across runs
export const CI_PGRST_PORT = 3000;
export const CI_GOTRUE_PORT = 9999;
export const CI_REALTIME_PORT = 4000;
export const CI_PROXY_URL = "http://127.0.0.1:9090";

/**
 * Set up the CI tenant bridge. Returns the tenant details.
 * Safe to call multiple times (idempotent).
 */
export async function setupCiBridge(sql: InstanceType<typeof SQL>): Promise<{
  ref: string;
  anonKey: string;
  serviceKey: string;
  jwtSecret: string;
  pgrstPort: number;
  gotruePort: number;
}> {
  console.log(
    `[CIBridge] Setting up CI tenant bridge → ref=${CI_TENANT_REF}...`,
  );

  // 1. Ensure a default organization exists (required by FK if project has org_id)
  await sql`
    INSERT INTO organizations (id, name, slug)
    VALUES ('00000000-0000-0000-0000-000000000001', 'CI Org', 'ci-org')
    ON CONFLICT (id) DO NOTHING
  `;

  // 2. Upsert the CI test project
  await sql`
    INSERT INTO projects (
      ref, name, db_name, db_user, db_password,
      jwt_secret, anon_key, service_role_key,
      s3_bucket, region, status, config
    )
    VALUES (
      ${CI_TENANT_REF},
      'CI SDK Bridge',
      'postgres',
      'supabase_admin',
      'postgres',
      ${CI_JWT_SECRET},
      ${CI_ANON_KEY},
      ${CI_SERVICE_KEY},
      'ci-sdk-test',
      'local',
      'active',
      '{}'::jsonb
    )
    ON CONFLICT (ref) DO UPDATE SET
      anon_key        = EXCLUDED.anon_key,
      service_role_key = EXCLUDED.service_role_key,
      jwt_secret      = EXCLUDED.jwt_secret,
      db_name         = 'postgres',
      status          = 'active'
  `;

  // 3. Wire to shared CI containers via project_config
  await sql`
    INSERT INTO project_config (project_ref, postgrest_port, gotrue_port, realtime_port)
    VALUES (${CI_TENANT_REF}, ${CI_PGRST_PORT}, ${CI_GOTRUE_PORT}, ${CI_REALTIME_PORT})
    ON CONFLICT (project_ref) DO UPDATE SET
      postgrest_port  = EXCLUDED.postgrest_port,
      gotrue_port     = EXCLUDED.gotrue_port,
      realtime_port   = EXCLUDED.realtime_port,
      updated_at      = NOW()
  `;

  console.log(
    `[CIBridge] project_config wired: PostgREST=${CI_PGRST_PORT}, GoTrue=${CI_GOTRUE_PORT}`,
  );

  // 4. Create test tables in the shared 'postgres' DB
  //    Schema matches the official supabase-js migration EXACTLY:
  //    supabase/supabase-js/packages/core/supabase-js/supabase/migrations/
  const dbUrl = config.databaseUrl;
  const testSql = new SQL({ url: dbUrl, max: 2 });
  try {
    // ── Migration 1: todos table (20250422000000_create_todos_table.sql) ──
    // Drop old table if it exists with wrong schema (SERIAL PK, no user_id)
    await testSql`DROP TABLE IF EXISTS public.todos CASCADE`;

    await testSql`
      CREATE TABLE IF NOT EXISTS public.todos (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task        TEXT        NOT NULL,
        is_complete BOOLEAN     NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_id     UUID REFERENCES auth.users(id)
      )
    `;

    await testSql`ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY`;

    // Allow anonymous users to read all todos (public data)
    await testSql`
      CREATE POLICY "Allow anonymous read access" ON public.todos
        FOR SELECT TO anon USING (true)
    `;
    // Allow anonymous users to insert todos (backward compat with PostgREST tests)
    await testSql`
      CREATE POLICY "Allow anonymous insert access" ON public.todos
        FOR INSERT TO anon WITH CHECK (true)
    `;
    // Allow anonymous users to delete todos (backward compat with PostgREST tests)
    await testSql`
      CREATE POLICY "Allow anonymous delete access" ON public.todos
        FOR DELETE TO anon USING (true)
    `;
    // Allow authenticated users to read their own todos
    await testSql`
      CREATE POLICY "Allow authenticated read own todos" ON public.todos
        FOR SELECT TO authenticated USING (auth.uid() = user_id)
    `;
    // Allow authenticated users to insert their own todos
    await testSql`
      CREATE POLICY "Allow authenticated insert own todos" ON public.todos
        FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)
    `;
    // Allow authenticated users to update their own todos
    await testSql`
      CREATE POLICY "Allow authenticated update own todos" ON public.todos
        FOR UPDATE TO authenticated
        USING (auth.uid() = user_id)
        WITH CHECK (auth.uid() = user_id)
    `;
    // Allow authenticated users to delete their own todos
    await testSql`
      CREATE POLICY "Allow authenticated delete own todos" ON public.todos
        FOR DELETE TO authenticated USING (auth.uid() = user_id)
    `;

    // profiles — used by auth flow tests
    await testSql`
      CREATE TABLE IF NOT EXISTS public.profiles (
        id         UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
        username   TEXT  UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await testSql`ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY`;

    // Grant schema access to PostgREST roles
    await testSql`
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role
    `;
    await testSql`
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON public.todos, public.profiles
        TO anon, authenticated, service_role
    `;

    // ── Migration 2: Realtime RLS (20250423000000_realtime_rls_setup.sql) ──
    // These policies allow the Realtime broadcast tests to subscribe/send
    try {
      await testSql`
        CREATE POLICY "authenticated can read all messages on topic"
        ON "realtime"."messages"
        FOR SELECT TO authenticated
        USING ( realtime.topic() like '%channel%' )
      `;
      await testSql`
        CREATE POLICY "authenticated can insert messages on topic"
        ON "realtime"."messages"
        FOR INSERT TO authenticated
        WITH CHECK (realtime.topic() like '%channel%')
      `;
      console.log("[CIBridge] Realtime RLS policies applied.");
    } catch (e: any) {
      // realtime schema may not exist in all environments — non-fatal
      console.warn("[CIBridge] Realtime RLS policies skipped:", e.message?.substring(0, 80));
    }

    // ── Migration 3: Storage bucket (20250424000000_storage_anon_policy.sql) ──
    try {
      await testSql`
        INSERT INTO storage.buckets (id, name, public)
        VALUES ('test-bucket', 'test-bucket', false)
        ON CONFLICT (id) DO NOTHING
      `;
      console.log("[CIBridge] Storage test-bucket created.");
    } catch (e: any) {
      // storage schema may not exist — non-fatal
      console.warn("[CIBridge] Storage bucket creation skipped:", e.message?.substring(0, 80));
    }

    // Seed data for todos table
    await testSql`
      INSERT INTO public.todos (task, is_complete) VALUES
        ('Buy groceries', false),
        ('Complete project report', true),
        ('Call mom', false),
        ('Schedule dentist appointment', false),
        ('Pay bills', true)
      ON CONFLICT DO NOTHING
    `;

    // 5. Notify PostgREST to refresh its schema cache so it sees the new tables
    await testSql`NOTIFY pgrst, 'reload schema'`;

    console.log(
      "[CIBridge] Test tables created with RLS policies and PostgREST schema cache refreshed.",
    );
  } finally {
    await testSql.close();
  }

  console.log(`[CIBridge] ✅ Bridge ready.
  ref:         ${CI_TENANT_REF}
  anon key:    ${CI_ANON_KEY.slice(0, 40)}...
  PostgREST:   :${CI_PGRST_PORT}
  GoTrue:      :${CI_GOTRUE_PORT}`);

  return {
    ref: CI_TENANT_REF,
    anonKey: CI_ANON_KEY,
    serviceKey: CI_SERVICE_KEY,
    jwtSecret: CI_JWT_SECRET,
    pgrstPort: CI_PGRST_PORT,
    gotruePort: CI_GOTRUE_PORT,
  };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────
// Run directly: `bun run tests/scripts/ci-tenant-bridge.ts`
if (import.meta.main) {
  const { sql } = await import("../../src/db");
  try {
    await setupCiBridge(sql);
    console.log("[CIBridge] Done.");
  } catch (err) {
    console.error("[CIBridge] Failed:", err);
    process.exit(1);
  } finally {
    await sql.close();
  }
}
