import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { SQL } from "bun";
import { config } from "../src/config";
import { dbConfig, getProjectDb, sql } from "../src/db";
import { withProjectMigrationLocks } from "../src/services/migration-lock";
import {
  ContainerRealtimeTenantSchemaRpc,
  assertCanonicalWalColumn,
  classifyRealtimeWalColumnAttributes,
  LEGACY_REALTIME_FUNCTION_DROP_ORDER,
  type LegacyRealtimeObjectInventory,
  type RealtimeWalColumnInspection,
  type RealtimeWalColumnRepairArtifact,
  RealtimeTenantSchemaPartialStateError,
  RealtimeTenantSchemaReconcileService,
  type RealtimeBackupCatalogVerifier,
  legacyRealtimeFunctionDropStatement,
  parseRealtimeTenantSchemaPlanFile,
  runCommand,
  type EffectiveAclEntry,
  type RealtimeTenantSchemaReconcileStore,
  type RealtimeTenantDatabaseIdentity,
} from "../src/services/realtime-tenant-schema-reconcile.service";

type Action = "inspect" | "plan" | "apply";

interface CliOptions {
  action: Action;
  projectRef?: string;
  outputPath?: string;
  planPath?: string;
  backupReceiptPath?: string;
  runtime?: string;
  container?: string;
  releaseCommand?: string;
  allowDestructive: boolean;
  dryRun: boolean;
}

const HELP = `Usage:
  bun run scripts/reconcile-realtime-tenant-schema.ts inspect --project-ref <ref>
  bun run scripts/reconcile-realtime-tenant-schema.ts plan --project-ref <ref> --out <plan.json>
  bun run scripts/reconcile-realtime-tenant-schema.ts apply --plan-file <plan.json> --backup-receipt <absolute-path> [--allow-destructive]

Actions:
  inspect  Read the release/tenant ledgers and the physical realtime.wal_column catalog.
  plan     Save the exact pgdelta plan, wal_column snapshot, repair intent, and release artifact hash.
  apply    Commit at most one reviewed schema mutation phase; require a fresh plan before the next phase or ledger sync.

Options:
  --dry-run             Validate an apply plan against current state without mutations.
  --allow-destructive   Required for reviewed legacy cleanup or destructive pgdelta actions.
  --runtime             Container runtime (default: configured runtime).
  --container           Realtime container name (default: supacloud-realtime).
  --release-command     Release executable (default: /app/bin/realtime).
`;

function parseArgs(argv: string[]): CliOptions {
  const [actionValue, ...rest] = argv;
  if (!(["inspect", "plan", "apply"] as string[]).includes(actionValue || "")) {
    throw new Error(HELP);
  }
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const booleanFlags = new Set(["--allow-destructive", "--dry-run"]);
  const valueFlags = new Set([
    "--project-ref",
    "--out",
    "--plan-file",
    "--backup-receipt",
    "--runtime",
    "--container",
    "--release-command",
  ]);

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (booleanFlags.has(flag)) {
      booleans.add(flag);
      continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`unknown option: ${flag}\n\n${HELP}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate option: ${flag}`);
    values.set(flag, value);
    index += 1;
  }

  const options: CliOptions = {
    action: actionValue as Action,
    projectRef: values.get("--project-ref"),
    outputPath: values.get("--out"),
    planPath: values.get("--plan-file"),
    backupReceiptPath: values.get("--backup-receipt"),
    runtime: values.get("--runtime"),
    container: values.get("--container"),
    releaseCommand: values.get("--release-command"),
    allowDestructive: booleans.has("--allow-destructive"),
    dryRun: booleans.has("--dry-run"),
  };

  if ((options.action === "inspect" || options.action === "plan") && !options.projectRef) {
    throw new Error(`${options.action} requires --project-ref`);
  }
  if (options.action === "plan" && !options.outputPath) throw new Error("plan requires --out");
  if (options.action === "apply" && !options.planPath) throw new Error("apply requires --plan-file");
  if (options.action !== "apply" && options.dryRun) throw new Error("--dry-run is only valid with apply");
  return options;
}

async function assertProjectExists(projectRef: string): Promise<void> {
  const rows = await sql<{ ref: string }[]>`
    SELECT ref
    FROM projects
    WHERE ref = ${projectRef}
      AND (status IS NULL OR status <> 'deleted')
    LIMIT 1
  `;
  if (rows.length !== 1) throw new Error(`active project not found: ${projectRef}`);
}

class BunRealtimeTenantSchemaStore implements RealtimeTenantSchemaReconcileStore {
  private readonly databases = new Map<string, { name: string; database: SQL }>();

  private async database(projectRef: string): Promise<SQL> {
    const rows = await sql<{ db_name: string | null }[]>`
      SELECT db_name
      FROM projects
      WHERE ref = ${projectRef}
        AND (status IS NULL OR status <> 'deleted')
      LIMIT 1
    `;
    if (rows.length !== 1) throw new Error(`active project not found: ${projectRef}`);
    const name = rows[0]?.db_name || `supa_${projectRef}`;
    const existing = this.databases.get(projectRef);
    if (existing && existing.name !== name) {
      throw new Error(`project ${projectRef} database mapping changed during reconciliation; create a new plan`);
    }
    if (existing) return existing.database;
    const database = getProjectDb(name);
    this.databases.set(projectRef, { name, database });
    return database;
  }

