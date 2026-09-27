import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseService, EMBEDDED_SUPABASE_SCHEMA } from "../../src/services/database.service";
import { sql, getProjectDb, generateDbName, removeProjectDbCache } from "../../src/db";

const service = new DatabaseService();
const internal = service as unknown as { loadSupabaseSchema(): Promise<string> };
const schema = await internal.loadSupabaseSchema();
assert.equal(schema, EMBEDDED_SUPABASE_SCHEMA);
assert.ok(schema.includes("CREATE TABLE IF NOT EXISTS storage.objects"));
const digest = createHash("sha256").update(schema).digest("hex");

if (process.argv.includes("--schema-only")) {
  console.log(JSON.stringify({ embeddedSchema: true, sha256: digest }));
} else {
  assert.equal(process.env.SUPACLOUD_BOOTSTRAP_TEST, "1", "Explicit test database opt-in required");
  const ref = `boot${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const dbName = generateDbName(ref);
  const password = service.generatePassword();
  const load = internal.loadSupabaseSchema;
  try {
    // Fail after all schema statements, before ownership/grants/receipt commit.
    internal.loadSupabaseSchema = async () => `${schema}\nSELECT 1 / 0;`;
    const failed = await service.createDatabase(ref, password);
    assert.equal(failed.success, false);
    assert.ok(failed.error?.includes("division by zero"), failed.error);
    const tenant = getProjectDb(dbName);
    const [absent] = await tenant`
      SELECT to_regclass('auth.users') IS NULL AS auth_absent,
        to_regclass('storage.objects') IS NULL AS storage_absent,
        to_regclass('supacloud_platform.bootstrap_state') IS NULL AS receipt_absent
    `;
    assert.deepEqual({ ...absent }, { auth_absent: true, storage_absent: true, receipt_absent: true });
    // The schema call succeeds; ownership repair is a later SQL call in the
    // same transaction. Its failure must also undo the earlier schema call.
    internal.loadSupabaseSchema = async () => `${schema}
      CREATE FUNCTION public.bootstrap_reject_ownership() RETURNS event_trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'bootstrap follow-up failure'; END $$;
      CREATE EVENT TRIGGER bootstrap_reject_ownership ON ddl_command_start
        WHEN TAG IN ('ALTER SCHEMA') EXECUTE FUNCTION public.bootstrap_reject_ownership();
    `;
    const laterFailure = await service.createDatabase(ref, password);
    assert.equal(laterFailure.success, false);
    assert.ok(laterFailure.error?.includes("bootstrap follow-up failure"), laterFailure.error);
    const [laterAbsent] = await tenant`
      SELECT to_regclass('auth.users') IS NULL AS auth_absent,
        to_regclass('storage.objects') IS NULL AS storage_absent,
        to_regclass('supacloud_platform.bootstrap_state') IS NULL AS receipt_absent,
        NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${`authenticator_${ref}`}) AS role_absent
    `;
    assert.deepEqual({ ...laterAbsent }, {
      auth_absent: true, storage_absent: true, receipt_absent: true, role_absent: true,
    });
    internal.loadSupabaseSchema = load;
    const retried = await service.createDatabase(ref, password);
    assert.equal(retried.success, true, retried.error);
    const [receipt] = await tenant`SELECT schema_version FROM supacloud_platform.bootstrap_state WHERE singleton`;
    assert.equal(receipt.schema_version, "2026-09-27");
    await tenant`CREATE TABLE public.bootstrap_fixture(id integer PRIMARY KEY)`;
    await tenant`INSERT INTO public.bootstrap_fixture VALUES (42)`;
    const repeated = await service.createDatabase(ref, password);
    assert.equal(repeated.success, true, repeated.error);
    const [data] = await tenant`SELECT id FROM public.bootstrap_fixture`;
    assert.equal(data.id, 42);
    await tenant`DROP TABLE supacloud_platform.bootstrap_state`;
    const legacy = await service.createDatabase(ref, password);
    assert.equal(legacy.success, true, legacy.error);
    await tenant`ALTER TABLE auth.users OWNER TO postgres`;
    const incompleteLegacy = await service.createDatabase(ref, password);
    assert.equal(incompleteLegacy.success, false);
    assert.ok(incompleteLegacy.error?.includes("ownership or grants"));
    console.log(JSON.stringify({ embeddedSchema: true, sha256: digest,
      rollback: true, crossStatementRollback: true, retry: true,
      repeatedProvisioningPreservesData: true, legacyOwnershipChecked: true }));
  } finally {
    internal.loadSupabaseSchema = load;
    await removeProjectDbCache(dbName);
    // Only the randomly named database and roles allocated by this fixture.
    await sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await sql.unsafe(`DROP ROLE IF EXISTS "authenticator_${ref}"`);
    await sql.unsafe(`DROP ROLE IF EXISTS "role_${ref}"`);
    await sql.close();
  }
}
