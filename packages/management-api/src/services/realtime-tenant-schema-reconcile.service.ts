import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { lstat, readFile } from "node:fs/promises";

const RPC_SENTINEL = "__SUPACLOUD_REALTIME_RECONCILE_V1__";
const PROJECT_REF_PATTERN = /^[a-zA-Z0-9_-]{1,96}$/;
const VERSION_PATTERN = /^\d{14}$/;
const PGDELTA_PLAN_ID_PATTERN = /^[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DATABASE_SYSTEM_IDENTIFIER_PATTERN = /^\d{1,20}$/;
const DATABASE_OID_PATTERN = /^[1-9]\d{0,9}$/;
const REPLACEMENT_EPOCH_PATTERN = /^(none|[0-9a-f]{64})$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const OFFICIAL_REALTIME_RUNTIME_VERSION = "2.133.0";
const OFFICIAL_REALTIME_MANIFEST_SHA256 =
  "4cbd8c1a606febe2c8740ca5e1ff3f2026a9db34ea09aec537457f901fb8382a";
const OFFICIAL_REALTIME_PROFILE_SHA256 =
  "6aa438f04e2960df7e1fe4515e99e6d527271f248129fe07d61fe8d27872dafd";
const OFFICIAL_REALTIME_SCHEMA_TREE_SHA256 =
  "1f82dfc5cc6f68d04f1cffe0c7ed29c93dd0e9271647be02c46622fe2947e19f";
const OFFICIAL_PGDELTA_WRAPPER_SHA256 =
  "65a2ac788d7b2f4f177b759b37642c9e5d0c2c4841b2d0e611f2e31be995d799";
const OFFICIAL_PGDELTA_BUNDLE_SHA256_BY_ARCH = {
  aarch64: "0b6d8b76389bd06edb10f5baf4c5b6a1abf53e08475b53d5eb08a550a66ae206",
  arm64: "0b6d8b76389bd06edb10f5baf4c5b6a1abf53e08475b53d5eb08a550a66ae206",
  x86_64: "a6e37b881ad25b64358747a848cc381a9e81295add4de325716741411b0f38e4",
  amd64: "a6e37b881ad25b64358747a848cc381a9e81295add4de325716741411b0f38e4",
} as const;
const OFFICIAL_PGDELTA_EXPANDED_SHA256_BY_ARCH = {
  aarch64: "e2a20edc8cf280f68524357471fd5245cd0ad0c6bc7114cbfde3cc439f904529",
  arm64: "e2a20edc8cf280f68524357471fd5245cd0ad0c6bc7114cbfde3cc439f904529",
  x86_64: "9a565254d7e03b77c8424b74a13941518bb5cfeb80d06995175fd9f06e2ee6a8",
  amd64: "9a565254d7e03b77c8424b74a13941518bb5cfeb80d06995175fd9f06e2ee6a8",
} as const;
// The image digest is part of the reviewed release identity. A mutable tag is
// not sufficient for a destructive tenant-schema reconciliation.
export const OFFICIAL_REALTIME_IMAGE_DIGEST =
  "sha256:974f7db71f140f54c63c8d7a8d8643109704c3ee99ff735678a803fdfbfdcefb";
const OFFICIAL_REALTIME_IMAGE_MANIFEST_DIGEST_BY_ARCH = {
  amd64: "sha256:109c6ea8ecd6c84c3b36047fe78a055c27702f6d9e19c441958b129a9bd468c3",
  arm64: "sha256:172c1b386ed7b5969bd7fbce8e31b3c65050e0c39f4191bd637d6de811b81315",
} as const;
const OFFICIAL_REALTIME_IMAGE_CONFIG_DIGEST_BY_ARCH = {
  amd64: "sha256:bcaec521eb08dc811d88119ee5bcac7671188d8937cffc12d3bf23c890bb636b",
  arm64: "sha256:1ee6d7247f3f3809289524539cd06f6f86d4c50e5639d1ef28f388a9e4fefaa4",
} as const;
export type EffectiveAclEntry = [grantee: string, grantor: string, privilege: string, grantable: boolean];

const OFFICIAL_WAL_COLUMN_TYPE_EFFECTIVE_ACL: EffectiveAclEntry[] = [
  ["PUBLIC", "supabase_realtime_admin", "USAGE", false],
  ["supabase_realtime_admin", "supabase_realtime_admin", "USAGE", false],
];
const OFFICIAL_WAL_COLUMN_RELATION_EFFECTIVE_ACL: EffectiveAclEntry[] = [
  ["supabase_realtime_admin", "supabase_realtime_admin", "DELETE", false],
  ["supabase_realtime_admin", "supabase_realtime_admin", "INSERT", false],
  ["supabase_realtime_admin", "supabase_realtime_admin", "MAINTAIN", false],
  ["supabase_realtime_admin", "supabase_realtime_admin", "REFERENCES", false],
  ["supabase_realtime_admin", "supabase_realtime_admin", "SELECT", false],
  ["supabase_realtime_admin", "supabase_realtime_admin", "TRIGGER", false],
  ["supabase_realtime_admin", "supabase_realtime_admin", "TRUNCATE", false],
  ["supabase_realtime_admin", "supabase_realtime_admin", "UPDATE", false],
];
const OFFICIAL_WAL_COLUMN_REPAIR_FILE_SHA256 = new Map([
  ["realtime/types/wal_column.sql", "3a0205ed600f2d511fb05730d2cd1493319c921e922b72c782b0c6e3293a4a9d"],
  ["realtime/functions/apply_rls.sql", "5c4c0651d8afa23b9ee7717e6b5255e122ff27674b525624faa97e6fbef0fb64"],
  ["realtime/functions/build_prepared_statement_sql.sql", "c743ecfcd3a6cc04f2fdfd857089a4510ecfea132bb3e76415de8a1aeb8fc360"],
  ["realtime/functions/is_visible_through_filters.sql", "618cf92ec9809baf48f2d15aa7890112bdb89272694c34b4c26b307aaf8e3538"],
  ["realtime/functions/list_changes.sql", "24bcf1dbb76f5fc40c2fcc4650b15b5d0b5528fb86fb651e1e6efb94cda31f92"],
]);
const OFFICIAL_WAL_COLUMN_REPAIR_AGGREGATE_SHA256 =
  "c7ca6e42fbcb9a6e3ab981bef6577b7911692df322ceb09b1530706871a92d8b";

export type PgdeltaStatus = "changes" | "no_changes";

export interface RealtimeRuntimeSnapshot {
  runtimeVersion: string;
  tenantExternalId: string;
  tenantMigrationsRan: number;
  migrationVersions: string[];
}

export type RealtimeReplacementJournalState = "inactive" | "active";

/**
 * Physical identity of the database selected for a tenant. Database names are
 * reusable after DROP/CREATE, so the PostgreSQL system identifier and database
 * OID are required for a meaningful compare-and-swap check. The replacement
 * journal state/epoch closes the control-plane race while a branch promotion is
 * switching names.
 */
export interface RealtimeTenantDatabaseIdentity {
  projectRef: string;
  databaseName: string;
  systemIdentifier: string;
  databaseOid: string;
  replacementJournalEpoch: string;
  replacementJournalState: RealtimeReplacementJournalState;
  replacementJournalPhase: string | null;
}

export interface RealtimePgdeltaPlan {
  status: PgdeltaStatus;
  plan: string | null;
  renderedSql: string;
  destructiveActions: number;
}

export type RealtimeWalColumnShape = "canonical" | "legacy" | "corrupted_dropped_attribute";

export interface RealtimeWalColumnAttribute {
  attnum: number;
  name: string | null;
  type: string | null;
  dropped: boolean;
}

export interface RealtimeWalColumnFunction {
  identity: string;
  owner: string;
  acl: string | null;
  effectiveAcl: EffectiveAclEntry[];
  definitionSha256: string;
}

export interface RealtimeWalColumnStoredReference {
  schema: string;
  relation: string;
  column: string;
  type: string;
}

export interface RealtimeWalColumnInspection {
  shape: RealtimeWalColumnShape;
  attributes: RealtimeWalColumnAttribute[];
  owner: string;
  acl: string | null;
  effectiveAcl: EffectiveAclEntry[];
  relationOwner: string;
  relationAcl: string | null;
  effectiveRelationAcl: EffectiveAclEntry[];
  functions: RealtimeWalColumnFunction[];
  storedColumnReferences: RealtimeWalColumnStoredReference[];
  staleRepairTypeExists: boolean;
  staleRepairFunctionOverloads: string[];
}

export interface RealtimeWalColumnRepairArtifact {
  sha256: string;
  manifestSha256: string;
  manifestLoadOrder: string[];
  profileSha256: string;
  profileContents?: string;
  /** Complete reviewed manifest tree, not only the five repair files. */
  schemaTreeSha256?: string;
  schemaFiles?: Array<{ path: string; sql: string }>;
  manifestContents?: string;
  files: Array<{ path: string; sql: string }>;
}

export interface RealtimeWalColumnRepairIntent {
  action: "none" | "rebuild_from_release";
  artifactSha256: string;
  manifestSha256: string;
  manifestLoadOrder: string[];
  schemaTreeSha256: string;
  profileSha256: string;
  imageDigest: string;
}

export interface RealtimeTenantSchemaPlanFile {
  formatVersion: 3;
  projectRef: string;
  generatedAt: string;
  runtimeVersion: string;
  databaseIdentity: RealtimeTenantDatabaseIdentity;
  migrationVersions: string[];
  tenantMigrationsRan: number;
  tenantLedgerVersions: string[];
  legacyRealtimeObjects: LegacyRealtimeObjectInventory;
  walColumn: RealtimeWalColumnInspection;
  walColumnRepair: RealtimeWalColumnRepairIntent;
  pgdelta: RealtimePgdeltaPlan;
  planSha256: string;
}

export interface RealtimeTenantSchemaInspection extends RealtimeRuntimeSnapshot {
  databaseIdentity: RealtimeTenantDatabaseIdentity;
  tenantLedgerVersions: string[];
  legacyRealtimeObjects: LegacyRealtimeObjectInventory;
  walColumn: RealtimeWalColumnInspection;
  ledgerComplete: boolean;
}

export interface RealtimeTenantSchemaReconcileStore {
  inspectDatabaseIdentity(projectRef: string): Promise<RealtimeTenantDatabaseIdentity>;
  readTenantLedger(projectRef: string): Promise<string[]>;
  inspectLegacyRealtimeObjects(projectRef: string): Promise<LegacyRealtimeObjectInventory>;
  removeKnownLegacyRealtimeObjects(
    projectRef: string,
    inventory: LegacyRealtimeObjectInventory,
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<number>;
  inspectWalColumn(projectRef: string): Promise<RealtimeWalColumnInspection>;
  rebuildWalColumn(
    projectRef: string,
    expected: RealtimeWalColumnInspection,
    artifact: RealtimeWalColumnRepairArtifact,
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<void>;
  insertTenantLedgerVersions(
    projectRef: string,
    versions: readonly string[],
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<void>;
}

export interface RealtimeTenantDatabaseTarget {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode?: "disable" | "require";
}

export interface LegacyRealtimeObjectInventory {
  eventTriggers: Array<{
    oid: string;
    name: string;
    event: string;
    functionIdentity: string;
    functionOid: string;
    functionDefinitionSha256: string;
    definitionSha256: string;
  }>;
  tableTriggers: Array<{
    oid: string;
    relationOid: string;
    schema: string;
    table: string;
    name: string;
    functionIdentity: string;
    functionOid: string;
    functionDefinitionSha256: string;
    definitionSha256: string;
    row: boolean;
    before: boolean;
    instead: boolean;
    insert: boolean;
    update: boolean;
    delete: boolean;
    truncate: boolean;
  }>;
  functions: string[];
  functionDetails: Array<{
    identity: string;
    oid: string;
    definitionSha256: string;
  }>;
}

export interface RealtimeTenantSchemaRpc {
  inspect(projectRef: string): Promise<RealtimeRuntimeSnapshot>;
  walColumnRepairArtifact(): Promise<RealtimeWalColumnRepairArtifact>;
  plan(
    projectRef: string,
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<RealtimePgdeltaPlan>;
  applyPlan(
    projectRef: string,
    plan: string,
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<void>;
  updateMigrationsRan(
    projectRef: string,
    count: number,
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<void>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  argv: readonly string[],
  options?: { stdin?: string },
) => Promise<CommandResult>;

export interface ApplyRealtimeTenantSchemaOptions {
  backupReceiptPath?: string;
  allowDestructive?: boolean;
  dryRun?: boolean;
  verifyBackupCatalog?: RealtimeBackupCatalogVerifier;
}

export interface RealtimeBackupReceipt {
  schema: "supacloud.realtime-tenant-schema-backup.v1";
  kind: "realtime-tenant-schema";
  backup_id: string;
  project_ref: string;
  database_name: string;
  system_identifier: string;
  database_oid: string;
  replacement_journal_epoch: string;
  replacement_journal_state: RealtimeReplacementJournalState;
  archive_path: string;
  archive_bytes: number;
  archive_sha256: string;
  catalog_verified: true;
  catalog_path: string;
  catalog_sha256: string;
  catalog_entries: number;
  created_at: string;
}

export interface RealtimeBackupCatalogVerificationResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

export type RealtimeBackupCatalogVerifier = (
  archivePath: string,
) => Promise<RealtimeBackupCatalogVerificationResult>;

export type RealtimeTenantSchemaRecoveryPhase =
  | "schema_mutation_pending_verification"
  | "schema_converged_ledger_pending"
  | "ledger_runtime_pending"
  | "ledger_verification_pending";

export class RealtimeTenantSchemaPartialStateError extends Error {
  readonly retryable = true;

  constructor(
    readonly phase: RealtimeTenantSchemaRecoveryPhase,
    readonly projectRef: string,
    message: string,
    readonly databaseIdentity?: RealtimeTenantDatabaseIdentity,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RealtimeTenantSchemaPartialStateError";
  }
}

export interface ApplyRealtimeTenantSchemaResult {
  dryRun: boolean;
  schemaApplied: boolean;
  ledgerSynchronized: boolean;
  inspection: RealtimeTenantSchemaInspection;
}

function assertProjectRef(projectRef: string): void {
  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    throw new Error("project ref must contain only letters, numbers, underscores, or hyphens");
  }
}

function assertRealtimeTenantDatabaseIdentity(
  identity: RealtimeTenantDatabaseIdentity,
  expectedProjectRef?: string,
): void {
  if (!identity || typeof identity !== "object") {
    throw new Error("Realtime tenant database identity is missing");
  }
  if (typeof identity.projectRef !== "string") throw new Error("Realtime tenant database identity has no project ref");
  assertProjectRef(identity.projectRef);
  if (expectedProjectRef !== undefined && identity.projectRef !== expectedProjectRef) {
    throw new Error("Realtime tenant database identity belongs to a different project");
  }
  if (
    typeof identity.databaseName !== "string"
    || identity.databaseName.length === 0
    || identity.databaseName.length > 128
    || /[\u0000-\u001f\u007f]/u.test(identity.databaseName)
  ) {
    throw new Error("Realtime tenant database identity has an invalid database name");
  }
  if (!DATABASE_SYSTEM_IDENTIFIER_PATTERN.test(identity.systemIdentifier)) {
    throw new Error("Realtime tenant database identity has an invalid PostgreSQL system identifier");
  }
  if (!DATABASE_OID_PATTERN.test(identity.databaseOid)) {
    throw new Error("Realtime tenant database identity has an invalid PostgreSQL database OID");
  }
  if (!REPLACEMENT_EPOCH_PATTERN.test(identity.replacementJournalEpoch)) {
    throw new Error("Realtime tenant database identity has an invalid replacement-journal epoch");
  }
  if (identity.replacementJournalState !== "inactive" && identity.replacementJournalState !== "active") {
    throw new Error("Realtime tenant database identity has an invalid replacement-journal state");
  }
  if (identity.replacementJournalPhase !== null && typeof identity.replacementJournalPhase !== "string") {
    throw new Error("Realtime tenant database identity has an invalid replacement-journal phase");
  }
}

function sameRealtimeTenantDatabaseIdentity(
  left: RealtimeTenantDatabaseIdentity,
  right: RealtimeTenantDatabaseIdentity,
): boolean {
  return left.projectRef === right.projectRef
    && left.databaseName === right.databaseName
    && left.systemIdentifier === right.systemIdentifier
    && left.databaseOid === right.databaseOid
    && left.replacementJournalEpoch === right.replacementJournalEpoch
    && left.replacementJournalState === right.replacementJournalState
    && left.replacementJournalPhase === right.replacementJournalPhase;
}

function assertReplacementJournalInactive(identity: RealtimeTenantDatabaseIdentity, stage: string): void {
  if (identity.replacementJournalState !== "inactive") {
    throw new Error(
      `database replacement journal is active during ${stage} (${identity.replacementJournalPhase || "unknown phase"}); reconciliation is blocked`,
    );
  }
}

function assertCanonicalUtcTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is not a canonical UTC timestamp`);
  }
}

function assertBackupReceiptShape(value: unknown): asserts value is RealtimeBackupReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Realtime backup receipt has an invalid shape");
  }
  const receipt = value as Record<string, unknown>;
  const expectedKeys = [
    "schema", "kind", "backup_id", "project_ref", "database_name", "system_identifier",
    "database_oid", "replacement_journal_epoch", "replacement_journal_state", "archive_path",
    "archive_bytes", "archive_sha256", "catalog_verified", "catalog_path", "catalog_sha256",
    "catalog_entries", "created_at",
  ].sort();
  const actualKeys = Object.keys(receipt).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || receipt.schema !== "supacloud.realtime-tenant-schema-backup.v1"
    || receipt.kind !== "realtime-tenant-schema"
    || typeof receipt.backup_id !== "string"
    || !/^[A-Za-z0-9_.-]{1,128}$/.test(receipt.backup_id)
    || typeof receipt.project_ref !== "string"
    || typeof receipt.database_name !== "string"
    || typeof receipt.system_identifier !== "string"
    || typeof receipt.database_oid !== "string"
    || typeof receipt.replacement_journal_epoch !== "string"
    || (receipt.replacement_journal_state !== "inactive" && receipt.replacement_journal_state !== "active")
    || typeof receipt.archive_path !== "string"
    || !receipt.archive_path
    || isAbsolute(receipt.archive_path)
    || receipt.archive_path.includes("\\")
    || receipt.archive_path.split("/").includes("..")
    || !Number.isSafeInteger(receipt.archive_bytes)
    || Number(receipt.archive_bytes) <= 0
    || typeof receipt.archive_sha256 !== "string"
    || !SHA256_PATTERN.test(receipt.archive_sha256)
    || receipt.catalog_verified !== true
    || typeof receipt.catalog_path !== "string"
    || !receipt.catalog_path
    || isAbsolute(receipt.catalog_path)
    || receipt.catalog_path.includes("\\")
    || receipt.catalog_path.split("/").includes("..")
    || typeof receipt.catalog_sha256 !== "string"
    || !SHA256_PATTERN.test(receipt.catalog_sha256)
    || !Number.isSafeInteger(receipt.catalog_entries)
    || Number(receipt.catalog_entries) < 0
  ) {
    throw new Error("Realtime backup receipt has invalid identity or archive evidence");
  }
  assertProjectRef(receipt.project_ref);
  assertRealtimeTenantDatabaseIdentity({
    projectRef: receipt.project_ref,
    databaseName: receipt.database_name,
    systemIdentifier: receipt.system_identifier,
    databaseOid: receipt.database_oid,
    replacementJournalEpoch: receipt.replacement_journal_epoch,
    replacementJournalState: receipt.replacement_journal_state,
    replacementJournalPhase: null,
  });
  assertCanonicalUtcTimestamp(receipt.created_at, "Realtime backup receipt created_at");
}

/**
 * Validate a durable backup receipt and its archive bytes. Catalog validation is
 * represented by the receipt's pg_restore --list evidence; callers that can
 * execute pg_restore should additionally pass a verifier and compare the
 * resulting catalog digest before invoking this function.
 */
export async function validateRealtimeBackupReceipt(
  receiptOrDirectory: string,
  expectedIdentity?: RealtimeTenantDatabaseIdentity,
  options: { verifyCatalog?: RealtimeBackupCatalogVerifier } = {},
): Promise<RealtimeBackupReceipt> {
  if (!receiptOrDirectory || !isAbsolute(receiptOrDirectory)) {
    throw new Error("backup receipt path must be absolute");
  }
  const metadata = await lstat(receiptOrDirectory).catch(() => null);
  if (!metadata || (metadata.isSymbolicLink() === true)) {
    throw new Error("backup receipt path must reference a regular file or directory");
  }
  const receiptPath = metadata.isDirectory() ? join(receiptOrDirectory, "receipt.json") : receiptOrDirectory;
  const rootMetadata = metadata.isDirectory() ? metadata : await lstat(dirname(receiptPath));
  const effectiveUid = process.geteuid?.();
  if (
    !rootMetadata.isDirectory()
    || (effectiveUid !== undefined && rootMetadata.uid !== 0 && rootMetadata.uid !== effectiveUid)
    || (rootMetadata.mode & 0o022) !== 0
  ) {
    throw new Error("Realtime backup receipt directory is not trusted");
  }
  const receiptMetadata = await lstat(receiptPath).catch(() => null);
  if (
    !receiptMetadata
    || !receiptMetadata.isFile()
    || receiptMetadata.isSymbolicLink()
    || (effectiveUid !== undefined && receiptMetadata.uid !== 0 && receiptMetadata.uid !== effectiveUid)
    || (receiptMetadata.mode & 0o022) !== 0
  ) {
    throw new Error("backup receipt path must reference an existing receipt.json file");
  }
  if (receiptMetadata.size <= 0 || receiptMetadata.size > 64 * 1024) {
    throw new Error("Realtime backup receipt size is invalid");
  }
  const serialized = await readFile(receiptPath, "utf8");
  const rereadMetadata = await lstat(receiptPath);
  if (
    rereadMetadata.dev !== receiptMetadata.dev
    || rereadMetadata.ino !== receiptMetadata.ino
    || rereadMetadata.size !== receiptMetadata.size
    || rereadMetadata.mtimeMs !== receiptMetadata.mtimeMs
    || rereadMetadata.ctimeMs !== receiptMetadata.ctimeMs
  ) {
    throw new Error("Realtime backup receipt changed while it was read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Realtime backup receipt is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertBackupReceiptShape(parsed);
  const receipt = parsed as RealtimeBackupReceipt;
  if (expectedIdentity) {
    assertRealtimeTenantDatabaseIdentity(expectedIdentity, receipt.project_ref);
    assertReplacementJournalInactive(expectedIdentity, "backup receipt validation");
    if (
      receipt.database_name !== expectedIdentity.databaseName
      || receipt.system_identifier !== expectedIdentity.systemIdentifier
      || receipt.database_oid !== expectedIdentity.databaseOid
      || receipt.replacement_journal_epoch !== expectedIdentity.replacementJournalEpoch
      || receipt.replacement_journal_state !== expectedIdentity.replacementJournalState
    ) {
      throw new Error("Realtime backup receipt does not match the reviewed database identity");
    }
  }
  const root = dirname(receiptPath);
  const archivePath = resolve(root, receipt.archive_path);
  const archiveRelative = relative(root, archivePath);
  if (!archiveRelative || archiveRelative.startsWith("..") || isAbsolute(archiveRelative)) {
    throw new Error("Realtime backup receipt archive path escapes its receipt directory");
  }
  const archiveMetadata = await lstat(archivePath).catch(() => null);
  if (
    !archiveMetadata
    || !archiveMetadata.isFile()
    || archiveMetadata.isSymbolicLink()
    || (effectiveUid !== undefined && archiveMetadata.uid !== 0 && archiveMetadata.uid !== effectiveUid)
    || (archiveMetadata.mode & 0o022) !== 0
  ) {
    throw new Error("Realtime backup archive is not a regular file");
  }
  if (archiveMetadata.size !== receipt.archive_bytes) {
    throw new Error("Realtime backup archive byte count does not match its receipt");
  }
  const archive = await readFile(archivePath);
  const rereadArchiveMetadata = await lstat(archivePath);
  if (
    rereadArchiveMetadata.dev !== archiveMetadata.dev
    || rereadArchiveMetadata.ino !== archiveMetadata.ino
    || rereadArchiveMetadata.size !== archiveMetadata.size
    || rereadArchiveMetadata.mtimeMs !== archiveMetadata.mtimeMs
    || rereadArchiveMetadata.ctimeMs !== archiveMetadata.ctimeMs
  ) {
    throw new Error("Realtime backup archive changed while it was read");
  }
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  if (archiveSha256 !== receipt.archive_sha256) {
    throw new Error("Realtime backup archive SHA-256 does not match its receipt");
  }
  const catalogPath = resolve(root, receipt.catalog_path);
  const catalogRelative = relative(root, catalogPath);
  if (!catalogRelative || catalogRelative.startsWith("..") || isAbsolute(catalogRelative)) {
    throw new Error("Realtime backup catalog path escapes its receipt directory");
  }
  const catalogMetadata = await lstat(catalogPath).catch(() => null);
  if (
    !catalogMetadata
    || !catalogMetadata.isFile()
    || catalogMetadata.isSymbolicLink()
    || (effectiveUid !== undefined && catalogMetadata.uid !== 0 && catalogMetadata.uid !== effectiveUid)
    || (catalogMetadata.mode & 0o022) !== 0
    || catalogMetadata.size <= 0
    || catalogMetadata.size > 16 * 1024 * 1024
  ) {
    throw new Error("Realtime backup pg_restore catalog evidence is not trusted");
  }
  const catalog = await readFile(catalogPath);
  const catalogSha256 = createHash("sha256").update(catalog).digest("hex");
  const catalogText = catalog.toString("utf8");
  const catalogEntries = countBackupCatalogEntries(catalogText);
  if (catalogSha256 !== receipt.catalog_sha256 || catalogEntries !== receipt.catalog_entries) {
    throw new Error("Realtime backup pg_restore catalog evidence does not match its receipt");
  }
  if (options.verifyCatalog) {
    const verification = await options.verifyCatalog(archivePath);
    if (
      !verification
      || verification.exitCode !== 0
      || typeof verification.stdout !== "string"
    ) {
      const detail = typeof verification?.stderr === "string" ? `: ${verification.stderr.trim().slice(-1_000)}` : "";
      throw new Error(`Realtime backup pg_restore catalog verification failed${detail}`);
    }
    const verifiedCatalog = Buffer.from(verification.stdout, "utf8");
    const verifiedSha256 = createHash("sha256").update(verifiedCatalog).digest("hex");
    const verifiedEntries = countBackupCatalogEntries(verification.stdout);
    if (
      verifiedSha256 !== receipt.catalog_sha256
      || verifiedEntries !== receipt.catalog_entries
      || verification.stdout !== catalogText
    ) {
      throw new Error("Realtime backup pg_restore catalog output changed from its receipt evidence");
    }
    const rereadArchiveMetadata = await lstat(archivePath).catch(() => null);
    if (
      !rereadArchiveMetadata
      || !rereadArchiveMetadata.isFile()
      || rereadArchiveMetadata.isSymbolicLink()
      || rereadArchiveMetadata.dev !== archiveMetadata.dev
      || rereadArchiveMetadata.ino !== archiveMetadata.ino
      || rereadArchiveMetadata.size !== archiveMetadata.size
      || rereadArchiveMetadata.mtimeMs !== archiveMetadata.mtimeMs
      || rereadArchiveMetadata.ctimeMs !== archiveMetadata.ctimeMs
    ) {
      throw new Error("Realtime backup archive changed during catalog verification");
    }
    const rereadArchive = await readFile(archivePath);
    if (createHash("sha256").update(rereadArchive).digest("hex") !== receipt.archive_sha256) {
      throw new Error("Realtime backup archive SHA-256 changed during catalog verification");
    }
  }
  return receipt;
}

function countBackupCatalogEntries(value: string): number {
  return value.split(/\r?\n/).filter((line) => line.trim().length > 0 && !line.startsWith(";")).length;
}

function normalizeVersions(versions: readonly string[], label: string): string[] {
  const normalized = versions.map(String);
  if (normalized.some((version) => !VERSION_PATTERN.test(version))) {
    throw new Error(`${label} contains an invalid migration version`);
  }
  const unique = [...new Set(normalized)];
  if (unique.length !== normalized.length) {
    throw new Error(`${label} contains duplicate migration versions`);
  }
  return unique.sort();
}

function assertKnownLedger(
  ledgerVersions: readonly string[],
  officialVersions: readonly string[],
): void {
  const official = new Set(officialVersions);
  const unknown = ledgerVersions.filter((version) => !official.has(version));
  if (unknown.length > 0) {
    throw new Error(
      `tenant Realtime ledger contains ${unknown.length} version(s) unknown to the running release; refusing reconciliation`,
    );
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const PGDELTA_SET_METADATA_KEYS = new Set(["consumes", "produces", "destroys", "releases"]);

function canonicalizeJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`pgdelta plan contains a non-finite number at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalizeJsonValue(entry, `${path}[${index}]`));
  }
  if (typeof value !== "object") {
    throw new Error(`pgdelta plan contains an unsupported value at ${path}`);
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [
      key,
      canonicalizeJsonValue(record[key], `${path}.${key}`),
    ]),
  );
}

function canonicalizePgdeltaAction(value: unknown, index: number): JsonValue {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`pgdelta plan action ${index} must be an object`);
  }
  const action = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(action).sort().map((key) => {
      const path = `$.actions[${index}].${key}`;
      if (!PGDELTA_SET_METADATA_KEYS.has(key)) {
        return [key, canonicalizeJsonValue(action[key], path)];
      }
      if (!Array.isArray(action[key])) {
        throw new Error(`pgdelta plan action ${key} metadata must be an array`);
      }
      const entries = action[key].map((entry, entryIndex) => {
        if (entry === null || Array.isArray(entry) || typeof entry !== "object") {
          throw new Error(`pgdelta plan action ${key} metadata entry must be an object`);
        }
        return canonicalizeJsonValue(entry, `${path}[${entryIndex}]`);
      });
      entries.sort((left, right) => {
        const leftJson = JSON.stringify(left);
        const rightJson = JSON.stringify(right);
        return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
      });
      return [key, entries];
    }),
  );
}