  private async readReplacementJournal(projectRef: string): Promise<{
    epoch: string;
    state: "inactive" | "active";
    phase: string | null;
  }> {
    let rows: Array<{
      parent_ref: string;
      branch_ref: string;
      parent_db: string;
      branch_db: string;
      temp_db: string;
      backup_db: string;
      phase: string;
      replacement_committed: boolean;
      recovery_database: string | null;
      updated_at: string;
    }> = [];
    try {
      rows = await sql`
        SELECT parent_ref, branch_ref, parent_db, branch_db, temp_db, backup_db,
               phase, replacement_committed, recovery_database, updated_at::text AS updated_at
        FROM branch_replacement_journal
        WHERE parent_ref = ${projectRef} OR branch_ref = ${projectRef}
        ORDER BY parent_ref, updated_at
      `;
    } catch (error) {
      if (!isUndefinedTableError(error)) throw error;
      return { epoch: "none", state: "inactive", phase: null };
    }
    if (rows.length === 0) return { epoch: "none", state: "inactive", phase: null };
    return {
      epoch: sha256(JSON.stringify(rows)),
      state: "active",
      phase: rows[rows.length - 1]?.phase || null,
    };
  }

  async inspectDatabaseIdentity(projectRef: string): Promise<RealtimeTenantDatabaseIdentity> {
    const database = await this.database(projectRef);
    const [row] = await database<{
      database_name: string;
      system_identifier: string;
      database_oid: string;
    }[]>`
      SELECT current_database() AS database_name,
             (pg_control_system()).system_identifier::text AS system_identifier,
             (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid
    `;
    if (
      !row
      || row.database_name !== this.databases.get(projectRef)?.name
      || !/^\d{1,20}$/.test(row.system_identifier)
      || !/^[1-9]\d{0,9}$/.test(row.database_oid)
    ) {
      throw new Error(`physical identity for project ${projectRef} database is unavailable`);
    }
    const journal = await this.readReplacementJournal(projectRef);
    return {
      projectRef,
      databaseName: row.database_name,
      systemIdentifier: row.system_identifier,
      databaseOid: row.database_oid,
      replacementJournalEpoch: journal.epoch,
      replacementJournalState: journal.state,
      replacementJournalPhase: journal.phase,
    };
  }

