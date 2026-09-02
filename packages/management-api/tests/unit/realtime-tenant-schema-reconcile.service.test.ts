import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ContainerRealtimeTenantSchemaRpc,
  assertCanonicalWalColumn,
  classifyRealtimeWalColumnAttributes,
  legacyRealtimeFunctionDropStatement,
  RealtimeTenantSchemaReconcileService,
  RealtimeTenantSchemaPartialStateError,
  parseRealtimeTenantSchemaPlanFile,
  validateRealtimeBackupReceipt,
  type CommandRunner,
  type EffectiveAclEntry,
  type LegacyRealtimeObjectInventory,
  type RealtimeBackupCatalogVerifier,
  type RealtimePgdeltaPlan,
  type RealtimeRuntimeSnapshot,
  type RealtimeWalColumnInspection,
  type RealtimeWalColumnRepairArtifact,
  type RealtimeTenantSchemaReconcileStore,
  type RealtimeTenantSchemaRpc,
  type RealtimeTenantDatabaseIdentity,
} from "../../src/services/realtime-tenant-schema-reconcile.service";

const RELEASE_VERSIONS = ["20211116024918", "20211116045059", "20211116050929"];

const REPAIR_FILES = [
  { path: "realtime/types/wal_column.sql", sql: "CREATE TYPE realtime.wal_column AS ();\n" },
  { path: "realtime/functions/apply_rls.sql", sql: "-- apply_rls\n" },
  { path: "realtime/functions/build_prepared_statement_sql.sql", sql: "-- build\n" },
  { path: "realtime/functions/is_visible_through_filters.sql", sql: "-- visible\n" },
  { path: "realtime/functions/list_changes.sql", sql: "-- list\n" },
];

const PROFILE = `{
  "id": "realtime-tenant",
  "handlers": [],
  "policy": {
    "id": "realtime-tenant",
    "filter": [
      {
        "match": { "partitionOf": { "schema": "realtime", "name": "messages" } },
        "action": "exclude",
        "audit": { "reasonCode": "realtime.messages-partition-churn", "classification": "acknowledged" }
      },
      {
        "match": { "all": [{ "kind": "policy" }, { "verb": "remove" }] },
        "action": "exclude",
        "audit": { "reasonCode": "realtime.keep-unknown-rls-policies", "classification": "acknowledged" }
      },
      {
        "match": { "all": [{ "kind": "comment" }, { "target": { "kind": "policy" } }, { "verb": "remove" }] },
        "action": "exclude",
        "audit": { "reasonCode": "realtime.keep-unknown-rls-policy-comments", "classification": "acknowledged" }
      },
      {
        "match": { "all": [{ "kind": "table" }, { "schema": "realtime" }, { "name": "schema_migrations" }] },
        "action": "exclude",
        "audit": { "reasonCode": "realtime.schema-migrations-table", "classification": "acknowledged" }
      },
      {
        "match": { "all": [{ "kind": "role" }, { "verb": "remove" }] },
        "action": "exclude",
        "audit": { "reasonCode": "realtime.never-drop-roles", "classification": "acknowledged" }
      },
      {
        "match": { "all": [{ "kind": "role" }, { "name": ["supabase_realtime_admin", "supabase_admin"] }] },
        "action": "include"
      },
      {
        "match": { "kind": "defaultPrivilege" },
        "action": "exclude",
        "audit": { "reasonCode": "realtime.platform-default-privileges", "classification": "acknowledged" }
      },
      {
        "match": {
          "all": [{ "kind": "acl" }, { "idField": { "field": "grantee", "glob": ["dashboard_user", "postgres"] } }]
        },
        "action": "exclude",
        "audit": { "reasonCode": "realtime.platform-managed-grantees", "classification": "acknowledged" }
      },
      {
        "match": {
          "any": [
            { "schema": "realtime" },
            { "target": { "schema": "realtime" } },
            { "target": { "kind": "schema", "name": "realtime" } },
            { "all": [{ "kind": "schema" }, { "name": "realtime" }] }
          ]
        },
        "action": "include"
      },
      {
        "match": { "all": [] },
        "action": "exclude",
        "audit": { "reasonCode": "realtime.out-of-scope", "classification": "acknowledged" }
      }
    ]
  }
}
`;
const MANIFEST = `{
  "formatVersion": 1,
  "redactSecrets": true,
  "scope": "database",
  "profile": "realtime-tenant",
  "defaultOwner": null,
  "files": [
    "realtime/functions/apply_rls.sql",
    "realtime/functions/broadcast_changes.sql",
    "realtime/functions/build_prepared_statement_sql.sql",
    "realtime/functions/cast.sql",
    "realtime/functions/check_equality_op.sql",
    "realtime/functions/is_visible_through_filters.sql",
    "realtime/functions/list_changes.sql",
    "realtime/functions/quote_wal2json.sql",
    "realtime/functions/send.sql",
    "realtime/functions/send_binary.sql",
    "realtime/functions/subscription_check_filters.sql",
    "realtime/functions/to_regrole.sql",
    "realtime/functions/topic.sql",
    "realtime/functions/wal2json_escape_identifier.sql",
    "realtime/schema.sql",
    "realtime/tables/messages.sql",
    "realtime/tables/subscription.sql",
    "realtime/types/action.sql",
    "realtime/types/equality_op.sql",
    "realtime/types/user_defined_filter.sql",
    "realtime/types/wal_column.sql",
    "realtime/types/wal_rls.sql"
  ],
  "loadOrder": [
    "realtime/schema.sql",
    "realtime/tables/messages.sql",
    "realtime/tables/subscription.sql",
    "realtime/types/action.sql",
    "realtime/types/equality_op.sql",
    "realtime/types/user_defined_filter.sql",
    "realtime/types/wal_column.sql",
    "realtime/types/wal_rls.sql",
    "realtime/functions/apply_rls.sql",
    "realtime/functions/broadcast_changes.sql",
    "realtime/functions/build_prepared_statement_sql.sql",
    "realtime/functions/cast.sql",
    "realtime/functions/check_equality_op.sql",
    "realtime/functions/is_visible_through_filters.sql",
    "realtime/functions/list_changes.sql",
    "realtime/functions/quote_wal2json.sql",
    "realtime/functions/send.sql",
    "realtime/functions/send_binary.sql",
    "realtime/functions/subscription_check_filters.sql",
    "realtime/functions/to_regrole.sql",
    "realtime/functions/topic.sql",
    "realtime/functions/wal2json_escape_identifier.sql"
  ]
}
`;
const MANIFEST_SHA256 = "4cbd8c1a606febe2c8740ca5e1ff3f2026a9db34ea09aec537457f901fb8382a";
const MANIFEST_LOAD_ORDER = (JSON.parse(MANIFEST) as { loadOrder: string[] }).loadOrder;
const SCHEMA_FILES = MANIFEST_LOAD_ORDER.map((path) => (
  REPAIR_FILES.find((file) => file.path === path) || { path, sql: `-- ${path}\n` }
));