function canonicalPgdeltaPlan(plan: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(plan);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`pgdelta emitted an invalid plan for checksum: ${message}`);
  }
  if (decoded === null || Array.isArray(decoded) || typeof decoded !== "object") {
    throw new Error("pgdelta plan root must be an object");
  }
  const root = decoded as Record<string, unknown>;
  const actions = root.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("pgdelta plan actions must be a non-empty array");
  }
  if (
    root.planId !== undefined
    && (typeof root.planId !== "string" || !PGDELTA_PLAN_ID_PATTERN.test(root.planId))
  ) {
    throw new Error("pgdelta plan has an invalid planId");
  }
  const canonical = Object.fromEntries(
    Object.keys(root).filter((key) => key !== "planId").sort().map((key) => [
      key,
      key === "actions"
        ? actions.map((action, index) => canonicalizePgdeltaAction(action, index))
        : canonicalizeJsonValue(root[key], `$.${key}`),
    ]),
  );
  return JSON.stringify(canonical);
}

function pgdeltaPlanHash(plan: string | null): string {
  return createHash("sha256").update(plan === null ? "" : canonicalPgdeltaPlan(plan)).digest("hex");
}

function canonicalPgdeltaPlanValue(plan: RealtimePgdeltaPlan): JsonValue {
  return {
    status: plan.status,
    plan: plan.plan === null ? null : JSON.parse(canonicalPgdeltaPlan(plan.plan)) as JsonValue,
    renderedSql: plan.renderedSql,
    destructiveActions: plan.destructiveActions,
  };
}

