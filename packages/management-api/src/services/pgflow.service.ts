import type { SQL } from "bun";
import { PGFLOW_MIGRATIONS } from "../db/pgflow-bundle";
import { executeSqlStatements } from "../db/sql-statements";
import { renderRoles } from "./pgflow-roles";
import { ExtensionOperationError } from "./extension-policy";

export interface PgflowState {
  installed: boolean;
  enabled: boolean;
  managed: boolean;
  version: string | null;
  profile?: string;
}

export async function readPgflowState(db: SQL, ref: string): Promise<PgflowState> {
  const [schema] = await db`SELECT to_regnamespace('pgflow') IS NOT NULL AS installed,
    to_regclass('supacloud_worker.installation') IS NOT NULL AS managed`;
  if (!schema?.managed) return { installed: schema?.installed === true, managed: false, enabled: false, version: null };
  const [binding] = await db`SELECT * FROM supacloud_worker.installation WHERE singleton`;
  if (binding?.project_ref !== ref || binding.engine_version !== "0.16.0") {
    throw new ExtensionOperationError("pgflow project binding/version mismatch");
  }
  const [control] = await db`SELECT to_regclass('supacloud_worker.control') IS NOT NULL AS present`;
  const [state] = control?.present ? await db`SELECT enabled FROM supacloud_worker.control WHERE singleton` : [{ enabled: true }];
  return { installed: true, managed: true, enabled: state?.enabled === true, version: binding.engine_version, profile: binding.profile };
}

export async function setPgflowEnabled(db: SQL, ref: string, enabled: boolean): Promise<PgflowState> {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(ref)) throw new ExtensionOperationError("Invalid project reference", 400);
  return db.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('supacloud-pgflow-install',0))`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('supacloud-pgflow-roles',0))`;
    await tx`SELECT pg_advisory_xact_lock(1937076332,1)`;
    const state = await readPgflowState(tx, ref);
    if (state.installed && !state.managed) throw new ExtensionOperationError("Unmanaged pgflow schema; reviewed adoption required");
    if (!state.installed && !enabled) return state;
    if (!state.installed) {
      const [prerequisites] = await tx`SELECT to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NOT NULL AS ready`;
      if (!prerequisites?.ready) throw new ExtensionOperationError("Configure the project's Realtime schema before enabling pgflow");
      await tx.unsafe(`CREATE SCHEMA supacloud_worker;
        REVOKE ALL ON SCHEMA supacloud_worker FROM PUBLIC;
        CREATE TABLE supacloud_worker.installation(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
          project_ref text NOT NULL, engine_version text NOT NULL, profile text NOT NULL DEFAULT 'shared');
        CREATE TABLE supacloud_worker.migrations(version text PRIMARY KEY, sha256 text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT clock_timestamp());`);
      await tx`INSERT INTO supacloud_worker.installation VALUES(true,${ref},'0.16.0','shared')`;
      for (const migration of PGFLOW_MIGRATIONS) {
        if (migration.sql.trim()) await executeSqlStatements(tx, migration.sql);
        await tx`INSERT INTO supacloud_worker.migrations(version,sha256) VALUES(${migration.version},${migration.sha256})`;
      }
    } else {
      const [binding] = await tx`SELECT profile FROM supacloud_worker.installation WHERE singleton`;
      if (binding?.profile !== "shared") throw new ExtensionOperationError("Dedicated profile requires a reviewed control upgrade");
      const rows = await tx`SELECT version,sha256 FROM supacloud_worker.migrations`;
      if (rows.length !== PGFLOW_MIGRATIONS.length || !PGFLOW_MIGRATIONS.every(m =>
        rows.some((row: { version: string; sha256: string }) => row.version === m.version && row.sha256 === m.sha256))) {
        throw new ExtensionOperationError("pgflow migration checksum mismatch; reviewed upgrade required");
      }
    }
    await executeSqlStatements(tx, renderRoles(ref).replace(/^\\set ON_ERROR_STOP on\s*/, ""));
    await tx`UPDATE supacloud_worker.control SET enabled=${enabled} WHERE singleton`;
    return readPgflowState(tx, ref);
  });
}