function artifactHash(files: readonly { path: string; sql: string }[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(file.sql).update("\0");
  return hash.digest("hex");
}

function repairArtifact(files = REPAIR_FILES): RealtimeWalColumnRepairArtifact {
  const schemaFiles = SCHEMA_FILES.map((file) => (
    files.find((candidate) => candidate.path === file.path) || file
  ));
  return {
    sha256: artifactHash(files),
    manifestSha256: MANIFEST_SHA256,
    manifestLoadOrder: REPAIR_FILES.map((file) => file.path),
    profileSha256: createHash("sha256").update(PROFILE).digest("hex"),
    profileContents: PROFILE,
    schemaTreeSha256: artifactHash(schemaFiles),
    schemaFiles: structuredClone(schemaFiles),
    manifestContents: MANIFEST,
    files: structuredClone(files),
  };
}

function databaseIdentity(projectRef = "tenant_one"): RealtimeTenantDatabaseIdentity {
  return {
    projectRef,
    databaseName: `supa_${projectRef}`,
    systemIdentifier: "7627039817244368897",
    databaseOid: "16384",
    replacementJournalEpoch: "none",
    replacementJournalState: "inactive",
    replacementJournalPhase: null,
  };
}

function walColumnInspection(
  shape: "canonical" | "legacy" | "corrupted_dropped_attribute" = "canonical",
): RealtimeWalColumnInspection {
  const attributes = shape === "canonical"
    ? [
      { attnum: 1, name: "name", type: "text", dropped: false },
      { attnum: 2, name: "type_name", type: "text", dropped: false },
      { attnum: 3, name: "type_oid", type: "oid", dropped: false },
      { attnum: 4, name: "value", type: "jsonb", dropped: false },
      { attnum: 5, name: "is_pkey", type: "boolean", dropped: false },
      { attnum: 6, name: "is_selectable", type: "boolean", dropped: false },
    ]
    : shape === "legacy"
      ? [
        { attnum: 1, name: "name", type: "text", dropped: false },
        { attnum: 2, name: "type", type: "text", dropped: false },
        { attnum: 3, name: "value", type: "jsonb", dropped: false },
        { attnum: 4, name: "is_pkey", type: "boolean", dropped: false },
        { attnum: 5, name: "is_selectable", type: "boolean", dropped: false },
      ]
      : [
        { attnum: 1, name: "name", type: "text", dropped: false },
        { attnum: 2, name: null, type: null, dropped: true },
        { attnum: 3, name: "value", type: "jsonb", dropped: false },
        { attnum: 4, name: "is_pkey", type: "boolean", dropped: false },
        { attnum: 5, name: "is_selectable", type: "boolean", dropped: false },
        { attnum: 6, name: "type_name", type: "text", dropped: false },
        { attnum: 7, name: "type_oid", type: "oid", dropped: false },
      ];
  const identities = [
    "realtime.apply_rls(jsonb, integer)",
    "realtime.build_prepared_statement_sql(text, regclass, realtime.wal_column[])",
    "realtime.is_visible_through_filters(realtime.wal_column[], realtime.user_defined_filter[])",
    "realtime.list_changes(name, name, integer, integer)",
  ];
  const executeAcl = (grantees: readonly string[]): EffectiveAclEntry[] => grantees.map((grantee) => [
    grantee,
    "supabase_realtime_admin",
    "EXECUTE",
    false,
  ]);
  return {
    shape,
    attributes,
    owner: "supabase_realtime_admin",
    acl: null,
    effectiveAcl: [
      ["PUBLIC", "supabase_realtime_admin", "USAGE", false],
      ["supabase_realtime_admin", "supabase_realtime_admin", "USAGE", false],
    ],
    relationOwner: "supabase_realtime_admin",
    relationAcl: null,
    effectiveRelationAcl: [
      ["supabase_realtime_admin", "supabase_realtime_admin", "DELETE", false],
      ["supabase_realtime_admin", "supabase_realtime_admin", "INSERT", false],
      ["supabase_realtime_admin", "supabase_realtime_admin", "MAINTAIN", false],
      ["supabase_realtime_admin", "supabase_realtime_admin", "REFERENCES", false],
      ["supabase_realtime_admin", "supabase_realtime_admin", "SELECT", false],
      ["supabase_realtime_admin", "supabase_realtime_admin", "TRIGGER", false],
      ["supabase_realtime_admin", "supabase_realtime_admin", "TRUNCATE", false],
      ["supabase_realtime_admin", "supabase_realtime_admin", "UPDATE", false],
    ],
    functions: identities.map((identity) => {
      const isApply = identity.startsWith("realtime.apply_rls");
      const isList = identity.startsWith("realtime.list_changes");
      const acl = isApply
        ? "{=X/supabase_realtime_admin,supabase_realtime_admin=X/supabase_realtime_admin,postgres=X/supabase_realtime_admin,dashboard_user=X/supabase_realtime_admin,anon=X/supabase_realtime_admin,authenticated=X/supabase_realtime_admin,service_role=X/supabase_realtime_admin}"
        : isList
          ? "{=X/supabase_realtime_admin,supabase_realtime_admin=X/supabase_realtime_admin,postgres=X/supabase_realtime_admin,dashboard_user=X/supabase_realtime_admin}"
          : "{=X/supabase_realtime_admin,supabase_realtime_admin=X/supabase_realtime_admin,anon=X/supabase_realtime_admin,authenticated=X/supabase_realtime_admin,service_role=X/supabase_realtime_admin}";
      const effectiveAcl = isApply
        ? executeAcl([
          "PUBLIC",
          "anon",
          "authenticated",
          "dashboard_user",
          "postgres",
          "service_role",
          "supabase_realtime_admin",
        ])
        : isList
          ? executeAcl(["PUBLIC", "dashboard_user", "postgres", "supabase_realtime_admin"])
          : executeAcl(["PUBLIC", "anon", "authenticated", "service_role", "supabase_realtime_admin"]);
      const definitionSha256 = isApply
        ? "b455782c3c10fe5f7d36d9b4f27ad531191fb7693ce55dd88cc639e8bf36ea83"
        : identity.startsWith("realtime.build_prepared_statement_sql")
          ? "46923b06f4d06e66bed424b6da25bd00d5f70472ff398d35d2ae50f3634359ba"
          : identity.startsWith("realtime.is_visible_through_filters")
            ? "4583a3c4c0425a65597a33472f7efab296765665db5c2cef5b309f84adafc1b5"
            : "6ecaa7b9145a223931a3e5d6a0275750fc663fe90d56bbb353a2963eb2b935eb";
      return {
        identity,
        owner: "supabase_realtime_admin",
        acl,
        effectiveAcl,
        definitionSha256,
      };
    }),
    storedColumnReferences: [],
    staleRepairTypeExists: false,
    staleRepairFunctionOverloads: [],
  };
}

function changesPlan(id: string, destructiveActions = 1): RealtimePgdeltaPlan {
  return {
    status: "changes",
    plan: JSON.stringify({
      scope: "database",
      profile: { id: "realtime-tenant" },
      actions: [{ id }],
      safetyReport: { destructiveActions },
    }),
    renderedSql: `-- ${id}`,
    destructiveActions,
  };
}

function metadataPlan(options: {
  reverseSets?: boolean;
  reverseActions?: boolean;
  sql?: string;
} = {}): RealtimePgdeltaPlan {
  const resource = (kind: string, name: string) => options.reverseSets
    ? { name, kind }
    : { kind, name };
  const actions = [
    {
      verb: "alter",
      sql: options.sql || "ALTER TABLE realtime.messages ADD COLUMN persisted boolean",
      consumes: [resource("schema", "realtime"), resource("table", "messages")],
      produces: [resource("column", "persisted")],
      destroys: [],
      releases: [],
      dataLoss: "none",
    },
    {
      verb: "create",
      sql: "CREATE INDEX messages_persisted_idx ON realtime.messages (persisted)",
      consumes: [resource("table", "messages"), resource("column", "persisted")],
      produces: [resource("index", "messages_persisted_idx")],
      destroys: [],
      releases: [],
      dataLoss: "none",
    },
  ];
  if (options.reverseSets) {
    for (const action of actions) action.consumes.reverse();
  }
  if (options.reverseActions) actions.reverse();
  return {
    status: "changes",
    plan: JSON.stringify({
      planId: options.reverseSets ? "b".repeat(64) : "a".repeat(64),
      scope: "database",
      profile: { id: "realtime-tenant", schema: "realtime", enabled: true },
      actions,
      safetyReport: { destructiveActions: 0 },
    }),
    renderedSql: actions.map((action) => action.sql).join(";\n"),
    destructiveActions: 0,
  };
}

const NO_CHANGES: RealtimePgdeltaPlan = {
  status: "no_changes",
  plan: null,
  renderedSql: "",
  destructiveActions: 0,
};

function legacyInventory(): LegacyRealtimeObjectInventory {
  const autoAttach = {
    identity: "realtime.auto_attach_notify_trigger()",
    oid: "3002",
    definitionSha256: "b".repeat(64),
  };
  const notify = {
    identity: "realtime.notify_postgres_changes()",
    oid: "3001",
    definitionSha256: "a".repeat(64),
  };
  return {
    eventTriggers: [{
      oid: "1001",
      name: "realtime_auto_attach_trigger",
      event: "ddl_command_end",
      functionIdentity: autoAttach.identity,
      functionOid: autoAttach.oid,
      functionDefinitionSha256: autoAttach.definitionSha256,
      definitionSha256: "c".repeat(64),
    }],
    tableTriggers: [{
      oid: "1002",
      relationOid: "2001",
      schema: "public",
      table: "tasks",
      name: "realtime_notify_trigger",
      functionIdentity: notify.identity,
      functionOid: notify.oid,
      functionDefinitionSha256: notify.definitionSha256,
      definitionSha256: "d".repeat(64),
      row: true,
      before: false,
      instead: false,
      insert: true,
      update: true,
      delete: true,
      truncate: false,
    }],
    functions: [
      autoAttach.identity,
      notify.identity,
    ],
    functionDetails: [autoAttach, notify],
  };
}

function emptyLegacyInventory(): LegacyRealtimeObjectInventory {
  return { eventTriggers: [], tableTriggers: [], functions: [], functionDetails: [] };
}

class FakeStore implements RealtimeTenantSchemaReconcileStore {
  identity = databaseIdentity();
  ledger = RELEASE_VERSIONS.slice(0, 1);
  inventory = legacyInventory();
  walColumn = walColumnInspection();
  inserted = false;
  rebuildError?: Error;
  walColumnInspections: RealtimeWalColumnInspection[] = [];
  walColumnAfterLedgerInsert?: RealtimeWalColumnInspection;
  inventoryAfterRemoval?: LegacyRealtimeObjectInventory;
  operations: string[] = [];

  async inspectDatabaseIdentity(): Promise<RealtimeTenantDatabaseIdentity> {
    this.operations.push("inspect-database-identity");
    return structuredClone(this.identity);
  }

  async readTenantLedger(): Promise<string[]> {
    this.operations.push("read-ledger");
    return [...this.ledger];
  }

  async inspectLegacyRealtimeObjects(): Promise<LegacyRealtimeObjectInventory> {
    this.operations.push("inspect-legacy");
    return structuredClone(this.inventory);
  }

  async removeKnownLegacyRealtimeObjects(
    _projectRef: string,
    inventory: LegacyRealtimeObjectInventory,
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<number> {
    this.operations.push("remove-legacy");
    expect(expectedIdentity).toEqual(this.identity);
    expect(inventory).toEqual(this.inventory);
    const count = inventory.eventTriggers.length + inventory.tableTriggers.length + inventory.functions.length;
    this.inventory = structuredClone(this.inventoryAfterRemoval || emptyLegacyInventory());
    return count;
  }

  async inspectWalColumn(): Promise<RealtimeWalColumnInspection> {
    this.operations.push("inspect-wal-column");
    return structuredClone(this.walColumnInspections.shift() || this.walColumn);
  }

  async rebuildWalColumn(
    _projectRef: string,
    expected: RealtimeWalColumnInspection,
    _artifact: RealtimeWalColumnRepairArtifact,
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<void> {
    this.operations.push("rebuild-wal-column");
    expect(expected).toEqual(this.walColumn);
    expect(expectedIdentity).toEqual(this.identity);
    if (this.rebuildError) throw this.rebuildError;
    this.walColumn = walColumnInspection("canonical");
  }

  async insertTenantLedgerVersions(
    _projectRef: string,
    versions: readonly string[],
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<void> {
    this.operations.push("insert-ledger");
    expect(expectedIdentity).toEqual(this.identity);
    this.inserted = true;
    this.ledger = [...versions];
    if (this.walColumnAfterLedgerInsert) {
      this.walColumn = structuredClone(this.walColumnAfterLedgerInsert);
    }
  }
}

class FakeRpc implements RealtimeTenantSchemaRpc {
  migrationsRan = 1;
  plans: RealtimePgdeltaPlan[] = [];
  operations: string[] = [];
  updateError?: Error;
  applyError?: Error;
  artifact = repairArtifact();

  async walColumnRepairArtifact(): Promise<RealtimeWalColumnRepairArtifact> {
    this.operations.push("rpc-artifact");
    return structuredClone(this.artifact);
  }

  async inspect(projectRef: string): Promise<RealtimeRuntimeSnapshot> {
    this.operations.push("rpc-inspect");
    return {
      runtimeVersion: "2.133.0",
      tenantExternalId: projectRef,
      tenantMigrationsRan: this.migrationsRan,
      migrationVersions: [...RELEASE_VERSIONS],
    };
  }

  async plan(): Promise<RealtimePgdeltaPlan> {
    this.operations.push("rpc-plan");
    const result = this.plans.shift();
    if (!result) throw new Error("unexpected pgdelta plan call");
    return structuredClone(result);
  }

  async applyPlan(_projectRef: string, plan: string): Promise<void> {
    this.operations.push(`rpc-apply:${JSON.parse(plan).actions[0].id}`);
    if (this.applyError) throw this.applyError;
  }

  async updateMigrationsRan(_projectRef: string, count: number): Promise<void> {
    this.operations.push("rpc-update-ledger-count");
    if (this.updateError) throw this.updateError;
    this.migrationsRan = count;
  }
}

const temporaryDirectories: string[] = [];
const BACKUP_CATALOG = "; pg_restore --list evidence\nTABLE DATA public reviewed\n";
const verifyBackupCatalog: RealtimeBackupCatalogVerifier = async () => ({
  exitCode: 0,
  stdout: BACKUP_CATALOG,
  stderr: "",
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function backupReceipt(identity = databaseIdentity()): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "supacloud-realtime-backup-"));
  temporaryDirectories.push(directory);
  const archive = Buffer.from("disposable pg_dump archive\n");
  const catalog = Buffer.from(BACKUP_CATALOG);
  await writeFile(join(directory, "tenant.dump"), archive, { mode: 0o600 });
  await writeFile(join(directory, "catalog.list"), catalog, { mode: 0o600 });
  const receipt = join(directory, "receipt.json");
  await writeFile(receipt, `${JSON.stringify({
    schema: "supacloud.realtime-tenant-schema-backup.v1",
    kind: "realtime-tenant-schema",
    backup_id: "test-backup",
    project_ref: identity.projectRef,
    database_name: identity.databaseName,
    system_identifier: identity.systemIdentifier,
    database_oid: identity.databaseOid,
    replacement_journal_epoch: identity.replacementJournalEpoch,
    replacement_journal_state: identity.replacementJournalState,
    archive_path: "tenant.dump",
    archive_bytes: archive.byteLength,
    archive_sha256: createHash("sha256").update(archive).digest("hex"),
    catalog_verified: true,
    catalog_path: "catalog.list",
    catalog_sha256: createHash("sha256").update(catalog).digest("hex"),
    catalog_entries: 1,
    created_at: "2026-09-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  return receipt;
}

describe("RealtimeTenantSchemaReconcileService", () => {
  test("guards platform ACL revokes against raw catalog entries", async () => {
    const source = await readFile(
      new URL("../../scripts/reconcile-realtime-tenant-schema.ts", import.meta.url),
      "utf8",
    );
    const normalization = source.slice(
      source.indexOf("const NORMALIZE_WAL_COLUMN_DEFAULT_PRIVILEGES_SQL"),
      source.indexOf("function isUndefinedTableError"),
    );

    expect(normalization).toContain("pg_catalog.aclexplode(target.typacl)");
    expect(normalization).toContain("pg_catalog.aclexplode(target.proacl)");
    expect(normalization).toContain("acl.grantee = grantee.oid");
    expect(normalization).toContain("ARRAY['postgres', 'dashboard_user']");
    expect(normalization).toContain(
      "GRANT EXECUTE ON FUNCTION realtime.apply_rls(jsonb, integer)\n    TO postgres, dashboard_user",
    );
    expect(normalization).toContain(
      "GRANT EXECUTE ON FUNCTION realtime.list_changes(name, name, integer, integer)\n    TO postgres, dashboard_user",
    );
    expect(normalization).not.toContain(
      "LOOP\n    EXECUTE format('REVOKE USAGE ON TYPE realtime.wal_column FROM %I', role_name)",
    );
    expect(source).toContain(
      "await transaction.unsafe('SET LOCAL ROLE \"supabase_realtime_admin\"');\n      await transaction.unsafe(NORMALIZE_WAL_COLUMN_DEFAULT_PRIVILEGES_SQL);\n      await transaction.unsafe('RESET ROLE');",
    );
  });

  test("classifies canonical, legacy, and dropped-attribute wal_column layouts and rejects unknown layouts", () => {
    expect(classifyRealtimeWalColumnAttributes(walColumnInspection().attributes)).toBe("canonical");
    expect(classifyRealtimeWalColumnAttributes(walColumnInspection("legacy").attributes)).toBe("legacy");
    expect(classifyRealtimeWalColumnAttributes(walColumnInspection("corrupted_dropped_attribute").attributes))
      .toBe("corrupted_dropped_attribute");
    expect(() => classifyRealtimeWalColumnAttributes([
      ...walColumnInspection().attributes,
      { attnum: 7, name: "unexpected", type: "text", dropped: false },
    ])).toThrow("unknown physical attribute layout");
  });

  test("applies reviewed pgdelta before wal_column repair and stops for a fresh plan", async () => {
    const store = new FakeStore();
    store.inventory = emptyLegacyInventory();
    store.walColumn = walColumnInspection("corrupted_dropped_attribute");
    const rpc = new FakeRpc();
    const reviewed = changesPlan("reviewed", 4);
    rpc.plans.push(reviewed, reviewed, NO_CHANGES, NO_CHANGES, NO_CHANGES);
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");
    expect(plan.formatVersion).toBe(3);
    expect(plan.walColumnRepair.action).toBe("rebuild_from_release");

    await expect(service.apply(plan, {
      backupReceiptPath: await backupReceipt(),
      verifyBackupCatalog,
      allowDestructive: true,
    })).rejects.toThrow("reviewed pgdelta plan applied");

    expect(store.operations).not.toContain("rebuild-wal-column");
    expect(rpc.operations).toContain("rpc-apply:reviewed");
    expect(store.inserted).toBe(false);
  });

  test("fails closed when a wal_column stored relation-column reference is present", async () => {
    const store = new FakeStore();
    store.walColumn.storedColumnReferences = [{
      schema: "public",
      relation: "unsafe_table",
      column: "payload",
      type: "realtime.wal_column",
    }];
    const service = new RealtimeTenantSchemaReconcileService(new FakeRpc(), store);
    await expect(service.inspect("tenant_one")).rejects.toThrow("stored relation columns");
  });

  test("fails closed when stale wal_column repair objects are present", async () => {
    const store = new FakeStore();
    store.walColumn.staleRepairTypeExists = true;
    store.walColumn.staleRepairFunctionOverloads = [
      "realtime.build_prepared_statement_sql(text, regclass, realtime.wal_column__supacloud_repair_old[])",
    ];
    const service = new RealtimeTenantSchemaReconcileService(new FakeRpc(), store);

    await expect(service.inspect("tenant_one")).rejects.toThrow("stale repair objects");
  });

  test("requires exactly the four official wal_column function overloads", () => {
    const inspection = walColumnInspection();
    inspection.functions.push(structuredClone(inspection.functions[0]!));

    expect(() => assertCanonicalWalColumn(inspection))
      .toThrow("exactly the four required function overloads");
  });

  test("stops after reviewed pgdelta apply before wal_column repair and leaves both ledgers untouched", async () => {
    const store = new FakeStore();
    store.inventory = emptyLegacyInventory();
    store.walColumn = walColumnInspection("legacy");
    const rpc = new FakeRpc();
    const reviewed = changesPlan("reviewed", 2);
    rpc.plans.push(reviewed, reviewed, changesPlan("after-repair", 1));
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    await expect(service.apply(plan, {
      backupReceiptPath: await backupReceipt(),
      verifyBackupCatalog,
      allowDestructive: true,
    })).rejects.toThrow("create and review a new plan");
    expect(store.operations).not.toContain("rebuild-wal-column");
    expect(store.inserted).toBe(false);
    expect(rpc.operations).not.toContain("rpc-update-ledger-count");
    expect(rpc.operations).toContain("rpc-apply:reviewed");
    expect(rpc.operations).not.toContain("rpc-apply:after-apply");
  });

  test("rejects a wal_column catalog change after plan review before any mutation", async () => {
    const store = new FakeStore();
    const rpc = new FakeRpc();
    rpc.plans.push(NO_CHANGES);
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");
    store.walColumn.acl = "{tampered=U/supabase_realtime_admin}";

    await expect(service.apply(plan, { dryRun: true }))
      .rejects.toThrow("wal_column changed after the plan was generated");
    expect(store.operations).not.toContain("rebuild-wal-column");
  });

  test("rejects a changed bundled pgdelta profile before any mutation", async () => {
    const store = new FakeStore();
    const rpc = new FakeRpc();
    rpc.plans.push(NO_CHANGES);
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");
    rpc.artifact.profileContents = "changed-profile";
    rpc.artifact.profileSha256 = createHash("sha256").update(rpc.artifact.profileContents).digest("hex");

    await expect(service.apply(plan, { dryRun: true }))
      .rejects.toThrow("pgdelta profile changed");
    expect(store.operations).not.toContain("rebuild-wal-column");
  });

  test("rejects a same-name database replacement before any mutation", async () => {
    const store = new FakeStore();
    const rpc = new FakeRpc();
    rpc.plans.push(NO_CHANGES);
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");
    store.identity.databaseOid = "16385";

    await expect(service.apply(plan, { dryRun: true }))
      .rejects.toThrow("database identity changed");
    expect(store.operations).not.toContain("remove-legacy");
    expect(store.operations).not.toContain("rebuild-wal-column");
  });

  test("rejects a project database mapping change before any mutation", async () => {
    const store = new FakeStore();
    const rpc = new FakeRpc();
    rpc.plans.push(NO_CHANGES);
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");
    store.identity.databaseName = "supa_tenant_one_replaced";

    await expect(service.apply(plan, { dryRun: true }))
      .rejects.toThrow("database identity changed");
  });

  test("blocks plans while the replacement journal is active", async () => {
    const store = new FakeStore();
    store.identity.replacementJournalState = "active";
    store.identity.replacementJournalEpoch = "a".repeat(64);
    store.identity.replacementJournalPhase = "parent_renamed";

    await expect(new RealtimeTenantSchemaReconcileService(new FakeRpc(), store).plan("tenant_one"))
      .rejects.toThrow("replacement journal is active");
  });

  test("propagates a transactional repair collision without applying pgdelta or touching ledgers", async () => {
    const store = new FakeStore();
    store.inventory = emptyLegacyInventory();
    store.walColumn = walColumnInspection("corrupted_dropped_attribute");
    store.rebuildError = new Error("temporary realtime.wal_column repair type already exists");
    const rpc = new FakeRpc();
    rpc.plans.push(NO_CHANGES, NO_CHANGES);
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    await expect(service.apply(plan, {
      backupReceiptPath: await backupReceipt(),
      verifyBackupCatalog,
      allowDestructive: true,
    })).rejects.toThrow("temporary realtime.wal_column repair type already exists");
    expect(store.walColumn.shape).toBe("corrupted_dropped_attribute");
    expect(store.inserted).toBe(false);
    expect(rpc.operations.some((operation) => operation.startsWith("rpc-apply:"))).toBe(false);
  });

  test("fails closed on a tenant ledger version unknown to the running release", async () => {
    const store = new FakeStore();
    store.ledger = ["20299999000000"];
    const rpc = new FakeRpc();
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);

    await expect(service.plan("tenant_one")).rejects.toThrow("unknown to the running release");
    expect(rpc.operations).toEqual(["rpc-inspect"]);
  });

  test("fails closed on an unknown legacy trigger shape", async () => {
    const store = new FakeStore();
    store.inventory.tableTriggers[0]!.functionIdentity = "realtime.unknown_trigger()";
    const service = new RealtimeTenantSchemaReconcileService(new FakeRpc(), store);

    await expect(service.inspect("tenant_one")).rejects.toThrow("unknown or unsafe Realtime table trigger shape");
  });

  test("stops after reviewed legacy cleanup when the pgdelta plan changes", async () => {
    const store = new FakeStore();
    const rpc = new FakeRpc();
    const reviewed = changesPlan("reviewed", 4);
    const afterCleanup = changesPlan("after-cleanup", 2);
    rpc.plans.push(reviewed, reviewed, afterCleanup);
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    await expect(service.apply(plan, {
      backupReceiptPath: await backupReceipt(),
      verifyBackupCatalog,
      allowDestructive: true,
    })).rejects.toThrow("reviewed legacy Realtime cleanup committed");

    expect(store.operations).toContain("remove-legacy");
    expect(store.inserted).toBe(false);
    expect(rpc.operations).not.toContain("rpc-apply:after-cleanup");
    expect(rpc.operations).not.toContain("rpc-update-ledger-count");
  });

  test("stops after reviewed legacy cleanup even when pgdelta reports no schema changes", async () => {
    const store = new FakeStore();
    const rpc = new FakeRpc();
    rpc.plans.push(NO_CHANGES, NO_CHANGES, NO_CHANGES, NO_CHANGES, NO_CHANGES);
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    await expect(service.apply(plan, {
      backupReceiptPath: await backupReceipt(),
      verifyBackupCatalog,
      allowDestructive: true,
    })).rejects.toThrow("reviewed legacy Realtime cleanup committed");

    expect(store.inserted).toBe(false);
    expect(store.operations).toContain("remove-legacy");
  });

  test("runs only legacy cleanup when legacy objects and wal_column repair are both pending", async () => {
    const store = new FakeStore();
    store.walColumn = walColumnInspection("legacy");
    const rpc = new FakeRpc();
    const reviewed = changesPlan("reviewed", 2);
    rpc.plans.push(reviewed, reviewed, changesPlan("after-cleanup", 1));
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    await expect(service.apply(plan, {
      backupReceiptPath: await backupReceipt(),
      verifyBackupCatalog,
      allowDestructive: true,
    })).rejects.toThrow("reviewed legacy Realtime cleanup committed");

    expect(store.operations).toContain("remove-legacy");
    expect(store.operations).not.toContain("rebuild-wal-column");
    expect(rpc.operations.some((operation) => operation.startsWith("rpc-apply:"))).toBe(false);
    expect(store.inserted).toBe(false);
  });

  test("runs only wal_column repair when a fresh plan has no pgdelta changes", async () => {
    const store = new FakeStore();
    store.inventory = emptyLegacyInventory();
    store.walColumn = walColumnInspection("corrupted_dropped_attribute");
    const rpc = new FakeRpc();
    rpc.plans.push(NO_CHANGES, NO_CHANGES, NO_CHANGES);
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    await expect(service.apply(plan, {
      backupReceiptPath: await backupReceipt(),
      verifyBackupCatalog,
      allowDestructive: true,
    })).rejects.toThrow("wal_column repair committed");

    expect(store.operations).toContain("rebuild-wal-column");
    expect(rpc.operations.some((operation) => operation.startsWith("rpc-apply:"))).toBe(false);
    expect(store.inserted).toBe(false);
    expect(rpc.operations).not.toContain("rpc-update-ledger-count");
  });

  test("requires an empty legacy inventory immediately after cleanup", async () => {
    const store = new FakeStore();
    store.inventoryAfterRemoval = legacyInventory();
    const rpc = new FakeRpc();
    rpc.plans.push(NO_CHANGES, NO_CHANGES);
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    await expect(service.apply(plan, {
      backupReceiptPath: await backupReceipt(),
      verifyBackupCatalog,
      allowDestructive: true,
    })).rejects.toThrow("legacy Realtime object inventory is not empty");
    expect(store.inserted).toBe(false);
  });

  test("stops when legacy cleanup exposes a more destructive plan", async () => {
    const store = new FakeStore();
    const rpc = new FakeRpc();
    const reviewed = changesPlan("reviewed", 0);
    rpc.plans.push(reviewed, reviewed, changesPlan("after-cleanup", 1));
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    await expect(service.apply(plan, {
      backupReceiptPath: await backupReceipt(),
      verifyBackupCatalog,
      allowDestructive: true,
    })).rejects.toThrow("reviewed legacy Realtime cleanup committed");
    expect(rpc.operations).not.toContain("rpc-apply:after-cleanup");
  });

  test("does not touch either ledger when the second pgdelta dry-run still reports drift", async () => {
    const store = new FakeStore();
    store.inventory = emptyLegacyInventory();
    const rpc = new FakeRpc();
    const reviewed = changesPlan("reviewed", 2);
    rpc.plans.push(reviewed, reviewed, changesPlan("remaining", 1));
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    await expect(service.apply(plan, {
      backupReceiptPath: await backupReceipt(),
      verifyBackupCatalog,
      allowDestructive: true,
    })).rejects.toThrow("reviewed pgdelta plan applied");
    expect(store.inserted).toBe(false);
    expect(rpc.operations).not.toContain("rpc-update-ledger-count");
  });

  test("does not touch ledgers when the exact wal_column catalog changes during release verification", async () => {
    const store = new FakeStore();
    store.inventory = emptyLegacyInventory();
    const changed = walColumnInspection();
    changed.functions[0]!.definitionSha256 = "b".repeat(64);
    store.walColumnInspections.push(
      walColumnInspection(),
      walColumnInspection(),
      changed,
    );
    const rpc = new FakeRpc();
    rpc.plans.push(NO_CHANGES, NO_CHANGES, NO_CHANGES);
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    await expect(service.apply(plan, {
      backupReceiptPath: await backupReceipt(),
      verifyBackupCatalog,
    })).rejects.toThrow("function catalog contract mismatch");
    expect(store.inserted).toBe(false);
    expect(rpc.operations).not.toContain("rpc-update-ledger-count");
  });

  test("rejects ACL drift after ledger synchronization instead of reporting acceptance", async () => {
    const store = new FakeStore();
    store.inventory = emptyLegacyInventory();
    const changed = walColumnInspection();
    changed.functions[0]!.acl = "{tampered=X/supabase_realtime_admin}";
    store.walColumnAfterLedgerInsert = changed;
    const rpc = new FakeRpc();
    rpc.plans.push(NO_CHANGES, NO_CHANGES, NO_CHANGES);
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    let failure: unknown;
    try {
      await service.apply(plan, {
        backupReceiptPath: await backupReceipt(),
        verifyBackupCatalog,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RealtimeTenantSchemaPartialStateError);
    expect((failure as RealtimeTenantSchemaPartialStateError).phase).toBe("ledger_verification_pending");
    expect((failure as Error).message).toContain("catalog changed after release verification");
    expect(store.inserted).toBe(true);
  });

  test("requires a backup receipt and explicit destructive acknowledgement", async () => {
    const store = new FakeStore();
    const rpc = new FakeRpc();
    const reviewed = changesPlan("reviewed", 3);
    rpc.plans.push(reviewed, reviewed, reviewed);
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    await expect(service.apply(plan)).rejects.toThrow("requires --backup-receipt");
    await expect(service.apply(plan, {
      backupReceiptPath: await backupReceipt(),
      verifyBackupCatalog,
    }))
      .rejects.toThrow("pass --allow-destructive");
    expect(store.operations).not.toContain("remove-legacy");
  });

  test("detects plan tampering", async () => {
    const store = new FakeStore();
    const rpc = new FakeRpc();
    rpc.plans.push(changesPlan("reviewed"));
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");
    plan.pgdelta.plan = JSON.stringify({
      scope: "database",
      profile: { id: "realtime-tenant" },
      actions: [{ id: "tampered" }],
      safetyReport: { destructiveActions: 1 },
    });

    expect(() => parseRealtimeTenantSchemaPlanFile(JSON.stringify(plan))).toThrow("checksum mismatch");
  });

  test("binds rendered SQL, destructive count, artifact identity, and database identity into the plan digest", async () => {
    const rpc = new FakeRpc();
    rpc.plans.push(changesPlan("reviewed", 1));
    const plan = await new RealtimeTenantSchemaReconcileService(rpc, new FakeStore()).plan("tenant_one");
    for (const mutate of [
      (candidate: typeof plan) => { candidate.pgdelta.renderedSql = "-- tampered"; },
      (candidate: typeof plan) => { candidate.pgdelta.destructiveActions = 2; },
      (candidate: typeof plan) => { candidate.walColumnRepair.schemaTreeSha256 = "b".repeat(64); },
      (candidate: typeof plan) => { candidate.databaseIdentity.databaseOid = "16385"; },
    ]) {
      const candidate = structuredClone(plan);
      mutate(candidate);
      expect(() => parseRealtimeTenantSchemaPlanFile(JSON.stringify(candidate))).toThrow("checksum mismatch");
    }
  });

  test("rejects backup archive tampering and database identity mismatches", async () => {
    const receipt = await backupReceipt();
    await expect(validateRealtimeBackupReceipt(receipt, databaseIdentity(), {
      verifyCatalog: verifyBackupCatalog,
    })).resolves.toMatchObject({
      project_ref: "tenant_one",
      catalog_verified: true,
    });
    await expect(validateRealtimeBackupReceipt(receipt, databaseIdentity(), {
      verifyCatalog: async () => ({ exitCode: 0, stdout: "; stale\nTABLE DATA public changed\n" }),
    })).rejects.toThrow("catalog output changed");
    await writeFile(join(receipt, "..", "tenant.dump"), "tampered\n", { mode: 0o600 });
    await expect(validateRealtimeBackupReceipt(receipt, databaseIdentity()))
      .rejects.toThrow("byte count does not match");

    const freshReceipt = await backupReceipt();
    const replaced = databaseIdentity();
    replaced.databaseOid = "16385";
    await expect(validateRealtimeBackupReceipt(freshReceipt, replaced))
      .rejects.toThrow("does not match the reviewed database identity");
  });

  test("treats pgdelta set metadata ordering and object key ordering as non-semantic", async () => {
    const store = new FakeStore();
    const rpc = new FakeRpc();
    rpc.plans.push(metadataPlan(), metadataPlan({ reverseSets: true }));
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    const result = await service.apply(plan, { dryRun: true });

    expect(result).toMatchObject({ dryRun: true, schemaApplied: false, ledgerSynchronized: false });
  });

  test("rejects pgdelta action SQL changes after plan review", async () => {
    const store = new FakeStore();
    const rpc = new FakeRpc();
    rpc.plans.push(metadataPlan(), metadataPlan({
      reverseSets: true,
      sql: "ALTER TABLE realtime.messages ADD COLUMN persisted text",
    }));
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    await expect(service.apply(plan, { dryRun: true }))
      .rejects.toThrow("tenant schema changed after the plan was generated");
  });

  test("rejects pgdelta action order changes after plan review", async () => {
    const store = new FakeStore();
    const rpc = new FakeRpc();
    rpc.plans.push(metadataPlan(), metadataPlan({ reverseSets: true, reverseActions: true }));
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    await expect(service.apply(plan, { dryRun: true }))
      .rejects.toThrow("tenant schema changed after the plan was generated");
  });

  test("rejects unexpected pgdelta set metadata shapes", async () => {
    const rpc = new FakeRpc();
    rpc.plans.push({
      status: "changes",
      plan: JSON.stringify({
        scope: "database",
        profile: { id: "realtime-tenant" },
        actions: [{ id: "reviewed", consumes: { kind: "schema", name: "realtime" } }],
        safetyReport: { destructiveActions: 0 },
      }),
      renderedSql: "-- reviewed",
      destructiveActions: 0,
    });
    const service = new RealtimeTenantSchemaReconcileService(rpc, new FakeStore());

    await expect(service.plan("tenant_one"))
      .rejects.toThrow("pgdelta plan action consumes metadata must be an array");
  });

  test("rejects malformed pgdelta plan IDs", async () => {
    const rpc = new FakeRpc();
    rpc.plans.push({
      status: "changes",
      plan: JSON.stringify({
        planId: "not-a-sha256",
        scope: "database",
        profile: { id: "realtime-tenant" },
        actions: [{ id: "reviewed" }],
        safetyReport: { destructiveActions: 0 },
      }),
      renderedSql: "-- reviewed",
      destructiveActions: 0,
    });
    const service = new RealtimeTenantSchemaReconcileService(rpc, new FakeStore());

    await expect(service.plan("tenant_one"))
      .rejects.toThrow("pgdelta plan has an invalid planId");
  });

  test("rejects unexpected pgdelta set metadata entries", async () => {
    const rpc = new FakeRpc();
    rpc.plans.push({
      status: "changes",
      plan: JSON.stringify({
        scope: "database",
        profile: { id: "realtime-tenant" },
        actions: [{ id: "reviewed", consumes: ["realtime"] }],
        safetyReport: { destructiveActions: 0 },
      }),
      renderedSql: "-- reviewed",
      destructiveActions: 0,
    });
    const service = new RealtimeTenantSchemaReconcileService(rpc, new FakeStore());

    await expect(service.plan("tenant_one"))
      .rejects.toThrow("pgdelta plan action consumes metadata entry must be an object");
  });

  test("rejects unknown pgdelta statuses and invalid rendered SQL", async () => {
    const rpc = new FakeRpc();
    rpc.plans.push({
      status: "future_status",
      plan: null,
      renderedSql: 42,
      destructiveActions: 0,
    } as unknown as RealtimePgdeltaPlan);
    const service = new RealtimeTenantSchemaReconcileService(rpc, new FakeStore());

    await expect(service.plan("tenant_one")).rejects.toThrow("pgdelta plan has an invalid status");
  });

  test("reports retryable partial ledger synchronization without rolling back the database ledger", async () => {
    const store = new FakeStore();
    store.inventory = emptyLegacyInventory();
    const rpc = new FakeRpc();
    rpc.plans.push(NO_CHANGES, NO_CHANGES, NO_CHANGES);
    rpc.updateError = new Error("control plane unavailable");
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    let failure: unknown;
    try {
      await service.apply(plan, {
        backupReceiptPath: await backupReceipt(),
        verifyBackupCatalog,
        allowDestructive: true,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RealtimeTenantSchemaPartialStateError);
    expect((failure as RealtimeTenantSchemaPartialStateError).phase).toBe("ledger_runtime_pending");
    expect((failure as Error).message).toContain("create a fresh plan and rerun apply");
    expect(store.inserted).toBe(true);
    expect(rpc.migrationsRan).toBe(1);
  });

  test("classifies a failed pgdelta apply as retryable schema verification state", async () => {
    const store = new FakeStore();
    store.inventory = emptyLegacyInventory();
    const rpc = new FakeRpc();
    const reviewed = changesPlan("reviewed", 0);
    rpc.plans.push(reviewed, reviewed);
    rpc.applyError = new Error("pgdelta connection dropped after DDL");
    const service = new RealtimeTenantSchemaReconcileService(rpc, store);
    const plan = await service.plan("tenant_one");

    let failure: unknown;
    try {
      await service.apply(plan, {
        backupReceiptPath: await backupReceipt(),
        verifyBackupCatalog,
        allowDestructive: true,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RealtimeTenantSchemaPartialStateError);
    expect((failure as RealtimeTenantSchemaPartialStateError).phase)
      .toBe("schema_mutation_pending_verification");
    expect((failure as Error).message).toContain("pgdelta connection dropped after DDL");
  });

  test("renders only the reviewed PostgreSQL function identities in DROP FUNCTION statements", () => {
    expect(legacyRealtimeFunctionDropStatement("realtime.notify_postgres_changes()"))
      .toBe("DROP FUNCTION realtime.notify_postgres_changes()");
    expect(legacyRealtimeFunctionDropStatement("realtime.notify_change_payload(jsonb)"))
      .toBe("DROP FUNCTION realtime.notify_change_payload(jsonb)");
    expect(() => legacyRealtimeFunctionDropStatement("realtime.unreviewed(text)"))
      .toThrow("unknown legacy Realtime function");
  });
});

describe("ContainerRealtimeTenantSchemaRpc", () => {
  test("hashes the five ordered wal_column repair files from the running Realtime release", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (argv) => {
      const joined = argv.join(" ");
      calls.push(joined);
      if (joined.includes("set -- /app/lib/realtime-*/priv/repo")) {
        return {
          exitCode: 0,
          stdout: "PGDELTA=/usr/local/bin/pgdelta\nSCHEMA=/app/lib/realtime-2.133.0/priv/repo/tenant_schema\nPROFILE=/app/lib/realtime-2.133.0/priv/repo/pgdelta_profile.json\nMANIFEST=/app/lib/realtime-2.133.0/priv/repo/tenant_schema/.pgdelta-export.json\n",
          stderr: "",
        };
      }
      const file = SCHEMA_FILES.find((candidate) => joined.endsWith(candidate.path));
      if (file) return { exitCode: 0, stdout: file.sql, stderr: "" };
      if (joined.endsWith("/.pgdelta-export.json")) {
        return { exitCode: 0, stdout: MANIFEST, stderr: "" };
      }
      if (joined.endsWith("/pgdelta_profile.json")) {
        return { exitCode: 0, stdout: PROFILE, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };
    const rpc = new ContainerRealtimeTenantSchemaRpc(runner, {
      verifyOfficialArtifacts: false,
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: 5432,
        database: "supa_tenant_one",
        username: "supabase_admin",
        password: "top-secret-database-password",
      }),
    });

    expect(await rpc.walColumnRepairArtifact()).toEqual(repairArtifact());
    expect(await rpc.walColumnRepairArtifact()).toEqual(repairArtifact());
    expect(calls.filter((call) => call.includes(" cat -- ")).length).toBe(24);
  });

  test("keeps the database password out of argv and passes it only through stdin", async () => {
    const calls: Array<{ argv: readonly string[]; stdin?: string }> = [];
    let workspace = 0;
    const planJson = JSON.stringify({ actions: [{ id: "one" }], safetyReport: { destructiveActions: 1 } });
    const runner: CommandRunner = async (argv, options = {}) => {
      calls.push({ argv, stdin: options.stdin });
      const joined = argv.join(" ");
      if (joined.includes("set -- /app/lib/realtime-*/priv/repo")) {
        return {
          exitCode: 0,
          stdout: "PGDELTA=/usr/local/bin/pgdelta\nSCHEMA=/app/lib/realtime-2.133.0/priv/repo/tenant_schema\nPROFILE=/app/lib/realtime-2.133.0/priv/repo/pgdelta_profile.json\nMANIFEST=/app/lib/realtime-2.133.0/priv/repo/tenant_schema/.pgdelta-export.json\n",
          stderr: "",
        };
      }
      const file = SCHEMA_FILES.find((candidate) => joined.endsWith(candidate.path));
      if (file) return { exitCode: 0, stdout: file.sql, stderr: "" };
      if (joined.endsWith("/pgdelta_profile.json")) return { exitCode: 0, stdout: PROFILE, stderr: "" };
      if (argv.includes("mktemp")) {
        workspace += 1;
        return { exitCode: 0, stdout: `/tmp/supacloud-realtime-reconcile.test${workspace}\n`, stderr: "" };
      }
      if (joined.endsWith("/.pgdelta-export.json")) return { exitCode: 0, stdout: MANIFEST, stderr: "" };
      if (argv.includes("cat") && joined.endsWith("/plan.json")) {
        return { exitCode: 0, stdout: planJson, stderr: "" };
      }
      if (argv.includes("render")) return { exitCode: 0, stdout: "", stderr: "" };
      if (joined.includes("plan*.sql")) return { exitCode: 0, stdout: "DROP FUNCTION legacy();\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const rpc = new ContainerRealtimeTenantSchemaRpc(runner, {
      verifyOfficialArtifacts: false,
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: 5432,
        database: "supa_tenant_one",
        username: "supabase_admin",
        password: "top-secret-database-password",
      }),
    });

    const plan = await rpc.plan("tenant_one");
    expect(plan).toMatchObject({ status: "changes", destructiveActions: 1 });
    const pgdeltaCall = calls.find((call) => call.argv.includes("--out-plan"));
    expect(pgdeltaCall?.stdin).toBe("top-secret-database-password\n");
    expect(pgdeltaCall?.argv.join(" ")).not.toContain("top-secret-database-password");
    expect(pgdeltaCall?.argv.join(" ")).toContain("postgresql://supabase_admin@127.0.0.1:5432/supa_tenant_one");
    expect(pgdeltaCall?.argv.join(" ")).toContain("--dir /tmp/supacloud-realtime-reconcile.test1/schema");
    expect(pgdeltaCall?.argv.join(" ")).not.toContain("/app/lib/realtime-2.133.0/priv/repo/tenant_schema");
    expect(calls.filter((call) => call.argv.join(" ").includes("supacloud-stage-schema")).length)
      .toBe(SCHEMA_FILES.length + 1);
  });

  test("rejects a container whose mutable tag resolves to another image digest", async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const rpc = new ContainerRealtimeTenantSchemaRpc(async (argv) => {
      mutableCalls.push([...argv]);
      if (argv.includes("inspect")) {
        return { exitCode: 0, stdout: `sha256:${"f".repeat(64)}\n`, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    }, {
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: 5432,
        database: "supa_tenant_one",
        username: "supabase_admin",
        password: "top-secret-database-password",
      }),
    });

    await expect(rpc.inspect("tenant_one")).rejects.toThrow("verified 2.133.0 digest");
    expect(calls).toHaveLength(1);
  });

  test("does not accept an official digest copied into arbitrary descriptor metadata", async () => {
    const rpc = new ContainerRealtimeTenantSchemaRpc(async (argv) => {
      if (argv.includes("inspect")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Image: `sha256:${"f".repeat(64)}`,
            Descriptor: {
              annotations: {
                note: "sha256:974f7db71f140f54c63c8d7a8d8643109704c3ee99ff735678a803fdfbfdcefb",
              },
            },
          }),
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    }, {
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: 5432,
        database: "supa_tenant_one",
        username: "supabase_admin",
        password: "top-secret-database-password",
      }),
    });

    await expect(rpc.inspect("tenant_one")).rejects.toThrow("verified 2.133.0 digest");
  });

  test("rejects conflicting known image identity fields", async () => {
    const rpc = new ContainerRealtimeTenantSchemaRpc(async (argv) => {
      if (argv.includes("inspect")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Image: "sha256:bcaec521eb08dc811d88119ee5bcac7671188d8937cffc12d3bf23c890bb636b",
            ImageDigest: `sha256:${"f".repeat(64)}`,
          }),
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    }, {
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: 5432,
        database: "supa_tenant_one",
        username: "supabase_admin",
        password: "top-secret-database-password",
      }),
    });

    await expect(rpc.inspect("tenant_one")).rejects.toThrow("verified 2.133.0 digest");
  });

  test("rejects conflicting aliases for the same known image identity field", async () => {
    const rpc = new ContainerRealtimeTenantSchemaRpc(async (argv) => {
      if (argv.includes("inspect")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Image: "sha256:bcaec521eb08dc811d88119ee5bcac7671188d8937cffc12d3bf23c890bb636b",
            ImageDigest: "sha256:974f7db71f140f54c63c8d7a8d8643109704c3ee99ff735678a803fdfbfdcefb",
            imageDigest: `sha256:${"f".repeat(64)}`,
          }),
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    }, {
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: 5432,
        database: "supa_tenant_one",
        username: "supabase_admin",
        password: "top-secret-database-password",
      }),
    });

    await expect(rpc.inspect("tenant_one")).rejects.toThrow("verified 2.133.0 digest");
  });

  test("rejects conflicts across every explicit image identity alias group", async () => {
    const officialIndex = "sha256:974f7db71f140f54c63c8d7a8d8643109704c3ee99ff735678a803fdfbfdcefb";
    const officialConfig = "bcaec521eb08dc811d88119ee5bcac7671188d8937cffc12d3bf23c890bb636b";
    const bad = `sha256:${"f".repeat(64)}`;
    const cases: Array<Record<string, unknown>> = [
      { Image: officialConfig, ImageID: bad },
      { Image: officialConfig, imageId: bad },
      { ImageDigest: officialIndex, imageDigest: bad },
      {
        Image: officialConfig,
        RepoDigests: [`public.ecr.aws/supabase/realtime@${officialIndex}`],
        repoDigests: [`public.ecr.aws/supabase/realtime@${bad}`],
      },
      {
        Image: officialConfig,
        ImageManifestDescriptor: { digest: officialIndex },
        imageManifestDescriptor: { digest: bad },
      },
      {
        Image: officialConfig,
        ImageManifestDescriptor: { digest: officialIndex, Digest: bad },
      },
    ];

    for (const inspection of cases) {
      const rpc = new ContainerRealtimeTenantSchemaRpc(async (argv) => {
        if (argv.includes("inspect")) {
          return { exitCode: 0, stdout: JSON.stringify(inspection), stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected command" };
      }, {
        resolveTarget: async () => ({
          host: "127.0.0.1",
          port: 5432,
          database: "supa_tenant_one",
          username: "supabase_admin",
          password: "top-secret-database-password",
        }),
      });

      await expect(rpc.inspect("tenant_one")).rejects.toThrow("verified 2.133.0 digest");
    }
  });

  test("does not treat the container Id as an image identity", async () => {
    const rpc = new ContainerRealtimeTenantSchemaRpc(async (argv) => {
      if (argv.includes("inspect")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Id: "974f7db71f140f54c63c8d7a8d8643109704c3ee99ff735678a803fdfbfdcefb",
            Image: "f".repeat(64),
          }),
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    }, {
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: 5432,
        database: "supa_tenant_one",
        username: "supabase_admin",
        password: "top-secret-database-password",
      }),
    });

    await expect(rpc.inspect("tenant_one")).rejects.toThrow("verified 2.133.0 digest");
  });

  test("rejects malformed non-exact digests in populated known fields", async () => {
    for (const imageDigest of [
      "junk sha256:974f7db71f140f54c63c8d7a8d8643109704c3ee99ff735678a803fdfbfdcefb trailing",
      "sha256:974f7db71f140f54c63c8d7a8d8643109704c3ee99ff735678a803fdfbfdcefbf",
    ]) {
      const rpc = new ContainerRealtimeTenantSchemaRpc(async (argv) => {
        if (argv.includes("inspect")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Image: "bcaec521eb08dc811d88119ee5bcac7671188d8937cffc12d3bf23c890bb636b",
              ImageDigest: imageDigest,
            }),
            stderr: "",
          };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected command" };
      }, {
        resolveTarget: async () => ({
          host: "127.0.0.1",
          port: 5432,
          database: "supa_tenant_one",
          username: "supabase_admin",
          password: "top-secret-database-password",
        }),
      });

      await expect(rpc.inspect("tenant_one")).rejects.toThrow("verified 2.133.0 digest");
    }
  });

  test("accepts the pinned Podman config ID and OCI index identity used by the test host", async () => {
    const rpc = new ContainerRealtimeTenantSchemaRpc(async (argv) => {
      if (argv.includes("inspect")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Id: "7e47e076f15caa923c5289a53ff5aa009ea5f0cebb1bb37f9eb0a11524ce78c1",
            Name: "supacloud-realtime",
            Image: "bcaec521eb08dc811d88119ee5bcac7671188d8937cffc12d3bf23c890bb636b",
            ImageName: "public.ecr.aws/supabase/realtime:v2.133.0",
            ImageDigest: "sha256:974f7db71f140f54c63c8d7a8d8643109704c3ee99ff735678a803fdfbfdcefb",
            Architecture: null,
            ImageManifestDescriptor: null,
            RepoDigests: null,
          }),
          stderr: "",
        };
      }
      if (argv.includes("rpc")) {
        const payload = Buffer.from(JSON.stringify({
          runtimeVersion: "2.133.0",
          tenantExternalId: "tenant_one",
          tenantMigrationsRan: 1,
          migrationVersions: RELEASE_VERSIONS,
        })).toString("base64");
        return { exitCode: 0, stdout: `__SUPACLOUD_REALTIME_RECONCILE_V1__${payload}\n`, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    }, {
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: 5432,
        database: "supa_tenant_one",
        username: "supabase_admin",
        password: "top-secret-database-password",
      }),
    });

    await expect(rpc.inspect("tenant_one")).resolves.toMatchObject({ runtimeVersion: "2.133.0" });
  });

  test("accepts the pinned Docker ARM64 index and platform manifest identity", async () => {
    const rpc = new ContainerRealtimeTenantSchemaRpc(async (argv) => {
      if (argv.includes("inspect")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Image: "sha256:974f7db71f140f54c63c8d7a8d8643109704c3ee99ff735678a803fdfbfdcefb",
            ImageManifestDescriptor: {
              digest: "sha256:172c1b386ed7b5969bd7fbce8e31b3c65050e0c39f4191bd637d6de811b81315",
              platform: { architecture: "arm64", os: "linux" },
            },
          }),
          stderr: "",
        };
      }
      if (argv.includes("rpc")) {
        const payload = Buffer.from(JSON.stringify({
          runtimeVersion: "2.133.0",
          tenantExternalId: "tenant_one",
          tenantMigrationsRan: 1,
          migrationVersions: RELEASE_VERSIONS,
        })).toString("base64");
        return { exitCode: 0, stdout: `__SUPACLOUD_REALTIME_RECONCILE_V1__${payload}\n`, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    }, {
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: 5432,
        database: "supa_tenant_one",
        username: "supabase_admin",
        password: "top-secret-database-password",
      }),
    });

    await expect(rpc.inspect("tenant_one")).resolves.toMatchObject({ runtimeVersion: "2.133.0" });
  });

  test("rejects an official manifest when it does not match the inspected architecture", async () => {
    const rpc = new ContainerRealtimeTenantSchemaRpc(async (argv) => {
      if (argv.includes("inspect")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Image: "sha256:974f7db71f140f54c63c8d7a8d8643109704c3ee99ff735678a803fdfbfdcefb",
            ImageManifestDescriptor: {
              digest: "sha256:109c6ea8ecd6c84c3b36047fe78a055c27702f6d9e19c441958b129a9bd468c3",
              platform: { architecture: "arm64", os: "linux" },
            },
          }),
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    }, {
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: 5432,
        database: "supa_tenant_one",
        username: "supabase_admin",
        password: "top-secret-database-password",
      }),
    });

    await expect(rpc.inspect("tenant_one")).rejects.toThrow("verified 2.133.0 digest");
  });

  test("keeps the database password out of apply argv", async () => {
    const calls: Array<{ argv: readonly string[]; stdin?: string }> = [];
    const runner: CommandRunner = async (argv, options = {}) => {
      calls.push({ argv, stdin: options.stdin });
      const joined = argv.join(" ");
      if (joined.includes("set -- /app/lib/realtime-*/priv/repo")) {
        return {
          exitCode: 0,
          stdout: "PGDELTA=/usr/local/bin/pgdelta\nSCHEMA=/app/lib/realtime-2.133.0/priv/repo/tenant_schema\nPROFILE=/app/lib/realtime-2.133.0/priv/repo/pgdelta_profile.json\nMANIFEST=/app/lib/realtime-2.133.0/priv/repo/tenant_schema/.pgdelta-export.json\n",
          stderr: "",
        };
      }
      const file = SCHEMA_FILES.find((candidate) => joined.endsWith(candidate.path));
      if (file) return { exitCode: 0, stdout: file.sql, stderr: "" };
      if (joined.endsWith("/pgdelta_profile.json")) return { exitCode: 0, stdout: PROFILE, stderr: "" };
      if (argv.includes("mktemp")) {
        return { exitCode: 0, stdout: "/tmp/supacloud-realtime-reconcile.apply1\n", stderr: "" };
      }
      if (joined.endsWith("/.pgdelta-export.json")) return { exitCode: 0, stdout: MANIFEST, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const rpc = new ContainerRealtimeTenantSchemaRpc(runner, {
      verifyOfficialArtifacts: false,
      resolveTarget: async () => ({
        host: "127.0.0.1",
        port: 5432,
        database: "supa_tenant_one",
        username: "supabase_admin",
        password: "top-secret-database-password",
      }),
    });

    await rpc.applyPlan("tenant_one", JSON.stringify({ actions: [{ id: "one" }] }));

    const pgdeltaCall = calls.find((call) => call.argv.includes("apply"));
    expect(pgdeltaCall?.stdin).toBe("top-secret-database-password\n");
    expect(pgdeltaCall?.argv.join(" ")).toContain("postgresql://supabase_admin@127.0.0.1:5432/supa_tenant_one");
    expect(calls.every((call) => !call.argv.join(" ").includes("top-secret-database-password"))).toBe(true);
  });
});
