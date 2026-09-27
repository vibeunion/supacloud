import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { startStarterPostgres } from "../../../../scripts/lib/starter-postgres";
import { ALTER_TENANT_SQL } from "../../src/services/tenant-runtime-migration";

const bin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;

test.skipIf(!bin)("Realtime prerequisites permit publication creation and JWT-role RLS evaluation", async () => {
  const database = await startStarterPostgres(bin!);
  try {
    await database.exec(`
      CREATE ROLE supabase_admin NOLOGIN NOINHERIT REPLICATION;
      CREATE ROLE supabase_realtime_admin NOLOGIN NOINHERIT;
      CREATE ROLE anon NOLOGIN NOINHERIT;
      CREATE ROLE authenticated NOLOGIN NOINHERIT;
      CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      REVOKE CREATE ON DATABASE postgres FROM PUBLIC;
      CREATE TABLE public.cdc_fixture(owner_id text, marker text);
      INSERT INTO public.cdc_fixture VALUES ('owner', 'visible'), ('other', 'hidden');
      ALTER TABLE public.cdc_fixture ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA public TO authenticated;
      GRANT SELECT ON public.cdc_fixture TO authenticated;
      CREATE POLICY own_rows ON public.cdc_fixture FOR SELECT TO authenticated
        USING (owner_id = current_setting('request.jwt.claim.sub', true));
    `);
    const schema = readFileSync(new URL("../../src/db/schemas/supabase.sql", import.meta.url), "utf8");
    const usage = schema.match(/GRANT USAGE ON SCHEMA public TO supabase_admin, supabase_realtime_admin;/)?.[0];
    const membership = schema.match(/GRANT anon, authenticated, service_role TO supabase_admin WITH INHERIT FALSE, SET TRUE;/)?.[0];
    const create = ALTER_TENANT_SQL.match(/DO \$\$ BEGIN\s+EXECUTE format\('GRANT CREATE ON DATABASE %I TO supabase_admin', current_database\(\)\);\s+END \$\$;/)?.[0];
    expect(usage).toBeDefined();
    expect(membership).toBeDefined();
    expect(create).toBeDefined();
    for (let attempt = 0; attempt < 2; attempt++) {
      await database.exec(`${usage}\n${membership}\n${create}`);
    }
    await database.exec(`
      DO $$ BEGIN
        IF NOT has_database_privilege('supabase_admin', current_database(), 'CREATE')
          OR NOT has_schema_privilege('supabase_admin', 'public', 'USAGE') THEN
          RAISE EXCEPTION 'Realtime publication prerequisites missing';
        END IF;
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_admin'
          AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit)) THEN
          RAISE EXCEPTION 'Unrelated role attributes changed';
        END IF;
        IF EXISTS (SELECT FROM pg_auth_members
          WHERE member = 'supabase_admin'::regrole AND roleid = 'authenticated'::regrole
            AND (inherit_option OR NOT set_option)) THEN
          RAISE EXCEPTION 'JWT-role membership options are wrong';
        END IF;
      END $$;
      SET SESSION AUTHORIZATION supabase_admin;
      CREATE PUBLICATION realtime_fixture;
      SELECT set_config('role', 'authenticated', true);
      SELECT set_config('request.jwt.claim.sub', 'owner', true);
      DO $$ BEGIN
        IF (SELECT count(*) FROM public.cdc_fixture) <> 1
          OR (SELECT marker FROM public.cdc_fixture) <> 'visible' THEN
          RAISE EXCEPTION 'Realtime JWT-role RLS evaluation failed';
        END IF;
      END $$;
      RESET ROLE;
      RESET SESSION AUTHORIZATION;
    `);
  } finally {
    await database.close();
  }
}, 60_000);