  private async assertIdentity(
    projectRef: string,
    expected: RealtimeTenantDatabaseIdentity | undefined,
  ): Promise<void> {
    if (!expected) return;
    const current = await this.inspectDatabaseIdentity(projectRef);
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`project ${projectRef} database identity changed during reconciliation; create a new plan`);
    }
    if (current.replacementJournalState !== "inactive") {
      throw new Error(`database replacement journal is active for ${projectRef}; reconciliation is blocked`);
    }
  }

  private async assertTransactionIdentity(
    database: SQL,
    expected: RealtimeTenantDatabaseIdentity | undefined,
  ): Promise<void> {
    if (!expected) return;
    const [row] = await database<{
      database_name: string;
      system_identifier: string;
      database_oid: string;
    }[]>`
      SELECT current_database() AS database_name,
             (pg_control_system()).system_identifier::text AS system_identifier,
             (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid
    `;
    if (
      !row
      || row.database_name !== expected.databaseName
      || row.system_identifier !== expected.systemIdentifier
      || row.database_oid !== expected.databaseOid
    ) {
      throw new Error("tenant database physical identity changed at the mutation transaction boundary");
    }
  }

  async readTenantLedger(projectRef: string): Promise<string[]> {
    const database = await this.database(projectRef);
    try {
      const rows = await database<{ version: string }[]>`
        SELECT version::text AS version
        FROM realtime.schema_migrations
        ORDER BY version
      `;
      return rows.map((row) => row.version);
    } catch (error) {
      if (isUndefinedTableError(error)) {
        throw new Error(
          "Realtime tenant ledger table realtime.schema_migrations is missing; initialize the tenant with the official Realtime bootstrap before reconciliation",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async inspectLegacyRealtimeObjects(projectRef: string): Promise<LegacyRealtimeObjectInventory> {
    const database = await this.database(projectRef);
    return database.begin(async (transaction) => {
      await transaction.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return readLegacyRealtimeObjects(transaction);
    });
  }

  async removeKnownLegacyRealtimeObjects(
    projectRef: string,
    inventory: LegacyRealtimeObjectInventory,
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<number> {
    await this.assertIdentity(projectRef, expectedIdentity);
    const database = await this.database(projectRef);
    let removed = 0;
    await database.begin(async (transaction) => {
      await transaction.unsafe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await this.assertTransactionIdentity(transaction, expectedIdentity);
      const currentInventory = await readLegacyRealtimeObjects(transaction);
      if (JSON.stringify(currentInventory) !== JSON.stringify(inventory)) {
        throw new Error(
          "Realtime legacy trigger/function inventory changed during cleanup; create a new plan",
        );
      }
      for (const trigger of currentInventory.tableTriggers) {
        await lockAndVerifyLegacyTableTrigger(transaction, trigger);
        await transaction.unsafe(
          `DROP TRIGGER ${quoteIdentifier(trigger.name)} ON ${quoteIdentifier(trigger.schema)}.${quoteIdentifier(trigger.table)}`,
        );
        removed += 1;
      }
      for (const eventTrigger of currentInventory.eventTriggers) {
        await lockAndVerifyLegacyEventTrigger(transaction, eventTrigger);
        await transaction.unsafe(`DROP EVENT TRIGGER ${quoteIdentifier(eventTrigger.name)}`);
        removed += 1;
      }
      const functionDetails = new Map(
        currentInventory.functionDetails.map((detail) => [detail.identity, detail]),
      );
      for (const identity of LEGACY_REALTIME_FUNCTION_DROP_ORDER.filter(
        (candidate) => currentInventory.functions.includes(candidate),
      )) {
        const detail = functionDetails.get(identity);
        if (!detail) {
          throw new Error(`missing reviewed legacy Realtime function metadata: ${identity}`);
        }
        await lockAndVerifyLegacyFunction(transaction, detail);
        await transaction.unsafe(legacyRealtimeFunctionDropStatement(identity));
        removed += 1;
      }
    });
    return removed;
  }

  async inspectWalColumn(projectRef: string): Promise<RealtimeWalColumnInspection> {
    const database = await this.database(projectRef);
    return database.begin(async (transaction) => {
      await transaction.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return readWalColumnInspection(transaction);
    });
  }

  async rebuildWalColumn(
    projectRef: string,
    expected: RealtimeWalColumnInspection,
    artifact: RealtimeWalColumnRepairArtifact,
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<void> {
    await this.assertIdentity(projectRef, expectedIdentity);
    const database = await this.database(projectRef);
    await database.begin(async (transaction) => {
      await transaction.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await this.assertTransactionIdentity(transaction, expectedIdentity);
      await transaction`SELECT pg_advisory_xact_lock(hashtext('supacloud:realtime:wal_column-repair'))`;
      const current = await readWalColumnInspection(transaction);
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        throw new Error(
          "realtime.wal_column changed during repair CAS check; transaction was rolled back",
        );
      }
      if (current.storedColumnReferences.length > 0) {
        throw new Error(
          "realtime.wal_column gained a stored relation-column reference; transaction was rolled back",
        );
      }
      const dependencies = await transaction<{
        classId: string;
        refClassId: string;
        dependencyType: string;
        objectType: string;
        objectIdentity: string;
        referencedType: string;
        referencedIdentity: string;
      }[]>`
        SELECT
          d.classid::regclass::text AS "classId",
          d.refclassid::regclass::text AS "refClassId",
          d.deptype AS "dependencyType",
          identified.object_type AS "objectType",
          CASE
            WHEN d.classid = 'pg_proc'::regclass THEN pg_catalog.format(
              '%I.%I(%s)', pn.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes)
            )
            ELSE identified.object_identity
          END AS "objectIdentity",
          referenced.object_type AS "referencedType",
          referenced.object_identity AS "referencedIdentity"
        FROM pg_catalog.pg_depend d
        CROSS JOIN pg_catalog.pg_type target
        LEFT JOIN pg_catalog.pg_proc p
          ON d.classid = 'pg_proc'::regclass AND p.oid = d.objid
        LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
        CROSS JOIN LATERAL pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid)
          AS identified(object_type, object_schema, object_name, object_identity)
        CROSS JOIN LATERAL pg_catalog.pg_identify_object(d.refclassid, d.refobjid, d.refobjsubid)
          AS referenced(object_type, object_schema, object_name, object_identity)
        WHERE target.oid = 'realtime.wal_column'::regtype::oid
          AND d.refclassid = 'pg_type'::regclass
          AND d.refobjid IN (target.oid, target.typarray)
        ORDER BY d.classid::regclass::text, d.objid, d.objsubid, d.refobjid, d.refobjsubid
      `;
      const expectedDependencies = [
        {
          classId: "pg_class",
          refClassId: "pg_type",
          dependencyType: "i",
          objectType: "composite type",
          objectIdentity: "realtime.wal_column",
          referencedType: "type",
          referencedIdentity: "realtime.wal_column",
        },
        {
          classId: "pg_proc",
          refClassId: "pg_type",
          dependencyType: "n",
          objectType: "function",
          objectIdentity: "realtime.build_prepared_statement_sql(text, regclass, realtime.wal_column[])",
          referencedType: "type",
          referencedIdentity: "realtime.wal_column[]",
        },
        {
          classId: "pg_proc",
          refClassId: "pg_type",
          dependencyType: "n",
          objectType: "function",
          objectIdentity: "realtime.is_visible_through_filters(realtime.wal_column[], realtime.user_defined_filter[])",
          referencedType: "type",
          referencedIdentity: "realtime.wal_column[]",
        },
        {
          classId: "pg_type",
          refClassId: "pg_type",
          dependencyType: "i",
          objectType: "type",
          objectIdentity: "realtime.wal_column[]",
          referencedType: "type",
          referencedIdentity: "realtime.wal_column",
        },
      ];
      const dependencyKey = (row: {
        classId: string;
        refClassId: string;
        dependencyType: string;
        objectType: string;
        objectIdentity: string;
        referencedType: string;
        referencedIdentity: string;
      }): string => JSON.stringify([
        row.classId,
        row.refClassId,
        row.dependencyType,
        row.objectType,
        normalizeDependencyIdentity(row.objectIdentity),
        row.referencedType,
        normalizeDependencyIdentity(row.referencedIdentity),
      ]);
      const expectedKeys = expectedDependencies.map(dependencyKey);
      const actualKeys = dependencies.map(dependencyKey);
      if (
        actualKeys.length !== expectedKeys.length
        || new Set(actualKeys).size !== actualKeys.length
        || actualKeys.some((key) => !expectedKeys.includes(key))
      ) {
        throw new Error(
          "realtime.wal_column has unexpected stored dependencies or overloads; refusing a rebuild",
        );
      }
      const [collision] = await transaction<{ exists: boolean }[]>`
        SELECT to_regtype('realtime.wal_column__supacloud_repair_old') IS NOT NULL AS exists
      `;
      if (collision?.exists) {
        throw new Error("temporary realtime.wal_column repair type already exists");
      }

      await transaction.unsafe(
        'ALTER TYPE realtime.wal_column RENAME TO wal_column__supacloud_repair_old',
      );
      const [supabaseAdmin] = await transaction<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') AS exists
      `;
      if (!supabaseAdmin?.exists) {
        throw new Error("required schema creator role supabase_admin is missing");
      }
      await transaction.unsafe('SET LOCAL ROLE "supabase_admin"');
      for (const file of artifact.files) await transaction.unsafe(file.sql);
      await transaction.unsafe('RESET ROLE');

      await transaction.unsafe(
        "DROP FUNCTION IF EXISTS realtime.build_prepared_statement_sql(text, regclass, realtime.wal_column__supacloud_repair_old[])",
      );
      await transaction.unsafe(
        "DROP FUNCTION IF EXISTS realtime.is_visible_through_filters(realtime.wal_column__supacloud_repair_old[], realtime.user_defined_filter[])",
      );
      await transaction.unsafe("DROP TYPE realtime.wal_column__supacloud_repair_old RESTRICT");
      await transaction.unsafe('SET LOCAL ROLE "supabase_realtime_admin"');
      await transaction.unsafe(NORMALIZE_WAL_COLUMN_DEFAULT_PRIVILEGES_SQL);
      await transaction.unsafe('RESET ROLE');

      const [stale] = await transaction<{ oldTypeExists: boolean; staleOverloads: number }[]>`
        SELECT
          to_regtype('realtime.wal_column__supacloud_repair_old') IS NOT NULL AS "oldTypeExists",
          (
            SELECT count(*)::int
            FROM pg_catalog.pg_proc p
            JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'realtime'
              AND (
                strpos(pg_catalog.pg_get_function_identity_arguments(p.oid), 'wal_column__supacloud_repair_old') > 0
                OR strpos(pg_catalog.pg_get_function_result(p.oid), 'wal_column__supacloud_repair_old') > 0
              )
          ) AS "staleOverloads"
      `;
      if (stale?.oldTypeExists || Number(stale?.staleOverloads || 0) !== 0) {
        throw new Error("wal_column repair left a stale renamed type or dependent overload");
      }

      assertCanonicalWalColumn(await readWalColumnInspection(transaction));
    });
  }

  async insertTenantLedgerVersions(
    projectRef: string,
    versions: readonly string[],
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<void> {
    await this.assertIdentity(projectRef, expectedIdentity);
    const database = await this.database(projectRef);
    try {
      await database.begin(async (transaction) => {
        await this.assertTransactionIdentity(transaction, expectedIdentity);
        for (const version of versions) {
          await transaction`
            INSERT INTO realtime.schema_migrations (version, inserted_at)
            VALUES (${version}::bigint, NOW())
            ON CONFLICT (version) DO NOTHING
          `;
        }
      });
    } catch (error) {
      if (isUndefinedTableError(error)) {
        throw new Error(
          "Realtime tenant ledger table realtime.schema_migrations is missing; ledger synchronization was not applied",
          { cause: error },
        );
      }
      throw error;
    }
  }
}

const NORMALIZE_WAL_COLUMN_DEFAULT_PRIVILEGES_SQL = `
DO $supacloud$
DECLARE
  role_name text;
  function_identity text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['postgres', 'dashboard_user']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      RAISE EXCEPTION 'required Realtime platform role % is missing', role_name;
    END IF;
  END LOOP;

  GRANT EXECUTE ON FUNCTION realtime.apply_rls(jsonb, integer)
    TO postgres, dashboard_user;
  GRANT EXECUTE ON FUNCTION realtime.list_changes(name, name, integer, integer)
    TO postgres, dashboard_user;

  FOR role_name IN
    SELECT rolname
    FROM pg_roles
    WHERE rolname IN ('dbrole_readonly', 'dbrole_offline')
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_type target
      JOIN pg_catalog.pg_roles grantee
        ON grantee.rolname = role_name
      CROSS JOIN LATERAL pg_catalog.aclexplode(target.typacl) acl
      WHERE target.oid = 'realtime.wal_column'::regtype
        AND acl.grantee = grantee.oid
    ) THEN
      EXECUTE format('REVOKE USAGE ON TYPE realtime.wal_column FROM %I', role_name);
    END IF;
    FOREACH function_identity IN ARRAY ARRAY[
      'realtime.apply_rls(jsonb, integer)',
      'realtime.build_prepared_statement_sql(text, regclass, realtime.wal_column[])',
      'realtime.is_visible_through_filters(realtime.wal_column[], realtime.user_defined_filter[])',
      'realtime.list_changes(name, name, integer, integer)'
    ]
    LOOP
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc target
        JOIN pg_catalog.pg_roles grantee
          ON grantee.rolname = role_name
        CROSS JOIN LATERAL pg_catalog.aclexplode(target.proacl) acl
        WHERE target.oid = function_identity::regprocedure
          AND acl.grantee = grantee.oid
      ) THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', function_identity, role_name);
      END IF;
    END LOOP;
  END LOOP;
END
$supacloud$;
`;

function isUndefinedTableError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "42P01";
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizeDependencyIdentity(identity: string): string {
  return identity.replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim();
}

type LegacyEventTrigger = LegacyRealtimeObjectInventory["eventTriggers"][number];
type LegacyTableTrigger = LegacyRealtimeObjectInventory["tableTriggers"][number];
type LegacyFunctionDetail = LegacyRealtimeObjectInventory["functionDetails"][number];

interface LegacyEventTriggerRow {
  oid: string;
  name: string;
  event: string;
  ownerOid: string;
  enabled: string;
  tags: string[] | null;
  functionIdentity: string;
  functionOid: string;
  functionDefinition: string;
}

interface LegacyTableTriggerRow {
  oid: string;
  relationOid: string;
  schema: string;
  table: string;
  name: string;
  enabled: string;
  definition: string;
  functionIdentity: string;
  functionOid: string;
  functionDefinition: string;
  row: boolean;
  before: boolean;
  instead: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
}

interface LegacyFunctionRow {
  identity: string;
  oid: string;
  definition: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseEffectiveAcl(value: string): EffectiveAclEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `PostgreSQL returned an invalid effective ACL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) throw new Error("PostgreSQL returned a non-array effective ACL");
  return parsed as EffectiveAclEntry[];
}

function legacyEventTriggerFromRow(row: LegacyEventTriggerRow): LegacyEventTrigger {
  return {
    oid: row.oid,
    name: row.name,
    event: row.event,
    functionIdentity: row.functionIdentity,
    functionOid: row.functionOid,
    functionDefinitionSha256: sha256(row.functionDefinition),
    definitionSha256: sha256(JSON.stringify({
      name: row.name,
      event: row.event,
      ownerOid: row.ownerOid,
      enabled: row.enabled,
      tags: row.tags || [],
      functionOid: row.functionOid,
    })),
  };
}

function legacyTableTriggerFromRow(row: LegacyTableTriggerRow): LegacyTableTrigger {
  return {
    oid: row.oid,
    relationOid: row.relationOid,
    schema: row.schema,
    table: row.table,
    name: row.name,
    functionIdentity: row.functionIdentity,
    functionOid: row.functionOid,
    functionDefinitionSha256: sha256(row.functionDefinition),
    definitionSha256: sha256(JSON.stringify({
      definition: row.definition,
      enabled: row.enabled,
    })),
    row: Boolean(row.row),
    before: Boolean(row.before),
    instead: Boolean(row.instead),
    insert: Boolean(row.insert),
    update: Boolean(row.update),
    delete: Boolean(row.delete),
    truncate: Boolean(row.truncate),
  };
}

function legacyFunctionFromRow(row: LegacyFunctionRow): LegacyFunctionDetail {
  return {
    identity: row.identity,
    oid: row.oid,
    definitionSha256: sha256(row.definition),
  };
}

async function lockAndVerifyLegacyEventTrigger(
  database: SQL,
  expected: LegacyEventTrigger,
): Promise<void> {
  const rows = await database<LegacyEventTriggerRow[]>`
    SELECT
      e.oid::text AS oid,
      e.evtname AS name,
      e.evtevent AS event,
      e.evtowner::text AS "ownerOid",
      e.evtenabled::text AS enabled,
      e.evttags AS tags,
      format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes))
        AS "functionIdentity",
      p.oid::text AS "functionOid",
      pg_catalog.pg_get_functiondef(p.oid) AS "functionDefinition"
    FROM pg_catalog.pg_event_trigger e
    JOIN pg_catalog.pg_proc p ON p.oid = e.evtfoid
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE e.oid = ${expected.oid}::oid
    FOR UPDATE OF e, p
  `;
  if (rows.length !== 1 || JSON.stringify(legacyEventTriggerFromRow(rows[0]!)) !== JSON.stringify(expected)) {
    throw new Error(`legacy Realtime event trigger changed immediately before cleanup: ${expected.name}`);
  }
}

async function lockAndVerifyLegacyTableTrigger(
  database: SQL,
  expected: LegacyTableTrigger,
): Promise<void> {
  await database.unsafe(
    `LOCK TABLE ${quoteIdentifier(expected.schema)}.${quoteIdentifier(expected.table)} IN SHARE ROW EXCLUSIVE MODE`,
  );
  const rows = await database<LegacyTableTriggerRow[]>`
    SELECT
      t.oid::text AS oid,
      c.oid::text AS "relationOid",
      n.nspname AS schema,
      c.relname AS table,
      t.tgname AS name,
      t.tgenabled::text AS enabled,
      pg_catalog.pg_get_triggerdef(t.oid, true) AS definition,
      format('%I.%I(%s)', fn.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes))
        AS "functionIdentity",
      p.oid::text AS "functionOid",
      pg_catalog.pg_get_functiondef(p.oid) AS "functionDefinition",
      (t.tgtype & 1) <> 0 AS row,
      (t.tgtype & 2) <> 0 AS before,
      (t.tgtype & 64) <> 0 AS instead,
      (t.tgtype & 4) <> 0 AS insert,
      (t.tgtype & 16) <> 0 AS update,
      (t.tgtype & 8) <> 0 AS delete,
      (t.tgtype & 32) <> 0 AS truncate
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    JOIN pg_catalog.pg_namespace fn ON fn.oid = p.pronamespace
    WHERE t.oid = ${expected.oid}::oid
      AND NOT t.tgisinternal
    FOR UPDATE OF t, c, p
  `;
  if (rows.length !== 1 || JSON.stringify(legacyTableTriggerFromRow(rows[0]!)) !== JSON.stringify(expected)) {
    throw new Error(
      `legacy Realtime table trigger changed immediately before cleanup: ${expected.schema}.${expected.table}.${expected.name}`,
    );
  }
}

async function lockAndVerifyLegacyFunction(
  database: SQL,
  expected: LegacyFunctionDetail,
): Promise<void> {
  const rows = await database<LegacyFunctionRow[]>`
    SELECT
      format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes)) AS identity,
      p.oid::text AS oid,
      pg_catalog.pg_get_functiondef(p.oid) AS definition
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.oid = ${expected.oid}::oid
    FOR UPDATE OF p
  `;
  if (rows.length !== 1 || JSON.stringify(legacyFunctionFromRow(rows[0]!)) !== JSON.stringify(expected)) {
    throw new Error(`legacy Realtime function changed immediately before cleanup: ${expected.identity}`);
  }
}

async function readLegacyRealtimeObjects(
  database: SQL,
): Promise<LegacyRealtimeObjectInventory> {
  const eventTriggerRows = await database<LegacyEventTriggerRow[]>`
    SELECT
      e.oid::text AS oid,
      e.evtname AS name,
      e.evtevent AS event,
      e.evtowner::text AS "ownerOid",
      e.evtenabled::text AS enabled,
      e.evttags AS tags,
      format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes))
        AS "functionIdentity",
      p.oid::text AS "functionOid",
      pg_catalog.pg_get_functiondef(p.oid) AS "functionDefinition"
    FROM pg_catalog.pg_event_trigger e
    JOIN pg_catalog.pg_proc p ON p.oid = e.evtfoid
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'realtime'
       OR e.evtname IN ('realtime_auto_attach_trigger', 'realtime_auto_publish_tasks_trigger')
    ORDER BY e.evtname
  `;
  const tableTriggerRows = await database<LegacyTableTriggerRow[]>`
    SELECT
      t.oid::text AS oid,
      c.oid::text AS "relationOid",
      n.nspname AS schema,
      c.relname AS table,
      t.tgname AS name,
      t.tgenabled::text AS enabled,
      pg_catalog.pg_get_triggerdef(t.oid, true) AS definition,
      format('%I.%I(%s)', fn.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes))
        AS "functionIdentity",
      p.oid::text AS "functionOid",
      pg_catalog.pg_get_functiondef(p.oid) AS "functionDefinition",
      (t.tgtype & 1) <> 0 AS row,
      (t.tgtype & 2) <> 0 AS before,
      (t.tgtype & 64) <> 0 AS instead,
      (t.tgtype & 4) <> 0 AS insert,
      (t.tgtype & 16) <> 0 AS update,
      (t.tgtype & 8) <> 0 AS delete,
      (t.tgtype & 32) <> 0 AS truncate
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    JOIN pg_catalog.pg_namespace fn ON fn.oid = p.pronamespace
    WHERE NOT t.tgisinternal
      AND (n.nspname = 'public' AND t.tgname = 'realtime_notify_trigger'
        OR fn.nspname = 'realtime' AND p.proname = 'notify_postgres_changes')
    ORDER BY n.nspname, c.relname, t.tgname
  `;
  const functionRows = await database<LegacyFunctionRow[]>`
    SELECT
      format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes)) AS identity,
      p.oid::text AS oid,
      pg_catalog.pg_get_functiondef(p.oid) AS definition
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'realtime'
      AND p.proname IN (
        'auto_attach_notify_trigger',
        'auto_publish_tasks_table',
        'ensure_tasks_publication',
        'notify_change_payload',
        'notify_postgres_changes'
      )
    ORDER BY identity
  `;
  const functionDetails = functionRows.map(legacyFunctionFromRow);
  return {
    eventTriggers: eventTriggerRows.map(legacyEventTriggerFromRow),
    tableTriggers: tableTriggerRows.map(legacyTableTriggerFromRow),
    functions: functionDetails.map((row) => row.identity),
    functionDetails,
  };
}

async function readWalColumnInspection(database: SQL): Promise<RealtimeWalColumnInspection> {
  const typeRows = await database<{
    attnum: number;
    name: string | null;
    type: string | null;
    dropped: boolean;
    owner: string;
    acl: string | null;
    effectiveAcl: string;
    relationOwner: string;
    relationAcl: string | null;
    effectiveRelationAcl: string;
  }[]>`
      SELECT
        a.attnum,
        CASE WHEN a.attisdropped THEN NULL ELSE a.attname END AS name,
        CASE WHEN a.attisdropped THEN NULL ELSE pg_catalog.format_type(a.atttypid, a.atttypmod) END AS type,
        a.attisdropped AS dropped,
        pg_catalog.pg_get_userbyid(t.typowner) AS owner,
        t.typacl::text AS acl,
        COALESCE((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_array(
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
              pg_catalog.pg_get_userbyid(acl.grantor),
              acl.privilege_type,
              acl.is_grantable
            )
            ORDER BY
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
              pg_catalog.pg_get_userbyid(acl.grantor),
              acl.privilege_type,
              acl.is_grantable
          )
          FROM pg_catalog.aclexplode(COALESCE(t.typacl, pg_catalog.acldefault('T', t.typowner)))
            AS acl(grantor, grantee, privilege_type, is_grantable)
        ), '[]'::jsonb)::text AS "effectiveAcl",
        pg_catalog.pg_get_userbyid(c.relowner) AS "relationOwner",
        c.relacl::text AS "relationAcl",
        COALESCE((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_array(
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
              pg_catalog.pg_get_userbyid(acl.grantor),
              acl.privilege_type,
              acl.is_grantable
            )
            ORDER BY
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
              pg_catalog.pg_get_userbyid(acl.grantor),
              acl.privilege_type,
              acl.is_grantable
          )
          FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner)))
            AS acl(grantor, grantee, privilege_type, is_grantable)
        ), '[]'::jsonb)::text AS "effectiveRelationAcl"
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_catalog.pg_attribute a
        ON a.attrelid = t.typrelid
       AND a.attnum > 0
      WHERE n.nspname = 'realtime'
        AND t.typname = 'wal_column'
      ORDER BY a.attnum
    `;
  const functionRows = await database<{
    identity: string;
    owner: string;
    acl: string | null;
    effectiveAcl: string;
    definition: string;
  }[]>`
      SELECT
        pg_catalog.format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes)) AS identity,
        pg_catalog.pg_get_userbyid(p.proowner) AS owner,
        p.proacl::text AS acl,
        COALESCE((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_array(
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
              pg_catalog.pg_get_userbyid(acl.grantor),
              acl.privilege_type,
              acl.is_grantable
            )
            ORDER BY
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
              pg_catalog.pg_get_userbyid(acl.grantor),
              acl.privilege_type,
              acl.is_grantable
          )
          FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner)))
            AS acl(grantor, grantee, privilege_type, is_grantable)
        ), '[]'::jsonb)::text AS "effectiveAcl",
        pg_catalog.pg_get_functiondef(p.oid) AS definition
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'realtime'
        AND (
          p.proname = 'apply_rls'
          OR p.proname = 'build_prepared_statement_sql'
          OR p.proname = 'is_visible_through_filters'
          OR p.proname = 'list_changes'
        )
      ORDER BY identity
    `;
  const referenceRows = await database<{
    schema: string;
    relation: string;
    column: string;
    type: string;
  }[]>`
      SELECT
        n.nspname AS schema,
        c.relname AS relation,
        a.attname AS column,
        CASE WHEN a.atttypid = t.oid THEN 'realtime.wal_column' ELSE 'realtime.wal_column[]' END AS type
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN pg_catalog.pg_type t
      WHERE t.typnamespace = 'realtime'::regnamespace
        AND t.typname = 'wal_column'
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND a.atttypid IN (t.oid, t.typarray)
        AND a.attrelid <> t.typrelid
      ORDER BY n.nspname, c.relname, a.attnum
    `;
  const staleRows = await database<{
    staleRepairTypeExists: boolean;
    staleRepairFunctionOverloads: string[];
  }[]>`
      SELECT
        to_regtype('realtime.wal_column__supacloud_repair_old') IS NOT NULL
          AS "staleRepairTypeExists",
        ARRAY(
          SELECT pg_catalog.format(
            '%I.%I(%s)',
            n.nspname,
            p.proname,
            pg_catalog.oidvectortypes(p.proargtypes)
          )
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'realtime'
            AND (
                strpos(pg_catalog.pg_get_function_identity_arguments(p.oid), 'wal_column__supacloud_repair_old') > 0
              OR strpos(pg_catalog.pg_get_function_result(p.oid), 'wal_column__supacloud_repair_old') > 0
            )
          ORDER BY 1
        ) AS "staleRepairFunctionOverloads"
    `;

  if (typeRows.length === 0) {
    throw new Error("realtime.wal_column is missing; refusing reconciliation");
  }
  const first = typeRows[0]!;
  const attributes = typeRows.map((row) => ({
    attnum: Number(row.attnum),
    name: row.name,
    type: row.type,
    dropped: Boolean(row.dropped),
  }));
  const shape = classifyRealtimeWalColumnAttributes(attributes);
  const functions = functionRows.map((row) => ({
    identity: row.identity,
    owner: row.owner,
    acl: row.acl,
    effectiveAcl: parseEffectiveAcl(row.effectiveAcl),
    definitionSha256: createHash("sha256").update(row.definition).digest("hex"),
  }));
  const stale = staleRows[0];
  if (!stale) throw new Error("failed to inspect stale realtime.wal_column repair objects");
  return {
    shape,
    attributes,
    owner: first.owner,
    acl: first.acl,
    effectiveAcl: parseEffectiveAcl(first.effectiveAcl),
    relationOwner: first.relationOwner,
    relationAcl: first.relationAcl,
    effectiveRelationAcl: parseEffectiveAcl(first.effectiveRelationAcl),
    functions,
    storedColumnReferences: referenceRows,
    staleRepairTypeExists: Boolean(stale.staleRepairTypeExists),
    staleRepairFunctionOverloads: stale.staleRepairFunctionOverloads || [],
  };
}

function sensitiveValues(): string[] {
  let databaseUrlPassword = "";
  try {
    databaseUrlPassword = decodeURIComponent(new URL(config.databaseUrl).password);
  } catch {
    // Configuration validation reports malformed URLs elsewhere.
  }
  return [
    config.pgPassword,
    dbConfig.password,
    databaseUrlPassword,
    config.jwtSecret,
    config.realtimeApiSecret,
    config.masterToken,
  ].filter((value): value is string => Boolean(value));
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const rpc = new ContainerRealtimeTenantSchemaRpc(runCommand, {
    runtime: options.runtime || config.containerRuntime,
    container: options.container,
    releaseCommand: options.releaseCommand,
    resolveTarget: async (projectRef) => {
      const rows = await sql<{ db_name: string | null }[]>`
        SELECT db_name
        FROM projects
        WHERE ref = ${projectRef}
          AND (status IS NULL OR status <> 'deleted')
        LIMIT 1
      `;
      if (rows.length !== 1) throw new Error(`active project not found: ${projectRef}`);
      return {
        host: config.pgHost,
        port: config.pgPort,
        database: rows[0]?.db_name || `supa_${projectRef}`,
        username: "supabase_admin",
        password: config.pgPassword,
        sslMode: "disable",
      };
    },
  });
  const service = new RealtimeTenantSchemaReconcileService(
    rpc,
    new BunRealtimeTenantSchemaStore(),
    sensitiveValues(),
  );
  const verifyBackupCatalog: RealtimeBackupCatalogVerifier = async (archivePath) => (
    runCommand(["pg_restore", "--list", "--exit-on-error", archivePath])
  );

  if (options.action === "inspect") {
    await assertProjectExists(options.projectRef!);
    const inspection = await withProjectMigrationLocks(
      { projectRefs: [options.projectRef!] },
      () => service.inspect(options.projectRef!),
    );
    console.log(JSON.stringify(inspection, null, 2));
    return;
  }

  if (options.action === "plan") {
    await assertProjectExists(options.projectRef!);
    const plan = await withProjectMigrationLocks(
      { projectRefs: [options.projectRef!] },
      () => service.plan(options.projectRef!),
    );
    await writeFile(options.outputPath!, `${JSON.stringify(plan, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    console.log(JSON.stringify({
      projectRef: plan.projectRef,
      runtimeVersion: plan.runtimeVersion,
      status: plan.pgdelta.status,
      destructiveActions: plan.pgdelta.destructiveActions,
      walColumnShape: plan.walColumn.shape,
      walColumnRepair: plan.walColumnRepair.action,
      walColumnRepairArtifactSha256: plan.walColumnRepair.artifactSha256,
      pgdeltaProfileSha256: plan.walColumnRepair.profileSha256,
      planSha256: plan.planSha256,
      outputPath: options.outputPath,
    }, null, 2));
    return;
  }

  const plan = parseRealtimeTenantSchemaPlanFile(await readFile(options.planPath!, "utf8"));
  await assertProjectExists(plan.projectRef);
  const result = await withProjectMigrationLocks(
    { projectRefs: [plan.projectRef] },
    () => service.apply(plan, {
      backupReceiptPath: options.backupReceiptPath,
      allowDestructive: options.allowDestructive,
      dryRun: options.dryRun,
      verifyBackupCatalog,
    }),
  );
  console.log(JSON.stringify(result, null, 2));
}

function recoveryGuidance(error: RealtimeTenantSchemaPartialStateError): string[] {
  switch (error.phase) {
    case "schema_mutation_pending_verification":
      return [
        "Do not reuse the old plan.",
        "Run inspect, create and review a fresh plan, then rerun apply or restore the reviewed backup.",
      ];
    case "schema_converged_ledger_pending":
      return [
        "The tenant schema may be converged while the database ledger is incomplete.",
        "Run inspect and create a fresh plan before retrying; restore the reviewed backup if the schema cannot be accepted.",
      ];
    case "ledger_runtime_pending":
      return [
        "The database ledger was updated but Realtime migrations_ran was not confirmed.",
        "Run inspect, create a fresh plan, and rerun apply to retry runtime ledger synchronization.",
      ];
    case "ledger_verification_pending":
      return [
        "Both ledger mutations may have completed but final acceptance did not verify.",
        "Run inspect and a fresh pgdelta plan before any retry or restore decision.",
      ];
  }
}

if (import.meta.main) {
  main().catch((error) => {
    if (error instanceof RealtimeTenantSchemaPartialStateError) {
      console.error(JSON.stringify({
        error: "realtime_tenant_schema_partial_state",
        retryable: error.retryable,
        phase: error.phase,
        projectRef: error.projectRef,
        databaseIdentity: error.databaseIdentity,
        message: error.message,
        recovery: recoveryGuidance(error),
      }, null, 2));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  });
}