/**
 * Hash every reviewed semantic input, not just pgdelta's opaque plan. This
 * prevents an operator from editing the status/rendered SQL, catalog snapshot,
 * artifact identity, or target database binding while retaining a valid digest.
 */
function realtimeTenantSchemaPlanDigest(
  plan: Omit<RealtimeTenantSchemaPlanFile, "planSha256">,
): string {
  const payload = {
    ...plan,
    pgdelta: canonicalPgdeltaPlanValue(plan.pgdelta),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeJsonValue(payload, "$")))
    .digest("hex");
}

function samePgdeltaPlan(left: RealtimePgdeltaPlan, right: RealtimePgdeltaPlan): boolean {
  return left.status === right.status
    && left.renderedSql === right.renderedSql
    && left.destructiveActions === right.destructiveActions
    && (left.plan === null
      ? right.plan === null
      : right.plan !== null && pgdeltaPlanHash(left.plan) === pgdeltaPlanHash(right.plan));
}

function assertSecretFreePlan(plan: RealtimePgdeltaPlan, sensitiveValues: readonly string[]): void {
  const serialized = JSON.stringify(plan);
  if (/postgres(?:ql)?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(serialized)) {
    throw new Error("pgdelta plan contains a database URL with embedded credentials");
  }
  if (/\b(?:db_?password|password)\s*[=:]\s*["']?[^\s,"'}]+/i.test(serialized)) {
    throw new Error("pgdelta plan contains password-like material");
  }
  for (const secret of sensitiveValues) {
    if (secret.length >= 12 && serialized.includes(secret)) {
      throw new Error("pgdelta plan contains a configured sensitive value");
    }
  }
}

function assertPlanShape(plan: RealtimePgdeltaPlan): void {
  if (plan.status !== "changes" && plan.status !== "no_changes") {
    throw new Error("pgdelta plan has an invalid status");
  }
  if (typeof plan.renderedSql !== "string") {
    throw new Error("pgdelta plan has invalid rendered SQL");
  }
  if (!Number.isSafeInteger(plan.destructiveActions) || plan.destructiveActions < 0) {
    throw new Error("pgdelta returned an invalid destructive action count");
  }
  if (plan.status === "changes") {
    if (typeof plan.plan !== "string" || plan.plan.length === 0) {
      throw new Error("pgdelta reported changes without an apply plan");
    }
    try {
      const decoded = JSON.parse(plan.plan) as {
        actions?: unknown;
        profile?: { id?: unknown };
        scope?: unknown;
      };
      if (!Array.isArray(decoded.actions) || decoded.actions.length === 0) {
        throw new Error("plan actions are empty");
      }
      if (decoded.profile?.id !== "realtime-tenant" || decoded.scope !== "database") {
        throw new Error("pgdelta plan is not bound to the realtime-tenant database profile");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`pgdelta emitted an invalid plan: ${message}`);
    }
  } else if (plan.plan !== null || plan.destructiveActions !== 0) {
    throw new Error("pgdelta no_changes result must not carry an apply plan");
  }
}

function sameVersions(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((version, index) => version === right[index]);
}

const CANONICAL_WAL_COLUMN_ATTRIBUTES: RealtimeWalColumnAttribute[] = [
  { attnum: 1, name: "name", type: "text", dropped: false },
  { attnum: 2, name: "type_name", type: "text", dropped: false },
  { attnum: 3, name: "type_oid", type: "oid", dropped: false },
  { attnum: 4, name: "value", type: "jsonb", dropped: false },
  { attnum: 5, name: "is_pkey", type: "boolean", dropped: false },
  { attnum: 6, name: "is_selectable", type: "boolean", dropped: false },
];

const LEGACY_WAL_COLUMN_ATTRIBUTES: RealtimeWalColumnAttribute[] = [
  { attnum: 1, name: "name", type: "text", dropped: false },
  { attnum: 2, name: "type", type: "text", dropped: false },
  { attnum: 3, name: "value", type: "jsonb", dropped: false },
  { attnum: 4, name: "is_pkey", type: "boolean", dropped: false },
  { attnum: 5, name: "is_selectable", type: "boolean", dropped: false },
];

const CORRUPTED_WAL_COLUMN_ATTRIBUTES: RealtimeWalColumnAttribute[] = [
  { attnum: 1, name: "name", type: "text", dropped: false },
  { attnum: 2, name: null, type: null, dropped: true },
  { attnum: 3, name: "value", type: "jsonb", dropped: false },
  { attnum: 4, name: "is_pkey", type: "boolean", dropped: false },
  { attnum: 5, name: "is_selectable", type: "boolean", dropped: false },
  { attnum: 6, name: "type_name", type: "text", dropped: false },
  { attnum: 7, name: "type_oid", type: "oid", dropped: false },
];

const REQUIRED_WAL_COLUMN_FUNCTIONS = new Set([
  "realtime.apply_rls(jsonb, integer)",
  "realtime.build_prepared_statement_sql(text, regclass, realtime.wal_column[])",
  "realtime.is_visible_through_filters(realtime.wal_column[], realtime.user_defined_filter[])",
  "realtime.list_changes(name, name, integer, integer)",
]);

function normalizeFunctionIdentity(identity: string): string {
  return identity.replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim();
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalEffectiveAcl(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an ACL entry array`);
  const entries = value.map((entry) => {
    if (
      !Array.isArray(entry)
      || entry.length !== 4
      || typeof entry[0] !== "string"
      || !entry[0]
      || typeof entry[1] !== "string"
      || !entry[1]
      || typeof entry[2] !== "string"
      || !entry[2]
      || typeof entry[3] !== "boolean"
    ) {
      throw new Error(`${label} contains an invalid ACL entry`);
    }
    return JSON.stringify(entry);
  });
  if (new Set(entries).size !== entries.length) {
    throw new Error(`${label} contains duplicate ACL entries`);
  }
  return entries.sort();
}

function sameEffectiveAcl(
  left: unknown,
  right: readonly EffectiveAclEntry[],
  label: string,
): boolean {
  return sameJson(canonicalEffectiveAcl(left, label), canonicalEffectiveAcl(right, label));
}

export function classifyRealtimeWalColumnAttributes(
  attributes: readonly RealtimeWalColumnAttribute[],
): RealtimeWalColumnShape {
  if (sameJson(attributes, CANONICAL_WAL_COLUMN_ATTRIBUTES)) return "canonical";
  if (sameJson(attributes, LEGACY_WAL_COLUMN_ATTRIBUTES)) return "legacy";
  if (sameJson(attributes, CORRUPTED_WAL_COLUMN_ATTRIBUTES)) return "corrupted_dropped_attribute";
  throw new Error(
    "realtime.wal_column has an unknown physical attribute layout; refusing reconciliation",
  );
}

function assertWalColumnInspectionShape(inspection: RealtimeWalColumnInspection): void {
  if (!inspection || typeof inspection !== "object" || !Array.isArray(inspection.attributes)) {
    throw new Error("invalid realtime.wal_column inspection");
  }
  const shape = classifyRealtimeWalColumnAttributes(inspection.attributes);
  if (shape !== inspection.shape) {
    throw new Error("realtime.wal_column inspection classification does not match its physical layout");
  }
  if (
    typeof inspection.owner !== "string"
    || !inspection.owner
    || typeof inspection.relationOwner !== "string"
    || !inspection.relationOwner
  ) {
    throw new Error("realtime.wal_column inspection has no owner");
  }
  if (
    (inspection.acl !== null && typeof inspection.acl !== "string")
    || (inspection.relationAcl !== null && typeof inspection.relationAcl !== "string")
    || !Array.isArray(inspection.effectiveAcl)
    || !Array.isArray(inspection.effectiveRelationAcl)
  ) {
    throw new Error("realtime.wal_column inspection has an invalid ACL");
  }
  canonicalEffectiveAcl(inspection.effectiveAcl, "realtime.wal_column effective ACL");
  canonicalEffectiveAcl(inspection.effectiveRelationAcl, "realtime.wal_column relation effective ACL");
  if (
    !Array.isArray(inspection.functions)
    || !Array.isArray(inspection.storedColumnReferences)
    || typeof inspection.staleRepairTypeExists !== "boolean"
    || !Array.isArray(inspection.staleRepairFunctionOverloads)
    || inspection.staleRepairFunctionOverloads.some((identity) => typeof identity !== "string")
  ) {
    throw new Error("realtime.wal_column inspection is incomplete");
  }
  for (const fn of inspection.functions) {
    if (
      typeof fn.identity !== "string"
      || typeof fn.owner !== "string"
      || (fn.acl !== null && typeof fn.acl !== "string")
      || !Array.isArray(fn.effectiveAcl)
      || !/^[0-9a-f]{64}$/.test(fn.definitionSha256)
    ) {
      throw new Error("realtime.wal_column inspection has an invalid function record");
    }
    canonicalEffectiveAcl(fn.effectiveAcl, `realtime.wal_column function effective ACL ${fn.identity}`);
    if (!REQUIRED_WAL_COLUMN_FUNCTIONS.has(normalizeFunctionIdentity(fn.identity))) {
      throw new Error(`unexpected realtime.wal_column dependent function overload: ${fn.identity}`);
    }
  }
  for (const reference of inspection.storedColumnReferences) {
    if (
      typeof reference.schema !== "string"
      || typeof reference.relation !== "string"
      || typeof reference.column !== "string"
      || typeof reference.type !== "string"
    ) {
      throw new Error("realtime.wal_column inspection has an invalid stored-column reference");
    }
  }
}

function assertWalColumnCanBeRebuilt(inspection: RealtimeWalColumnInspection): void {
  assertWalColumnInspectionShape(inspection);
  if (
    inspection.staleRepairTypeExists
    || inspection.staleRepairFunctionOverloads.length > 0
  ) {
    throw new Error(
      "realtime.wal_column has stale repair objects; refusing reconciliation",
    );
  }
  if (inspection.storedColumnReferences.length > 0) {
    throw new Error(
      "realtime.wal_column is referenced by stored relation columns; refusing a destructive rebuild",
    );
  }
}

export function assertCanonicalWalColumn(inspection: RealtimeWalColumnInspection): void {
  assertWalColumnCanBeRebuilt(inspection);
  if (inspection.shape !== "canonical") {
    throw new Error("realtime.wal_column did not converge to the canonical physical layout");
  }
  if (
    inspection.owner !== "supabase_realtime_admin"
    || inspection.relationOwner !== "supabase_realtime_admin"
    || inspection.acl !== null
    || inspection.relationAcl !== null
    || !sameEffectiveAcl(
      inspection.effectiveAcl,
      OFFICIAL_WAL_COLUMN_TYPE_EFFECTIVE_ACL,
      "realtime.wal_column effective ACL",
    )
    || !sameEffectiveAcl(
      inspection.effectiveRelationAcl,
      OFFICIAL_WAL_COLUMN_RELATION_EFFECTIVE_ACL,
      "realtime.wal_column relation effective ACL",
    )
  ) {
    throw new Error("realtime.wal_column did not converge to the official catalog ACL/owner");
  }
  const identities = new Set(inspection.functions.map((fn) => normalizeFunctionIdentity(fn.identity)));
  const missing = [...REQUIRED_WAL_COLUMN_FUNCTIONS].filter((identity) => !identities.has(identity));
  if (missing.length > 0 || identities.size !== inspection.functions.length) {
    throw new Error(
      "realtime.wal_column repair did not restore exactly the four required function overloads",
    );
  }
  for (const fn of inspection.functions) {
    const identity = normalizeFunctionIdentity(fn.identity);
    const expected = OFFICIAL_WAL_COLUMN_FUNCTION_CONTRACT.get(identity);
    if (!expected || fn.owner !== "supabase_realtime_admin") {
      throw new Error("realtime.wal_column dependent functions did not converge to the official owner");
    }
    if (
      fn.definitionSha256 !== expected.definitionSha256
      || !sameEffectiveAcl(
        fn.effectiveAcl,
        expected.effectiveAcl,
        `realtime.wal_column function effective ACL ${identity}`,
      )
    ) {
      throw new Error(`realtime.wal_column function catalog contract mismatch: ${identity}`);
    }
  }
}

function walColumnInspectionEqual(
  left: RealtimeWalColumnInspection,
  right: RealtimeWalColumnInspection,
): boolean {
  return sameJson(left, right);
}

const WAL_COLUMN_REPAIR_PATHS = [
  "realtime/types/wal_column.sql",
  "realtime/functions/apply_rls.sql",
  "realtime/functions/build_prepared_statement_sql.sql",
  "realtime/functions/is_visible_through_filters.sql",
  "realtime/functions/list_changes.sql",
] as const;

function functionExecuteAcl(grantees: readonly string[]): EffectiveAclEntry[] {
  return grantees.map((grantee) => [
    grantee,
    "supabase_realtime_admin",
    "EXECUTE",
    false,
  ]);
}

const OFFICIAL_WAL_COLUMN_FUNCTION_CONTRACT = new Map([
  [
    "realtime.apply_rls(jsonb, integer)",
    {
      definitionSha256: "b455782c3c10fe5f7d36d9b4f27ad531191fb7693ce55dd88cc639e8bf36ea83",
      effectiveAcl: functionExecuteAcl([
        "PUBLIC",
        "anon",
        "authenticated",
        "dashboard_user",
        "postgres",
        "service_role",
        "supabase_realtime_admin",
      ]),
    },
  ],
  [
    "realtime.build_prepared_statement_sql(text, regclass, realtime.wal_column[])",
    {
      definitionSha256: "46923b06f4d06e66bed424b6da25bd00d5f70472ff398d35d2ae50f3634359ba",
      effectiveAcl: functionExecuteAcl([
        "PUBLIC",
        "anon",
        "authenticated",
        "service_role",
        "supabase_realtime_admin",
      ]),
    },
  ],
  [
    "realtime.is_visible_through_filters(realtime.wal_column[], realtime.user_defined_filter[])",
    {
      definitionSha256: "4583a3c4c0425a65597a33472f7efab296765665db5c2cef5b309f84adafc1b5",
      effectiveAcl: functionExecuteAcl([
        "PUBLIC",
        "anon",
        "authenticated",
        "service_role",
        "supabase_realtime_admin",
      ]),
    },
  ],
  [
    "realtime.list_changes(name, name, integer, integer)",
    {
      definitionSha256: "6ecaa7b9145a223931a3e5d6a0275750fc663fe90d56bbb353a2963eb2b935eb",
      effectiveAcl: functionExecuteAcl([
        "PUBLIC",
        "dashboard_user",
        "postgres",
        "supabase_realtime_admin",
      ]),
    },
  ],
]);

function walColumnRepairArtifactHash(files: readonly { path: string; sql: string }[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path).update("\0").update(file.sql).update("\0");
  }
  return hash.digest("hex");
}

function schemaTreeHash(files: readonly { path: string; sql: string }[]): string {
  return walColumnRepairArtifactHash(files);
}

function assertOfficialWalColumnRepairFiles(files: readonly { path: string; sql: string }[]): void {
  if (walColumnRepairArtifactHash(files) !== OFFICIAL_WAL_COLUMN_REPAIR_AGGREGATE_SHA256) {
    throw new Error(`running Realtime wal_column repair SQL aggregate checksum is not the verified ${OFFICIAL_REALTIME_RUNTIME_VERSION} artifact`);
  }
  for (const file of files) {
    const expected = OFFICIAL_WAL_COLUMN_REPAIR_FILE_SHA256.get(file.path);
    const actual = createHash("sha256").update(file.sql).digest("hex");
    if (!expected || actual !== expected) {
      throw new Error(`running Realtime wal_column repair SQL checksum mismatch: ${file.path}`);
    }
  }
}

interface RealtimeTenantSchemaManifest {
  formatVersion: number;
  profile: string;
  files: string[];
  loadOrder: string[];
}

function manifestSha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function validateRealtimeTenantSchemaManifest(contents: string): {
  sha256: string;
  files: string[];
  loadOrder: string[];
} {
  let parsed: Partial<RealtimeTenantSchemaManifest>;
  try {
    parsed = JSON.parse(contents) as Partial<RealtimeTenantSchemaManifest>;
  } catch (error) {
    throw new Error(`running Realtime tenant schema manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    parsed.formatVersion !== 1
    || parsed.profile !== "realtime-tenant"
    || !Array.isArray(parsed.files)
    || !Array.isArray(parsed.loadOrder)
    || parsed.files.some((path) => typeof path !== "string")
    || parsed.loadOrder.some((path) => typeof path !== "string")
  ) {
    throw new Error("running Realtime tenant schema manifest has an invalid shape");
  }
  const files = parsed.files as string[];
  const loadOrder = parsed.loadOrder as string[];
  if (new Set(files).size !== files.length || new Set(loadOrder).size !== loadOrder.length) {
    throw new Error("running Realtime tenant schema manifest contains duplicate paths");
  }
  if (files.length !== loadOrder.length || files.some((path) => !loadOrder.includes(path))) {
    throw new Error("running Realtime tenant schema manifest files and loadOrder differ");
  }
  const selected = WAL_COLUMN_REPAIR_PATHS.slice();
  if (selected.some((path) => !files.includes(path))) {
    throw new Error("running Realtime tenant schema manifest is missing a wal_column repair file");
  }
  const selectedOrder = loadOrder.filter((path) => selected.includes(path as (typeof WAL_COLUMN_REPAIR_PATHS)[number]));
  if (!sameJson(selectedOrder, selected)) {
    throw new Error("running Realtime tenant schema manifest wal_column file order is not official");
  }
  const sha256 = manifestSha256(contents);
  if (sha256 !== OFFICIAL_REALTIME_MANIFEST_SHA256) {
    throw new Error(`running Realtime tenant schema manifest checksum is not the verified ${OFFICIAL_REALTIME_RUNTIME_VERSION} manifest`);
  }
  return { sha256, files, loadOrder };
}

function assertWalColumnRepairArtifact(artifact: RealtimeWalColumnRepairArtifact): void {
  if (!artifact || typeof artifact !== "object" || !Array.isArray(artifact.files)) {
    throw new Error("running Realtime release returned an invalid wal_column repair artifact");
  }
  if (
    artifact.files.length !== WAL_COLUMN_REPAIR_PATHS.length
    || artifact.files.some((file, index) => (
      file.path !== WAL_COLUMN_REPAIR_PATHS[index]
      || typeof file.sql !== "string"
      || file.sql.trim().length === 0
    ))
  ) {
    throw new Error("running Realtime release returned an incomplete wal_column repair artifact");
  }
  if (walColumnRepairArtifactHash(artifact.files) !== artifact.sha256) {
    throw new Error("running Realtime wal_column repair artifact checksum mismatch");
  }
  if (!SHA256_PATTERN.test(artifact.manifestSha256)) {
    throw new Error("running Realtime tenant schema manifest checksum is invalid");
  }
  if (!sameJson(artifact.manifestLoadOrder, WAL_COLUMN_REPAIR_PATHS)) {
    throw new Error("running Realtime tenant schema manifest wal_column order is invalid");
  }
  if (
    typeof artifact.schemaTreeSha256 !== "string"
    || !SHA256_PATTERN.test(artifact.schemaTreeSha256)
    || !Array.isArray(artifact.schemaFiles)
    || artifact.schemaFiles.length === 0
    || artifact.schemaFiles.some((file) => (
      !file
      || typeof file.path !== "string"
      || typeof file.sql !== "string"
      || file.sql.trim().length === 0
    ))
    || schemaTreeHash(artifact.schemaFiles) !== artifact.schemaTreeSha256
    || typeof artifact.manifestContents !== "string"
    || manifestSha256(artifact.manifestContents) !== artifact.manifestSha256
  ) {
    throw new Error("running Realtime tenant schema tree is incomplete or changed");
  }
  const manifest = validateRealtimeTenantSchemaManifest(artifact.manifestContents);
  if (
    !sameJson(artifact.schemaFiles.map((file) => file.path), manifest.loadOrder)
    || !sameJson(
      artifact.files.map((file) => file.path),
      manifest.loadOrder.filter((path) => WAL_COLUMN_REPAIR_PATHS.includes(
        path as (typeof WAL_COLUMN_REPAIR_PATHS)[number],
      )),
    )
  ) {
    throw new Error("running Realtime tenant schema tree does not match its manifest load order");
  }
  if (!SHA256_PATTERN.test(artifact.profileSha256)) {
    throw new Error("running Realtime pgdelta profile checksum is invalid");
  }
  if (artifact.profileContents !== undefined) {
    if (artifact.profileContents.trim().length === 0) {
      throw new Error("running Realtime pgdelta profile is empty");
    }
    if (createHash("sha256").update(artifact.profileContents).digest("hex") !== artifact.profileSha256) {
      throw new Error("running Realtime pgdelta profile checksum mismatch");
    }
  }
}

const KNOWN_LEGACY_EVENT_TRIGGERS = new Map([
  ["realtime_auto_attach_trigger", "realtime.auto_attach_notify_trigger()"],
  ["realtime_auto_publish_tasks_trigger", "realtime.auto_publish_tasks_table()"],
]);
export const LEGACY_REALTIME_FUNCTION_DROP_ORDER = [
  "realtime.notify_postgres_changes()",
  "realtime.auto_attach_notify_trigger()",
  "realtime.auto_publish_tasks_table()",
  "realtime.ensure_tasks_publication()",
  "realtime.notify_change_payload(jsonb)",
] as const;
const KNOWN_LEGACY_FUNCTIONS = new Set<string>(LEGACY_REALTIME_FUNCTION_DROP_ORDER);

function assertLegacyInventoryShape(inventory: LegacyRealtimeObjectInventory): void {
  if (
    !inventory
    || !Array.isArray(inventory.eventTriggers)
    || !Array.isArray(inventory.tableTriggers)
    || !Array.isArray(inventory.functions)
    || !Array.isArray(inventory.functionDetails)
  ) {
    throw new Error("invalid Realtime legacy object inventory");
  }
  const oidPattern = /^\d+$/;
  const hashPattern = /^[0-9a-f]{64}$/;
  const functionDetailsByIdentity = new Map<string, LegacyRealtimeObjectInventory["functionDetails"][number]>();
  for (const detail of inventory.functionDetails) {
    if (
      typeof detail.identity !== "string"
      || typeof detail.oid !== "string"
      || !oidPattern.test(detail.oid)
      || typeof detail.definitionSha256 !== "string"
      || !hashPattern.test(detail.definitionSha256)
      || functionDetailsByIdentity.has(normalizeFunctionIdentity(detail.identity))
    ) {
      throw new Error("invalid Realtime legacy function catalog metadata");
    }
    functionDetailsByIdentity.set(normalizeFunctionIdentity(detail.identity), detail);
  }
  if (
    inventory.functions.length !== inventory.functionDetails.length
    || inventory.functions.some((identity) => !functionDetailsByIdentity.has(normalizeFunctionIdentity(identity)))
  ) {
    throw new Error("Realtime legacy function inventory does not match its catalog metadata");
  }
  const seenObjectOids = new Set<string>();
  const functionIdentityByOid = new Map<string, string>();
  const assertFunctionMetadata = (
    identity: string,
    oid: string,
    definitionSha256: string,
  ): void => {
    if (!oidPattern.test(oid) || !hashPattern.test(definitionSha256)) {
      throw new Error("invalid Realtime legacy function catalog metadata");
    }
    const normalizedIdentity = normalizeFunctionIdentity(identity);
    const existingIdentity = functionIdentityByOid.get(oid);
    if (existingIdentity && existingIdentity !== normalizedIdentity) {
      throw new Error("Realtime legacy function OID maps to multiple identities");
    }
    const detail = functionDetailsByIdentity.get(normalizedIdentity);
    if (!detail || detail.oid !== oid || detail.definitionSha256 !== definitionSha256) {
      throw new Error("Realtime legacy trigger function metadata does not match its catalog snapshot");
    }
    functionIdentityByOid.set(oid, normalizedIdentity);
  };
  for (const eventTrigger of inventory.eventTriggers) {
    const expectedFunction = KNOWN_LEGACY_EVENT_TRIGGERS.get(eventTrigger.name);
    if (
      !oidPattern.test(eventTrigger.oid)
      || seenObjectOids.has(eventTrigger.oid)
      || !expectedFunction
      || eventTrigger.event !== "ddl_command_end"
      || normalizeFunctionIdentity(eventTrigger.functionIdentity) !== expectedFunction
      || !hashPattern.test(eventTrigger.definitionSha256)
    ) {
      throw new Error(`unknown or unsafe Realtime event trigger shape: ${eventTrigger.name}`);
    }
    seenObjectOids.add(eventTrigger.oid);
    assertFunctionMetadata(
      eventTrigger.functionIdentity,
      eventTrigger.functionOid,
      eventTrigger.functionDefinitionSha256,
    );
  }
  for (const trigger of inventory.tableTriggers) {
    if (
      !oidPattern.test(trigger.oid)
      || !oidPattern.test(trigger.relationOid)
      || seenObjectOids.has(trigger.oid)
      || trigger.schema !== "public"
      || trigger.name !== "realtime_notify_trigger"
      || normalizeFunctionIdentity(trigger.functionIdentity) !== "realtime.notify_postgres_changes()"
      || !hashPattern.test(trigger.definitionSha256)
      || !trigger.row
      || trigger.before
      || trigger.instead
      || !trigger.insert
      || !trigger.update
      || !trigger.delete
      || trigger.truncate
    ) {
      throw new Error(`unknown or unsafe Realtime table trigger shape: ${trigger.schema}.${trigger.table}.${trigger.name}`);
    }
    seenObjectOids.add(trigger.oid);
    assertFunctionMetadata(trigger.functionIdentity, trigger.functionOid, trigger.functionDefinitionSha256);
  }
  for (const fn of inventory.functions) {
    if (!KNOWN_LEGACY_FUNCTIONS.has(normalizeFunctionIdentity(fn))) {
      throw new Error(`unknown Realtime compatibility function shape: ${fn}`);
    }
  }
}

function legacyInventoryEqual(left: LegacyRealtimeObjectInventory, right: LegacyRealtimeObjectInventory): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function legacyObjectCount(inventory: LegacyRealtimeObjectInventory): number {
  return inventory.eventTriggers.length + inventory.tableTriggers.length + inventory.functions.length;
}

export function legacyRealtimeFunctionDropStatement(identity: string): string {
  if (!KNOWN_LEGACY_FUNCTIONS.has(identity)) {
    throw new Error(`cannot safely drop unknown legacy Realtime function: ${identity}`);
  }
  return `DROP FUNCTION ${identity}`;
}

export function parseRealtimeTenantSchemaPlanFile(input: string): RealtimeTenantSchemaPlanFile {
  let parsed: Partial<RealtimeTenantSchemaPlanFile>;
  try {
    parsed = JSON.parse(input) as Partial<RealtimeTenantSchemaPlanFile>;
  } catch (error) {
    throw new Error(`invalid Realtime tenant schema plan file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    parsed.formatVersion !== 3
    || typeof parsed.projectRef !== "string"
    || typeof parsed.generatedAt !== "string"
    || parsed.runtimeVersion !== OFFICIAL_REALTIME_RUNTIME_VERSION
    || !Array.isArray(parsed.migrationVersions)
    || !Number.isSafeInteger(parsed.tenantMigrationsRan)
    || !Array.isArray(parsed.tenantLedgerVersions)
    || !parsed.legacyRealtimeObjects
    || !parsed.walColumn
    || !parsed.walColumnRepair
    || !parsed.pgdelta
    || typeof parsed.planSha256 !== "string"
    || !parsed.databaseIdentity
  ) {
    throw new Error("invalid Realtime tenant schema plan file");
  }
  assertProjectRef(parsed.projectRef);
  if (!TIMESTAMP_PATTERN.test(parsed.generatedAt) || Number.isNaN(Date.parse(parsed.generatedAt))) {
    throw new Error("plan generatedAt is not a canonical UTC timestamp");
  }
  assertRealtimeTenantDatabaseIdentity(parsed.databaseIdentity, parsed.projectRef);
  assertReplacementJournalInactive(parsed.databaseIdentity, "plan validation");
  parsed.migrationVersions = normalizeVersions(parsed.migrationVersions, "plan release ledger");
  parsed.tenantLedgerVersions = normalizeVersions(parsed.tenantLedgerVersions, "plan tenant ledger");
  if (
    parsed.tenantMigrationsRan! < 0
    || parsed.tenantMigrationsRan! > parsed.migrationVersions.length
  ) {
    throw new Error("plan tenant migrations_ran is invalid for the running release");
  }
  assertLegacyInventoryShape(parsed.legacyRealtimeObjects);
  assertWalColumnCanBeRebuilt(parsed.walColumn);
  const expectedRepairAction = parsed.walColumn.shape === "canonical"
    ? "none"
    : "rebuild_from_release";
  if (
    parsed.walColumnRepair.action !== expectedRepairAction
    || !SHA256_PATTERN.test(parsed.walColumnRepair.artifactSha256)
    || !SHA256_PATTERN.test(parsed.walColumnRepair.manifestSha256)
    || !sameJson(parsed.walColumnRepair.manifestLoadOrder, WAL_COLUMN_REPAIR_PATHS)
    || !SHA256_PATTERN.test(parsed.walColumnRepair.schemaTreeSha256)
    || !SHA256_PATTERN.test(parsed.walColumnRepair.profileSha256)
    || parsed.walColumnRepair.imageDigest !== OFFICIAL_REALTIME_IMAGE_DIGEST
  ) {
    throw new Error("invalid realtime.wal_column repair intent in plan file");
  }
  assertPlanShape(parsed.pgdelta);
  if (!SHA256_PATTERN.test(parsed.planSha256)) {
    throw new Error("Realtime tenant schema plan checksum is invalid");
  }
  const { planSha256: _planSha256, ...withoutDigest } = parsed as RealtimeTenantSchemaPlanFile;
  if (realtimeTenantSchemaPlanDigest(withoutDigest) !== parsed.planSha256) {
    throw new Error("Realtime tenant schema plan checksum mismatch");
  }
  return parsed as RealtimeTenantSchemaPlanFile;
}

export class RealtimeTenantSchemaReconcileService {
  constructor(
    private readonly rpc: RealtimeTenantSchemaRpc,
    private readonly store: RealtimeTenantSchemaReconcileStore,
    private readonly sensitiveValues: readonly string[] = [],
  ) {}

  private partialStateError(
    phase: RealtimeTenantSchemaRecoveryPhase,
    plan: RealtimeTenantSchemaPlanFile,
    message: string,
    cause: unknown,
  ): RealtimeTenantSchemaPartialStateError {
    if (cause instanceof RealtimeTenantSchemaPartialStateError) return cause;
    const detail = cause instanceof Error
      ? redactSensitiveOutput(cause.message).trim().slice(-1_000)
      : redactSensitiveOutput(String(cause)).trim().slice(-1_000);
    return new RealtimeTenantSchemaPartialStateError(
      phase,
      plan.projectRef,
      detail ? `${message}: ${detail}` : message,
      plan.databaseIdentity,
      { cause },
    );
  }

  private async currentDatabaseIdentity(projectRef: string): Promise<RealtimeTenantDatabaseIdentity> {
    const identity = await this.store.inspectDatabaseIdentity(projectRef);
    assertRealtimeTenantDatabaseIdentity(identity, projectRef);
    assertReplacementJournalInactive(identity, "reconciliation");
    return identity;
  }

  private async assertDatabaseIdentity(
    projectRef: string,
    expected: RealtimeTenantDatabaseIdentity,
    stage: string,
  ): Promise<void> {
    const current = await this.currentDatabaseIdentity(projectRef);
    if (!sameRealtimeTenantDatabaseIdentity(current, expected)) {
      throw new Error(`Realtime tenant database identity changed during ${stage}; create a new plan`);
    }
  }

  private async assertLegacyEmpty(projectRef: string, stage: string): Promise<void> {
    const inventory = await this.store.inspectLegacyRealtimeObjects(projectRef);
    assertLegacyInventoryShape(inventory);
    if (legacyObjectCount(inventory) !== 0) {
      throw new Error(`legacy Realtime object inventory is not empty after ${stage}; reconciliation stopped`);
    }
  }

  async inspect(projectRef: string): Promise<RealtimeTenantSchemaInspection> {
    assertProjectRef(projectRef);
    const databaseIdentity = await this.currentDatabaseIdentity(projectRef);
    const runtime = await this.rpc.inspect(projectRef);
    if (runtime.runtimeVersion !== OFFICIAL_REALTIME_RUNTIME_VERSION) {
      throw new Error(`wal_column reconciliation requires verified Realtime ${OFFICIAL_REALTIME_RUNTIME_VERSION}`);
    }
    if (runtime.tenantExternalId !== projectRef) {
      throw new Error("Realtime RPC returned a different tenant identity");
    }
    const migrationVersions = normalizeVersions(runtime.migrationVersions, "running release ledger");
    if (migrationVersions.length === 0) {
      throw new Error("running Realtime release did not expose its migration ledger");
    }
    if (
      !Number.isSafeInteger(runtime.tenantMigrationsRan)
      || runtime.tenantMigrationsRan < 0
      || runtime.tenantMigrationsRan > migrationVersions.length
    ) {
      throw new Error("Realtime tenant migrations_ran is invalid for the running release");
    }
    const tenantLedgerVersions = normalizeVersions(
      await this.store.readTenantLedger(projectRef),
      "tenant Realtime ledger",
    );
    assertKnownLedger(tenantLedgerVersions, migrationVersions);
    const legacyRealtimeObjects = await this.store.inspectLegacyRealtimeObjects(projectRef);
    assertLegacyInventoryShape(legacyRealtimeObjects);
    const walColumn = await this.store.inspectWalColumn(projectRef);
    assertWalColumnCanBeRebuilt(walColumn);
    const endingIdentity = await this.currentDatabaseIdentity(projectRef);
    if (!sameRealtimeTenantDatabaseIdentity(databaseIdentity, endingIdentity)) {
      throw new Error("Realtime tenant database identity changed during inspection; retry reconciliation");
    }

    return {
      ...runtime,
      databaseIdentity,
      migrationVersions,
      tenantLedgerVersions,
      legacyRealtimeObjects,
      walColumn,
      ledgerComplete: sameVersions(tenantLedgerVersions, migrationVersions)
        && runtime.tenantMigrationsRan === migrationVersions.length,
    };
  }

  async plan(projectRef: string): Promise<RealtimeTenantSchemaPlanFile> {
    const inspection = await this.inspect(projectRef);
    const repairArtifact = await this.rpc.walColumnRepairArtifact();
    assertWalColumnRepairArtifact(repairArtifact);
    const pgdelta = await this.rpc.plan(projectRef, inspection.databaseIdentity);
    assertPlanShape(pgdelta);
    assertSecretFreePlan(pgdelta, this.sensitiveValues);
    const withoutDigest: Omit<RealtimeTenantSchemaPlanFile, "planSha256"> = {
      formatVersion: 3,
      projectRef,
      generatedAt: new Date().toISOString(),
      runtimeVersion: inspection.runtimeVersion,
      databaseIdentity: inspection.databaseIdentity,
      migrationVersions: inspection.migrationVersions,
      tenantMigrationsRan: inspection.tenantMigrationsRan,
      tenantLedgerVersions: inspection.tenantLedgerVersions,
      legacyRealtimeObjects: inspection.legacyRealtimeObjects,
      walColumn: inspection.walColumn,
      walColumnRepair: {
        action: inspection.walColumn.shape === "canonical" ? "none" : "rebuild_from_release",
        artifactSha256: repairArtifact.sha256,
        manifestSha256: repairArtifact.manifestSha256,
        manifestLoadOrder: [...repairArtifact.manifestLoadOrder],
        schemaTreeSha256: repairArtifact.schemaTreeSha256!,
        profileSha256: repairArtifact.profileSha256,
        imageDigest: OFFICIAL_REALTIME_IMAGE_DIGEST,
      },
      pgdelta,
    };
    return { ...withoutDigest, planSha256: realtimeTenantSchemaPlanDigest(withoutDigest) };
  }

  async apply(
    planFile: RealtimeTenantSchemaPlanFile,
    options: ApplyRealtimeTenantSchemaOptions = {},
  ): Promise<ApplyRealtimeTenantSchemaResult> {
    const plan = parseRealtimeTenantSchemaPlanFile(JSON.stringify(planFile));
    assertSecretFreePlan(plan.pgdelta, this.sensitiveValues);
    const before = await this.inspect(plan.projectRef);
    if (!sameRealtimeTenantDatabaseIdentity(before.databaseIdentity, plan.databaseIdentity)) {
      throw new Error("Realtime tenant database identity changed after the plan was generated; create a new plan");
    }
    if (
      before.runtimeVersion !== plan.runtimeVersion
      || !sameVersions(before.migrationVersions, plan.migrationVersions)
      || before.tenantMigrationsRan !== plan.tenantMigrationsRan
      || !sameVersions(before.tenantLedgerVersions, plan.tenantLedgerVersions)
    ) {
      throw new Error("Realtime release or tenant ledger changed after the plan was generated; create a new plan");
    }
    if (!legacyInventoryEqual(before.legacyRealtimeObjects, plan.legacyRealtimeObjects)) {
      throw new Error("Realtime legacy trigger/function inventory changed after the plan was generated; create a new plan");
    }
    if (!walColumnInspectionEqual(before.walColumn, plan.walColumn)) {
      throw new Error("realtime.wal_column changed after the plan was generated; create a new plan");
    }

    const repairArtifact = await this.rpc.walColumnRepairArtifact();
    assertWalColumnRepairArtifact(repairArtifact);
    if (repairArtifact.sha256 !== plan.walColumnRepair.artifactSha256) {
      throw new Error("running Realtime wal_column repair artifact changed; create a new plan");
    }
    if (
      repairArtifact.manifestSha256 !== plan.walColumnRepair.manifestSha256
      || !sameJson(repairArtifact.manifestLoadOrder, plan.walColumnRepair.manifestLoadOrder)
      || repairArtifact.schemaTreeSha256 !== plan.walColumnRepair.schemaTreeSha256
    ) {
      throw new Error("running Realtime tenant schema manifest changed; create a new plan");
    }
    if (repairArtifact.profileSha256 !== plan.walColumnRepair.profileSha256) {
      throw new Error("running Realtime pgdelta profile changed; create a new plan");
    }

    const currentPlan = await this.rpc.plan(plan.projectRef, plan.databaseIdentity);
    assertPlanShape(currentPlan);
    assertSecretFreePlan(currentPlan, this.sensitiveValues);
    if (!samePgdeltaPlan(currentPlan, plan.pgdelta)) {
      throw new Error("tenant schema changed after the plan was generated; create a new plan");
    }

    if (options.dryRun) {
      return { dryRun: true, schemaApplied: false, ledgerSynchronized: false, inspection: before };
    }

    if (!options.backupReceiptPath) {
      throw new Error("apply requires --backup-receipt with a structured backup receipt");
    }
    await validateRealtimeBackupReceipt(options.backupReceiptPath, plan.databaseIdentity, {
      verifyCatalog: options.verifyBackupCatalog,
    });
    const legacyObjectsToRemove = legacyObjectCount(before.legacyRealtimeObjects);
    const rebuildWalColumn = plan.walColumnRepair.action === "rebuild_from_release";
    if (
      (currentPlan.destructiveActions > 0 || legacyObjectsToRemove > 0 || rebuildWalColumn)
      && !options.allowDestructive
    ) {
      throw new Error(
        `reconciliation will remove ${legacyObjectsToRemove} legacy object(s), rebuild wal_column=${rebuildWalColumn}, and pgdelta marked ${currentPlan.destructiveActions} destructive action(s); pass --allow-destructive after review`,
      );
    }

    let removedLegacyObjects = 0;
    if (legacyObjectsToRemove > 0) {
      const currentLegacyObjects = await this.store.inspectLegacyRealtimeObjects(plan.projectRef);
      assertLegacyInventoryShape(currentLegacyObjects);
      if (!legacyInventoryEqual(currentLegacyObjects, plan.legacyRealtimeObjects)) {
        throw new Error("Realtime legacy trigger/function inventory changed after the plan was generated; create a new plan");
      }
      await this.assertDatabaseIdentity(plan.projectRef, plan.databaseIdentity, "legacy cleanup preflight");
      removedLegacyObjects = await this.store.removeKnownLegacyRealtimeObjects(
        plan.projectRef,
        currentLegacyObjects,
        plan.databaseIdentity,
      );
      try {
        if (removedLegacyObjects !== legacyObjectsToRemove) {
          throw new RealtimeTenantSchemaPartialStateError(
            "schema_mutation_pending_verification",
            plan.projectRef,
            "legacy Realtime cleanup removed an unexpected number of objects; reconciliation stopped",
            plan.databaseIdentity,
          );
        }
        await this.assertLegacyEmpty(plan.projectRef, "reviewed cleanup");
        const postCleanupPlan = await this.rpc.plan(plan.projectRef, plan.databaseIdentity);
        assertPlanShape(postCleanupPlan);
        assertSecretFreePlan(postCleanupPlan, this.sensitiveValues);
        throw new RealtimeTenantSchemaPartialStateError(
          "schema_mutation_pending_verification",
          plan.projectRef,
          `reviewed legacy Realtime cleanup committed; fresh pgdelta status=${postCleanupPlan.status}, create and review a new plan before any further mutation`,
          plan.databaseIdentity,
        );
      } catch (error) {
        throw this.partialStateError(
          "schema_mutation_pending_verification",
          plan,
          "legacy Realtime cleanup committed, but post-cleanup verification did not complete",
          error,
        );
      }
    }

    if (currentPlan.status === "changes") {
      await this.assertDatabaseIdentity(plan.projectRef, plan.databaseIdentity, "pgdelta apply preflight");
      try {
        await this.rpc.applyPlan(plan.projectRef, currentPlan.plan!, plan.databaseIdentity);
      } catch (error) {
        throw this.partialStateError(
          "schema_mutation_pending_verification",
          plan,
          "pgdelta apply did not complete cleanly; schema state must be inspected before retry",
          error,
        );
      }
      try {
        await this.assertDatabaseIdentity(plan.projectRef, plan.databaseIdentity, "pgdelta post-apply verification");
        const postApplyPlan = await this.rpc.plan(plan.projectRef, plan.databaseIdentity);
        assertPlanShape(postApplyPlan);
        assertSecretFreePlan(postApplyPlan, this.sensitiveValues);
        throw new RealtimeTenantSchemaPartialStateError(
          "schema_mutation_pending_verification",
          plan.projectRef,
          `reviewed pgdelta plan applied; fresh pgdelta status=${postApplyPlan.status}, create and review a new plan before any further mutation`,
          plan.databaseIdentity,
        );
      } catch (error) {
        throw this.partialStateError(
          "schema_mutation_pending_verification",
          plan,
          "pgdelta schema mutation committed, but post-apply verification did not complete",
          error,
        );
      }
    }

    if (rebuildWalColumn) {
      await this.assertDatabaseIdentity(plan.projectRef, plan.databaseIdentity, "wal_column repair preflight");
      await this.store.rebuildWalColumn(
        plan.projectRef,
        plan.walColumn,
        repairArtifact,
        plan.databaseIdentity,
      );
      try {
        const afterRepair = await this.inspect(plan.projectRef);
        assertCanonicalWalColumn(afterRepair.walColumn);
        if (
          afterRepair.runtimeVersion !== plan.runtimeVersion
          || !sameVersions(afterRepair.migrationVersions, plan.migrationVersions)
          || afterRepair.tenantMigrationsRan !== plan.tenantMigrationsRan
          || !sameVersions(afterRepair.tenantLedgerVersions, plan.tenantLedgerVersions)
        ) {
          throw new Error("Realtime release or tenant ledger changed during wal_column repair; ledger was not modified");
        }
        const postRepairPlan = await this.rpc.plan(plan.projectRef, plan.databaseIdentity);
        assertPlanShape(postRepairPlan);
        assertSecretFreePlan(postRepairPlan, this.sensitiveValues);
        throw new RealtimeTenantSchemaPartialStateError(
          "schema_mutation_pending_verification",
          plan.projectRef,
          `wal_column repair committed; fresh pgdelta status=${postRepairPlan.status}, create and review a new plan before ledger synchronization`,
          plan.databaseIdentity,
        );
      } catch (error) {
        throw this.partialStateError(
          "schema_mutation_pending_verification",
          plan,
          "wal_column repair committed, but post-repair verification did not complete",
          error,
        );
      }
    }

    const afterSchema = await this.inspect(plan.projectRef);
    assertCanonicalWalColumn(afterSchema.walColumn);
    if (
      afterSchema.runtimeVersion !== plan.runtimeVersion
      || !sameVersions(afterSchema.migrationVersions, plan.migrationVersions)
      || afterSchema.tenantMigrationsRan !== plan.tenantMigrationsRan
      || !sameVersions(afterSchema.tenantLedgerVersions, plan.tenantLedgerVersions)
    ) {
      throw new Error("Realtime release or tenant ledger changed during reconciliation; ledger was not modified");
    }
    await this.assertLegacyEmpty(plan.projectRef, "schema reconciliation");
    const verification = await this.rpc.plan(plan.projectRef, plan.databaseIdentity);
    assertPlanShape(verification);
    assertSecretFreePlan(verification, this.sensitiveValues);
    if (verification.status !== "no_changes") {
      throw new Error("fresh pgdelta verification reports schema drift; create and review a new plan");
    }
    const verifiedSchema = await this.inspect(plan.projectRef);
    assertCanonicalWalColumn(verifiedSchema.walColumn);
    if (!walColumnInspectionEqual(verifiedSchema.walColumn, afterSchema.walColumn)) {
      throw new Error(
        "realtime.wal_column catalog changed during release verification; ledger was not modified",
      );
    }
    await this.assertDatabaseIdentity(plan.projectRef, plan.databaseIdentity, "database ledger synchronization");
    try {
      await this.store.insertTenantLedgerVersions(
        plan.projectRef,
        plan.migrationVersions,
        plan.databaseIdentity,
      );
    } catch (error) {
      throw new RealtimeTenantSchemaPartialStateError(
        "schema_converged_ledger_pending",
        plan.projectRef,
        "tenant schema converged, but the database migration ledger was not synchronized; restore the reviewed backup or create a fresh plan and retry",
        plan.databaseIdentity,
        { cause: error },
      );
    }
    try {
      await this.assertDatabaseIdentity(plan.projectRef, plan.databaseIdentity, "Realtime ledger synchronization");
      await this.rpc.updateMigrationsRan(
        plan.projectRef,
        plan.migrationVersions.length,
        plan.databaseIdentity,
      );
    } catch (error) {
      throw new RealtimeTenantSchemaPartialStateError(
        "ledger_runtime_pending",
        plan.projectRef,
        "tenant schema and database migration ledger converged, but Realtime migrations_ran did not; create a fresh plan and rerun apply to retry ledger synchronization",
        plan.databaseIdentity,
        { cause: error },
      );
    }

    let finalInspection: RealtimeTenantSchemaInspection;
    try {
      finalInspection = await this.inspect(plan.projectRef);
      assertCanonicalWalColumn(finalInspection.walColumn);
      if (!walColumnInspectionEqual(finalInspection.walColumn, verifiedSchema.walColumn)) {
        throw new Error(
          "realtime.wal_column catalog changed after release verification; migration ledgers may already be synchronized",
        );
      }
      if (!finalInspection.ledgerComplete) {
        throw new RealtimeTenantSchemaPartialStateError(
          "ledger_verification_pending",
          plan.projectRef,
          "Realtime schema converged but migration ledger synchronization did not verify",
          plan.databaseIdentity,
        );
      }
      await this.assertLegacyEmpty(plan.projectRef, "final acceptance");
      const finalVerification = await this.rpc.plan(plan.projectRef, plan.databaseIdentity);
      assertPlanShape(finalVerification);
      assertSecretFreePlan(finalVerification, this.sensitiveValues);
      if (finalVerification.status !== "no_changes") {
        throw new Error("Realtime schema drift reappeared after ledger synchronization; create a fresh plan");
      }
    } catch (error) {
      throw this.partialStateError(
        "ledger_verification_pending",
        plan,
        "Realtime ledgers were updated, but final acceptance verification did not complete",
        error,
      );
    }
    return {
      dryRun: false,
      schemaApplied: false,
      ledgerSynchronized: true,
      inspection: finalInspection,
    };
  }
}

function elixirString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\\u2028", "\\u2028")
    .replaceAll("\\u2029", "\\u2029");
}

function redactSensitiveOutput(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/([^\s/@:]+):([^\s/@]+)@/gi, "postgresql://$1:[REDACTED]@")
    .replace(/\b(password|db_password)=([^\s]+)/gi, "$1=[REDACTED]");
}

function rpcEnvelope(expression: string): string {
  return `result = (fn -> ${expression} end).(); IO.puts(${elixirString(RPC_SENTINEL)} <> Base.encode64(Jason.encode!(result)))`;
}

type OfficialRealtimeImageArchitecture = keyof typeof OFFICIAL_REALTIME_IMAGE_MANIFEST_DIGEST_BY_ARCH;

function knownFieldValues(
  value: Record<string, unknown>,
  keys: readonly string[],
): Array<{ key: string; value: unknown }> {
  return keys.flatMap((key) => Object.hasOwn(value, key) ? [{ key, value: value[key] }] : []);
}

function exactSha256Digest(
  value: unknown,
  label: string,
  options: { allowBare?: boolean; allowRepositoryReference?: boolean } = {},
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is not a SHA-256 digest string`);
  }
  if (options.allowBare && /^[0-9a-f]{64}$/i.test(value)) {
    return `sha256:${value.toLowerCase()}`;
  }
  if (/^sha256:[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (options.allowRepositoryReference) {
    const match = value.match(/^[^@\s]+@(sha256:[0-9a-f]{64})$/i);
    if (match) return match[1]!.toLowerCase();
  }
  throw new Error(`${label} is not an exact SHA-256 image identity`);
}

function exactKnownDigests(
  fields: Array<{ key: string; value: unknown }>,
  options: { allowBare?: boolean; allowRepositoryReference?: boolean; allowArray?: boolean } = {},
): string[] {
  return fields.flatMap(({ key, value }) => {
    if (value === null || value === undefined) return [];
    const entries = Array.isArray(value)
      ? options.allowArray
        ? value
        : (() => { throw new Error(`${key} must not be an array`); })()
      : [value];
    return entries.flatMap((entry, index) => {
      const digest = exactSha256Digest(entry, `${key}[${index}]`, options);
      return digest ? [digest] : [];
    });
  });
}

function normalizeRealtimeImageArchitecture(value: unknown): OfficialRealtimeImageArchitecture | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase().replaceAll("-", "_");
  if (normalized === "amd64" || normalized === "x86_64") return "amd64";
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  return undefined;
}

function imageInspectionObject(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return imageInspectionObject(value[0]);
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function imageManifestDescriptors(value: Record<string, unknown>): Record<string, unknown>[] {
  return knownFieldValues(value, ["ImageManifestDescriptor", "imageManifestDescriptor"])
    .flatMap(({ key, value: candidate }) => {
      if (candidate === null || candidate === undefined) return [];
      if (Array.isArray(candidate) || typeof candidate !== "object") {
        throw new Error(`${key} is not an image manifest descriptor`);
      }
      return [candidate as Record<string, unknown>];
    });
}

function imageArchitecture(
  inspection: Record<string, unknown>,
  descriptors: readonly Record<string, unknown>[],
): OfficialRealtimeImageArchitecture | undefined {
  const values = knownFieldValues(inspection, ["Architecture", "architecture"]);
  for (const [index, descriptor] of descriptors.entries()) {
    for (const { key, value } of knownFieldValues(descriptor, ["platform", "Platform"])) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value) || typeof value !== "object") {
        throw new Error(`descriptor ${index} ${key} is not a platform object`);
      }
      values.push(...knownFieldValues(value as Record<string, unknown>, ["architecture", "Architecture"]));
    }
  }
  const architectures = values.flatMap(({ key, value }) => {
    if (value === null || value === undefined) return [];
    const architecture = normalizeRealtimeImageArchitecture(value);
    if (!architecture) throw new Error(`${key} is not a supported image architecture`);
    return [architecture];
  });
  const unique = [...new Set(architectures)];
  if (unique.length > 1) throw new Error("image inspection returned conflicting architectures");
  return unique[0];
}

function tenantLookupExpression(projectRef: string): string {
  return [
    `ref = ${elixirString(projectRef)}`,
    "tenant = Realtime.Api.get_tenant_by_external_id(ref, use_replica?: false)",
    'if is_nil(tenant), do: raise("tenant not found")',
  ].join(";");
}

export class ContainerRealtimeTenantSchemaRpc implements RealtimeTenantSchemaRpc {
  private artifactPromise?: Promise<{
    pgdelta: string;
    schema: string;
    profile: string;
    manifest: string;
    imageDigest: string;
  }>;
  private walColumnArtifactPromise?: Promise<RealtimeWalColumnRepairArtifact>;

  constructor(
    private readonly run: CommandRunner,
    private readonly options: {
      runtime?: string;
      container?: string;
      releaseCommand?: string;
      resolveTarget(projectRef: string): Promise<RealtimeTenantDatabaseTarget>;
      verifyOfficialArtifacts?: boolean;
    },
  ) {}

  private get runtime(): string {
    return this.options.runtime || "podman";
  }

  private get container(): string {
    return this.options.container || "supacloud-realtime";
  }

  private get releaseCommand(): string {
    return this.options.releaseCommand || "/app/bin/realtime";
  }

  private async assertContainerImageDigest(): Promise<string> {
    const result = await this.run([
      this.runtime,
      "inspect",
      "--format",
      "{{json .}}",
      this.container,
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      parsed = undefined;
    }
    const inspection = imageInspectionObject(parsed);
    const reject = () => new Error(
      `Realtime container image is not the verified ${OFFICIAL_REALTIME_RUNTIME_VERSION} digest`,
    );
    if (result.exitCode !== 0 || !inspection) throw reject();
    let descriptors: Record<string, unknown>[];
    let architecture: OfficialRealtimeImageArchitecture | undefined;
    let descriptorDigests: string[];
    let imageDigests: string[];
    let repoDigestValues: string[];
    let imageIdDigests: string[];
    try {
      descriptors = imageManifestDescriptors(inspection);
      architecture = imageArchitecture(inspection, descriptors);
      descriptorDigests = descriptors.flatMap((descriptor) => {
        const digests = exactKnownDigests(knownFieldValues(descriptor, ["digest", "Digest"]));
        if (digests.length === 0) throw new Error("image manifest descriptor has no digest");
        return digests;
      });
      imageDigests = exactKnownDigests(knownFieldValues(inspection, ["ImageDigest", "imageDigest"]));
      repoDigestValues = exactKnownDigests(
        knownFieldValues(inspection, ["RepoDigests", "repoDigests"]),
        { allowRepositoryReference: true, allowArray: true },
      );
      imageIdDigests = exactKnownDigests(
        knownFieldValues(inspection, ["Image", "image", "ImageID", "imageID", "imageId"]),
        { allowBare: true },
      );
    } catch {
      throw reject();
    }
    const expectedManifest = architecture
      ? OFFICIAL_REALTIME_IMAGE_MANIFEST_DIGEST_BY_ARCH[architecture]
      : undefined;
    const identityDigests = new Set([
      ...descriptorDigests,
      ...imageDigests,
      ...repoDigestValues,
      ...imageIdDigests,
    ]);
    const officialIdentityDigests = new Set<string>([
      OFFICIAL_REALTIME_IMAGE_DIGEST,
      ...Object.values(OFFICIAL_REALTIME_IMAGE_MANIFEST_DIGEST_BY_ARCH),
      ...Object.values(OFFICIAL_REALTIME_IMAGE_CONFIG_DIGEST_BY_ARCH),
    ]);
    const officialManifestDigests = new Set<string>([
      OFFICIAL_REALTIME_IMAGE_DIGEST,
      ...Object.values(OFFICIAL_REALTIME_IMAGE_MANIFEST_DIGEST_BY_ARCH),
    ]);
    const officialImageDigests = architecture
      ? new Set<string>([
        OFFICIAL_REALTIME_IMAGE_DIGEST,
        OFFICIAL_REALTIME_IMAGE_MANIFEST_DIGEST_BY_ARCH[architecture],
        OFFICIAL_REALTIME_IMAGE_CONFIG_DIGEST_BY_ARCH[architecture],
      ])
      : officialIdentityDigests;
    const hasOfficialIdentity = [...identityDigests].some((digest) => officialIdentityDigests.has(digest));
    const descriptorMatchesPlatform = descriptorDigests.length === 0 || descriptorDigests.every((digest) => (
      expectedManifest ? digest === expectedManifest : officialManifestDigests.has(digest)
    ));
    const imageDigestIsOfficial = imageDigests.every((digest) => officialImageDigests.has(digest));
    const repoDigestsAreOfficial = repoDigestValues.length === 0
      || repoDigestValues.every((digest) => architecture
        ? digest === OFFICIAL_REALTIME_IMAGE_DIGEST || digest === expectedManifest
        : officialManifestDigests.has(digest));
    const imageIdsAreOfficial = imageIdDigests.length === 0
      || imageIdDigests.every((digest) => officialImageDigests.has(digest));
    // Docker's legacy `.Image` field is the OCI index on some versions and a
    // config/image ID on others. Podman also exposes a separate manifest
    // digest, so all three immutable forms are pinned here.
    if (
      !hasOfficialIdentity
      || !descriptorMatchesPlatform
      || !imageDigestIsOfficial
      || !repoDigestsAreOfficial
      || !imageIdsAreOfficial
    ) {
      throw reject();
    }
    return OFFICIAL_REALTIME_IMAGE_DIGEST;
  }

  private async artifact(): Promise<{
    pgdelta: string;
    schema: string;
    profile: string;
    manifest: string;
    imageDigest: string;
  }> {
    this.artifactPromise ??= (async () => {
      const imageDigest = this.options.verifyOfficialArtifacts === false
        ? "unverified"
        : await this.assertContainerImageDigest();
      const result = await this.run([
        this.runtime,
        "exec",
        this.container,
        "/bin/sh",
        "-eu",
        "-c",
        [
          "set -- /app/lib/realtime-*/priv/repo",
          '[ "$#" -eq 1 ] && [ -d "$1/tenant_schema" ] && [ -f "$1/pgdelta_profile.json" ] && [ -f "$1/tenant_schema/.pgdelta-export.json" ]',
          'pgdelta="$(command -v pgdelta)"',
          '[ -n "$pgdelta" ] && [ -x "$pgdelta" ]',
          'printf "PGDELTA=%s\\nSCHEMA=%s\\nPROFILE=%s\\nMANIFEST=%s\\n" "$pgdelta" "$1/tenant_schema" "$1/pgdelta_profile.json" "$1/tenant_schema/.pgdelta-export.json"',
        ].join(";"),
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`failed to discover bundled Realtime pgdelta artifacts: ${redactSensitiveOutput(result.stderr).trim()}`);
      }
      const values = new Map(
        result.stdout.trim().split(/\r?\n/).map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)] as const;
        }),
      );
      const artifact = {
        pgdelta: values.get("PGDELTA") || "",
        schema: values.get("SCHEMA") || "",
        profile: values.get("PROFILE") || "",
        manifest: values.get("MANIFEST") || "",
        imageDigest,
      };
      for (const value of [artifact.pgdelta, artifact.schema, artifact.profile, artifact.manifest]) {
        if (!value.startsWith("/") || /[\r\n\0]/.test(value)) {
          throw new Error("Realtime container returned an unsafe pgdelta artifact path");
        }
      }
      const verifiedRepo = `/app/lib/realtime-${OFFICIAL_REALTIME_RUNTIME_VERSION}/priv/repo`;
      if (
        artifact.schema !== `${verifiedRepo}/tenant_schema`
        || artifact.profile !== `${verifiedRepo}/pgdelta_profile.json`
        || artifact.manifest !== `${verifiedRepo}/tenant_schema/.pgdelta-export.json`
      ) {
        throw new Error(`Realtime artifacts do not belong to verified runtime ${OFFICIAL_REALTIME_RUNTIME_VERSION}`);
      }
      return artifact;
    })();
    return this.artifactPromise;
  }

  private async remoteTempDirectory(): Promise<string> {
    const result = await this.run([
      this.runtime,
      "exec",
      this.container,
      "mktemp",
      "-d",
      "/tmp/supacloud-realtime-reconcile.XXXXXX",
    ]);
    const directory = result.stdout.trim();
    if (result.exitCode !== 0 || !/^\/tmp\/supacloud-realtime-reconcile\.[A-Za-z0-9]+$/.test(directory)) {
      throw new Error("failed to create a private pgdelta workspace in the Realtime container");
    }
    return directory;
  }

  private async cleanupRemoteDirectory(directory: string): Promise<void> {
    if (!/^\/tmp\/supacloud-realtime-reconcile\.[A-Za-z0-9]+$/.test(directory)) return;
    await this.run([this.runtime, "exec", this.container, "rm", "-rf", "--", directory]).catch(() => undefined);
  }

  private async stageRemoteFile(directory: string, filename: string, contents: string): Promise<string> {
    if (!/^\/tmp\/supacloud-realtime-reconcile\.[A-Za-z0-9]+$/.test(directory)) {
      throw new Error("invalid private pgdelta workspace");
    }
    if (!contents) throw new Error("missing immutable pgdelta profile bytes");
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) throw new Error("invalid staged pgdelta filename");
    const path = `${directory}/${filename}`;
    const result = await this.run(
      [
        this.runtime,
        "exec",
        "-i",
        this.container,
        "/bin/sh",
        "-eu",
        "-c",
        'umask 077; cat > "$1"',
        "supacloud-stage-profile",
        path,
      ],
      { stdin: contents },
    );
    if (result.exitCode !== 0) {
      throw new Error(`failed to stage immutable pgdelta artifact: ${redactSensitiveOutput(result.stderr).trim()}`);
    }
    return path;
  }

  private async stageRemoteSchemaTree(
    directory: string,
    artifact: RealtimeWalColumnRepairArtifact,
  ): Promise<string> {
    assertWalColumnRepairArtifact(artifact);
    const root = `${directory}/schema`;
    const stagedFiles = [
      { path: ".pgdelta-export.json", sql: artifact.manifestContents! },
      ...artifact.schemaFiles!,
    ];
    for (const file of stagedFiles) {
      if (
        !file.path
        || file.path.startsWith("/")
        || file.path.includes("\\")
        || file.path.split("/").some((part) => !part || part === "." || part === "..")
      ) {
        throw new Error(`unsafe Realtime schema-tree path: ${file.path}`);
      }
      const destination = `${root}/${file.path}`;
      const parent = destination.slice(0, destination.lastIndexOf("/"));
      const result = await this.run(
        [
          this.runtime,
          "exec",
          "-i",
          this.container,
          "/bin/sh",
          "-eu",
          "-c",
          'umask 077; mkdir -p -- "$1"; cat > "$2"',
          "supacloud-stage-schema",
          parent,
          destination,
        ],
        { stdin: file.sql },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `failed to stage immutable Realtime schema file ${file.path}: ${redactSensitiveOutput(result.stderr).trim()}`,
        );
      }
    }
    const verify = await this.run([
      this.runtime,
      "exec",
      this.container,
      "/bin/sh",
      "-eu",
      "-c",
      [
        'root="$1"; expected="$2"; shift 2',
        'hash="$(for path in "$@"; do printf "%s\\0" "$path"; cat "$root/$path"; printf "\\0"; done | sha256sum | cut -d" " -f1)"',
        '[ "$hash" = "$expected" ]',
      ].join(";"),
      "supacloud-verify-schema",
      root,
      artifact.schemaTreeSha256!,
      ...artifact.schemaFiles!.map((file) => file.path),
    ]);
    if (verify.exitCode !== 0) {
      throw new Error("staged Realtime schema tree checksum verification failed");
    }
    return root;
  }

  private credentialFreeTargetUrl(target: RealtimeTenantDatabaseTarget): string {
    if (!target.password || /[\r\n]/.test(target.password)) {
      throw new Error("Realtime tenant database password must be a non-empty single-line value");
    }
    if (!Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65_535) {
      throw new Error("Realtime tenant database port is invalid");
    }
    const host = target.host.includes(":") ? `[${target.host}]` : target.host;
    return `postgresql://${encodeURIComponent(target.username)}@${host}:${target.port}/${encodeURIComponent(target.database)}?sslmode=${target.sslMode || "disable"}`;
  }

  private async assertRpcTargetIdentity(
    projectRef: string,
    expectedIdentity: RealtimeTenantDatabaseIdentity | undefined,
  ): Promise<RealtimeTenantDatabaseTarget> {
    const target = await this.options.resolveTarget(projectRef);
    if (expectedIdentity) {
      assertRealtimeTenantDatabaseIdentity(expectedIdentity, projectRef);
      if (target.database !== expectedIdentity.databaseName) {
        throw new Error("Realtime pgdelta target database mapping changed; create a new plan");
      }
      assertReplacementJournalInactive(expectedIdentity, "Realtime RPC");
    }
    return target;
  }

  private async runPgdeltaWithPassword(
    target: RealtimeTenantDatabaseTarget,
    args: readonly string[],
  ): Promise<CommandResult> {
    const artifact = await this.artifact();
    const result = await this.run(
      [
        this.runtime,
        "exec",
        "-i",
        this.container,
        "/bin/sh",
        "-eu",
        "-c",
        [
          `arch="$(uname -m)"; case "$arch" in aarch64|arm64) bundle="${OFFICIAL_PGDELTA_BUNDLE_SHA256_BY_ARCH.aarch64}"; expanded="${OFFICIAL_PGDELTA_EXPANDED_SHA256_BY_ARCH.aarch64}" ;; x86_64|amd64) bundle="${OFFICIAL_PGDELTA_BUNDLE_SHA256_BY_ARCH.x86_64}"; expanded="${OFFICIAL_PGDELTA_EXPANDED_SHA256_BY_ARCH.x86_64}" ;; *) echo "unsupported pgdelta architecture: $arch" >&2; exit 1 ;; esac`,
          `test "$(sha256sum "$1" | cut -d" " -f1)" = "${OFFICIAL_PGDELTA_WRAPPER_SHA256}"`,
          'test "$(sha256sum /usr/local/share/pgdelta/pgdelta.xz | cut -d" " -f1)" = "$bundle"',
          'if [ ! -x /app/.pgdelta-cache/pgdelta ]; then mkdir -p /app/.pgdelta-cache; xz -dcT0 /usr/local/share/pgdelta/pgdelta.xz > /app/.pgdelta-cache/pgdelta; chmod 700 /app/.pgdelta-cache/pgdelta; fi',
          'test "$(sha256sum /app/.pgdelta-cache/pgdelta | cut -d" " -f1)" = "$expanded"',
          'IFS= read -r PGPASSWORD; [ -n "$PGPASSWORD" ]; export PGPASSWORD; exec "$@"',
        ].join(";"),
        "supacloud-pgdelta",
        artifact.pgdelta,
        ...args,
      ],
      { stdin: `${target.password}\n` },
    );
    if (result.exitCode !== 0) {
      const detail = redactSensitiveOutput(`${result.stderr}\n${result.stdout}`).trim().slice(-4_000);
      throw new Error(`Realtime pgdelta exited ${result.exitCode}${detail ? `: ${detail}` : ""}`);
    }
    return result;
  }

  private async rpc<T>(expression: string): Promise<T> {
    const result = await this.run([
      this.runtime,
      "exec",
      this.container,
      this.releaseCommand,
      "rpc",
      rpcEnvelope(expression),
    ]);
    if (result.exitCode !== 0) {
      const detail = redactSensitiveOutput(`${result.stderr}\n${result.stdout}`).trim().slice(-2_000);
      throw new Error(`Realtime container RPC failed${detail ? `: ${detail}` : ""}`);
    }
    const index = result.stdout.lastIndexOf(RPC_SENTINEL);
    if (index === -1) throw new Error("Realtime container RPC returned no structured result");
    const encoded = result.stdout.slice(index + RPC_SENTINEL.length).trim().split(/\s/, 1)[0] || "";
    try {
      return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as T;
    } catch {
      throw new Error("Realtime container RPC returned an invalid structured result");
    }
  }

  async inspect(projectRef: string): Promise<RealtimeRuntimeSnapshot> {
    assertProjectRef(projectRef);
    if (this.options.verifyOfficialArtifacts !== false) await this.assertContainerImageDigest();
    return this.rpc<RealtimeRuntimeSnapshot>([
      tenantLookupExpression(projectRef),
      "versions = Realtime.Tenants.Migrations.migrations() |> Enum.map(fn {version, _module} -> Integer.to_string(version) end)",
      "runtime_version = Application.spec(:realtime, :vsn) |> to_string()",
      "%{runtimeVersion: runtime_version, tenantExternalId: tenant.external_id, tenantMigrationsRan: tenant.migrations_ran, migrationVersions: versions}",
    ].join(";"));
  }

  async walColumnRepairArtifact(): Promise<RealtimeWalColumnRepairArtifact> {
    this.walColumnArtifactPromise ??= (async () => {
      const artifact = await this.artifact();
      const manifestResult = await this.run([
        this.runtime,
        "exec",
        this.container,
        "cat",
        "--",
        artifact.manifest,
      ]);
      if (manifestResult.exitCode !== 0 || !manifestResult.stdout.trim()) {
        throw new Error(
          `failed to read bundled Realtime pgdelta manifest: ${redactSensitiveOutput(manifestResult.stderr).trim()}`,
        );
      }
      const manifest = validateRealtimeTenantSchemaManifest(manifestResult.stdout);
      if (manifest.sha256 !== OFFICIAL_REALTIME_MANIFEST_SHA256) {
        throw new Error(`running Realtime tenant schema manifest is not the verified ${OFFICIAL_REALTIME_RUNTIME_VERSION} manifest`);
      }
      const schemaFiles: NonNullable<RealtimeWalColumnRepairArtifact["schemaFiles"]> = [];
      for (const path of manifest.loadOrder) {
        const result = await this.run([
          this.runtime,
          "exec",
          this.container,
          "cat",
          "--",
          `${artifact.schema}/${path}`,
        ]);
        if (result.exitCode !== 0 || !result.stdout.trim()) {
          throw new Error(
            `failed to read bundled Realtime wal_column repair file ${path}: ${redactSensitiveOutput(result.stderr).trim()}`,
          );
        }
        schemaFiles.push({ path, sql: result.stdout });
      }
      const files = schemaFiles.filter((file) => WAL_COLUMN_REPAIR_PATHS.includes(
        file.path as (typeof WAL_COLUMN_REPAIR_PATHS)[number],
      ));
      if (this.options.verifyOfficialArtifacts !== false) {
        assertOfficialWalColumnRepairFiles(files);
        if (schemaTreeHash(schemaFiles) !== OFFICIAL_REALTIME_SCHEMA_TREE_SHA256) {
          throw new Error(`running Realtime tenant schema tree is not the verified ${OFFICIAL_REALTIME_RUNTIME_VERSION} artifact`);
        }
      }
      const profileResult = await this.run([
        this.runtime,
        "exec",
        this.container,
        "cat",
        "--",
        artifact.profile,
      ]);
      if (profileResult.exitCode !== 0 || !profileResult.stdout.trim()) {
        throw new Error(
          `failed to read bundled Realtime pgdelta profile: ${redactSensitiveOutput(profileResult.stderr).trim()}`,
        );
      }
      const repairArtifact = {
        sha256: walColumnRepairArtifactHash(files),
        manifestSha256: manifest.sha256,
        manifestLoadOrder: files.map((file) => file.path),
        profileSha256: createHash("sha256").update(profileResult.stdout).digest("hex"),
        profileContents: profileResult.stdout,
        schemaTreeSha256: schemaTreeHash(schemaFiles),
        schemaFiles,
        manifestContents: manifestResult.stdout,
        files,
      };
      assertWalColumnRepairArtifact(repairArtifact);
      if (
        this.options.verifyOfficialArtifacts !== false
        && repairArtifact.profileSha256 !== OFFICIAL_REALTIME_PROFILE_SHA256
      ) {
        throw new Error(`running Realtime pgdelta profile is not the verified ${OFFICIAL_REALTIME_RUNTIME_VERSION} profile`);
      }
      return repairArtifact;
    })();
    return this.walColumnArtifactPromise;
  }

  async plan(
    projectRef: string,
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<RealtimePgdeltaPlan> {
    assertProjectRef(projectRef);
    if (this.options.verifyOfficialArtifacts !== false) await this.assertContainerImageDigest();
    const target = await this.assertRpcTargetIdentity(projectRef, expectedIdentity);
    const artifact = await this.artifact();
    const repairArtifact = await this.walColumnRepairArtifact();
    const directory = await this.remoteTempDirectory();
    const planPath = `${directory}/plan.json`;
    try {
      const profilePath = await this.stageRemoteFile(
        directory,
        "pgdelta_profile.json",
        repairArtifact.profileContents || "",
      );
      const schemaPath = await this.stageRemoteSchemaTree(directory, repairArtifact);
      await this.runPgdeltaWithPassword(target, [
        "schema",
        "apply",
        "--dir",
        schemaPath,
        "--target",
        this.credentialFreeTargetUrl(target),
        "--profile",
        profilePath,
        "--dry-run",
        "--out-plan",
        planPath,
      ]);
      const planResult = await this.run([this.runtime, "exec", this.container, "cat", planPath]);
      if (planResult.exitCode !== 0) throw new Error("pgdelta did not write its dry-run plan");
      const plan = planResult.stdout;
      let decoded: { actions?: unknown[]; safetyReport?: { destructiveActions?: unknown } };
      try {
        decoded = JSON.parse(plan);
      } catch {
        throw new Error("pgdelta wrote an invalid dry-run plan");
      }
      if (!Array.isArray(decoded.actions)) throw new Error("pgdelta plan has no actions array");
      if (decoded.actions.length === 0) {
        return { status: "no_changes", plan: null, renderedSql: "", destructiveActions: 0 };
      }
      const destructiveActions = decoded.safetyReport?.destructiveActions ?? 0;
      if (!Number.isSafeInteger(destructiveActions) || Number(destructiveActions) < 0) {
        throw new Error("pgdelta plan has an invalid destructive action count");
      }
      const renderResult = await this.run([
        this.runtime,
        "exec",
        this.container,
        artifact.pgdelta,
        "render",
        "--plan",
        planPath,
        "--out",
        `${directory}/plan.sql`,
        "--allow-drops",
      ]);
      if (renderResult.exitCode !== 0) {
        throw new Error(`pgdelta could not render its plan: ${redactSensitiveOutput(renderResult.stderr).trim()}`);
      }
      const sqlResult = await this.run([
        this.runtime,
        "exec",
        this.container,
        "/bin/sh",
        "-eu",
        "-c",
        'for file in "$1"/plan*.sql; do [ -f "$file" ] || continue; cat "$file"; printf "\\n"; done',
        "supacloud-plan-render",
        directory,
      ]);
      if (sqlResult.exitCode !== 0) throw new Error("failed to read rendered pgdelta SQL");
      return {
        status: "changes",
        plan,
        renderedSql: sqlResult.stdout,
        destructiveActions: Number(destructiveActions),
      };
    } finally {
      await this.cleanupRemoteDirectory(directory);
    }
  }

  async applyPlan(
    projectRef: string,
    plan: string,
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<void> {
    assertProjectRef(projectRef);
    if (this.options.verifyOfficialArtifacts !== false) await this.assertContainerImageDigest();
    const target = await this.assertRpcTargetIdentity(projectRef, expectedIdentity);
    const artifact = await this.artifact();
    const repairArtifact = await this.walColumnRepairArtifact();
    const directory = await this.remoteTempDirectory();
    const planPath = `${directory}/plan.json`;
    try {
      const profilePath = await this.stageRemoteFile(
        directory,
        "pgdelta_profile.json",
        repairArtifact.profileContents || "",
      );
      const upload = await this.run(
        [this.runtime, "exec", "-i", this.container, "/bin/sh", "-eu", "-c", `umask 077; cat > ${planPath}`],
        { stdin: plan },
      );
      if (upload.exitCode !== 0) {
        throw new Error(`failed to stage pgdelta plan in Realtime container: ${redactSensitiveOutput(upload.stderr).trim()}`);
      }
      await this.runPgdeltaWithPassword(target, [
        "apply",
        "--plan",
        planPath,
        "--target",
        this.credentialFreeTargetUrl(target),
        "--profile",
        profilePath,
        "--allow-data-loss",
      ]);
    } finally {
      await this.cleanupRemoteDirectory(directory);
    }
  }

  async updateMigrationsRan(
    projectRef: string,
    count: number,
    expectedIdentity?: RealtimeTenantDatabaseIdentity,
  ): Promise<void> {
    assertProjectRef(projectRef);
    if (this.options.verifyOfficialArtifacts !== false) await this.assertContainerImageDigest();
    await this.assertRpcTargetIdentity(projectRef, expectedIdentity);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid Realtime migration count");
    const result = await this.rpc<{ ok?: boolean; error?: string }>([
      `ref = ${elixirString(projectRef)}`,
      `case Realtime.Api.update_migrations_ran(ref, ${count}) do`,
      '{:ok, _tenant} -> %{ok: true}',
      '{:error, reason} -> %{error: inspect(reason)}',
      "end",
    ].join(";"));
    if (!result.ok) throw new Error(`failed to update Realtime migrations_ran: ${redactSensitiveOutput(result.error || "unknown error")}`);
  }
}

export async function runCommand(
  argv: readonly string[],
  options: { stdin?: string } = {},
): Promise<CommandResult> {
  const proc = Bun.spawn([...argv], {
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined) {
    const stdin = proc.stdin;
    if (!stdin) throw new Error("failed to open child process stdin");
    stdin.write(options.stdin);
    stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}
