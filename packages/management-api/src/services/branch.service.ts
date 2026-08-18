/**
 * Branch Service.
 *
 * Clones a parent project database into a new tenant database for a preview
 * branch, provisions a runtime, and provides promote (branch -> parent) and
 * delete operations.
 *
 * The clone uses pg_dump piped to psql under the shared admin connection.
 * This avoids depending on a template DB and works on any Postgres the
 * platform already manages.
 */
import {
  generateDbName,
  getProjectDb,
  getProjectRoleDb,
  removeProjectDbCache,
  resolveAuthenticatorName,
  resolveBucketName,
  resolveRoleName,
  sql,
} from "../db";
import { databaseService } from "./database.service";
import { projectRepository } from "../repositories/project.repository";
import { tenantRuntimeService } from "./tenant-runtime.service";
import { logger } from "../utils/logger";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import {
  buildBranchMigrationPromotionPlan,
  detectUnsupportedMigrationOperations,
  summarizeMigrationLedgerEntry,
  type BranchMigrationPromotionPlan,
  type MigrationLedgerEntry,
  type MigrationPromotionSummary,
} from "./migration-promotion";
import {
  ensureMigrationLedgerMetadata as ensureLedgerMetadata,
  readMigrationLedger,
} from "./migration-ledger";
import {
  ProjectMigrationLockError,
  withProjectMigrationLocks,
} from "./migration-lock";
import { prepareProjectMigrationRole } from "./project-migration-role";
import {
  BranchReplacementJournalActiveError,
  branchReplacementJournal,
  type BranchReplacementJournalEntry,
} from "./branch-replacement-journal";
import {
  issueMigrationLedgerLease,
  releaseMigrationLedgerLease,
} from "./migration-ledger-lease";

type ProjectSql = ReturnType<typeof getProjectDb>;
type ReservedProjectSql = Awaited<ReturnType<ProjectSql["reserve"]>>;

interface ParsedPostgresConnection {
  username: string;
  password: string;
  hostname: string;
  port: string;
  database: string;
  environment: Record<string, string | undefined>;
}

const POSTGRES_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MAX_POSTGRES_DIAGNOSTIC_BYTES = 4_096;
const MAX_POSTGRES_SECRET_BYTES = 1_024;
const REDACTED_MARKER = "[REDACTED]";
const OUTPUT_TRUNCATED_MARKER = "[output truncated]";
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
const POSTGRES_SSL_MODES = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);

function buildPostgresProcessEnvironment(connection: ParsedPostgresConnection): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key === "DATABASE_URL" || key.startsWith("PG")) delete environment[key];
  }
  environment.PGPASSWORD = connection.password;
  if (connection.environment.PGSSLMODE) {
    environment.PGSSLMODE = connection.environment.PGSSLMODE;
  }
  return environment;
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  if (right.byteLength === 0) return left;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function bytePatternMatches(source: Uint8Array, offset: number, pattern: Uint8Array): boolean {
  if (offset + pattern.byteLength > source.byteLength) return false;
  for (let index = 0; index < pattern.byteLength; index += 1) {
    if (source[offset + index] !== pattern[index]) return false;
  }
  return true;
}

function diagnosticSecretPatterns(secrets: readonly string[]): Uint8Array[] {
  const candidates = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    if (UTF8_ENCODER.encode(secret).byteLength > MAX_POSTGRES_SECRET_BYTES) {
      throw new Error(`PostgreSQL diagnostic secret exceeds ${MAX_POSTGRES_SECRET_BYTES} UTF-8 bytes`);
    }
    candidates.add(secret);
    try {
      const encoded = encodeURIComponent(secret);
      candidates.add(encoded);
      candidates.add(encoded.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase()));
    } catch {
      // The raw UTF-8 form is still redacted if the value cannot be URI-encoded.
    }
  }
  return [...candidates]
    .map((candidate) => UTF8_ENCODER.encode(candidate))
    .filter((candidate) => candidate.byteLength > 0)
    .sort((left, right) => right.byteLength - left.byteLength);
}

function boundedUtf8Text(text: string, maxBytes = MAX_POSTGRES_DIAGNOSTIC_BYTES): string {
  if (UTF8_ENCODER.encode(text).byteLength <= maxBytes) return text;

  const marker = `\n${OUTPUT_TRUNCATED_MARKER}`;
  const prefixLimit = maxBytes - UTF8_ENCODER.encode(marker).byteLength;
  let prefix = "";
  let prefixBytes = 0;
  for (const character of text) {
    const characterBytes = UTF8_ENCODER.encode(character).byteLength;
    if (prefixBytes + characterBytes > prefixLimit) break;
    prefix += character;
    prefixBytes += characterBytes;
  }
  return `${prefix}${marker}`;
}

async function readRedactedBoundedText(
  stream: ReadableStream<Uint8Array>,
  secrets: readonly string[],
  maxBytes = MAX_POSTGRES_DIAGNOSTIC_BYTES,
): Promise<string> {
  const patterns = diagnosticSecretPatterns(secrets);
  const longestPattern = patterns[0]?.byteLength ?? 1;
  const replacement = UTF8_ENCODER.encode(REDACTED_MARKER);
  const reader = stream.getReader();
  const outputChunks: Uint8Array[] = [];
  let outputBytes = 0;
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();

  const appendOutput = (value: Uint8Array): boolean => {
    const remainingCapture = Math.max(0, maxBytes + 1 - outputBytes);
    if (remainingCapture > 0) {
      outputChunks.push(value.subarray(0, remainingCapture).slice());
    }
    outputBytes += value.byteLength;
    return outputBytes > maxBytes;
  };
  const finishTruncated = async (): Promise<string> => {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    const captured = outputChunks.reduce(appendBytes, new Uint8Array());
    return boundedUtf8Text(UTF8_DECODER.decode(captured), maxBytes);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) pending = appendBytes(pending, value);
    const processLimit = done
      ? pending.byteLength
      : Math.max(0, pending.byteLength - longestPattern + 1);
    let offset = 0;

    while (offset < processLimit) {
      const matchedPattern = patterns.find((pattern) => bytePatternMatches(pending, offset, pattern));
      if (matchedPattern) {
        if (appendOutput(replacement)) {
          return finishTruncated();
        }
        offset += matchedPattern.byteLength;
      } else {
        if (appendOutput(pending.subarray(offset, offset + 1))) {
          return finishTruncated();
        }
        offset += 1;
      }
    }

    pending = pending.slice(offset);
    if (done) break;
  }

  const captured = outputChunks.reduce(appendBytes, new Uint8Array());
  return boundedUtf8Text(UTF8_DECODER.decode(captured), maxBytes);
}

function pgDollarQuote(value: string): string {
  const tag = `pw${Bun.hash(value).toString(36).slice(0, 6)}${crypto.randomUUID().slice(0, 8)}`;
  return `$${tag}$${value}$${tag}$`;
}

function createPostgresScramVerifier(password: string): string {
  const iterations = 4_096;
  const salt = randomBytes(16);
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

export interface CreateBranchInput {
  parentRef: string;
  branchRef: string;
  name: string;
  dataMode?: BranchDataMode;
}

export type BranchDataMode = "schema_only" | "full_clone";

export type BranchPromotionErrorCode =
  | "promotion_locked"
  | "promotion_plan_changed"
  | "promotion_blocked"
  | "destructive_confirmation_required"
  | "promotion_apply_failed"
  | "promotion_readback_failed";

export class BranchPromotionError extends Error {
  constructor(
    public readonly code: BranchPromotionErrorCode,
    public readonly httpStatus: 409 | 423 | 500,
    message: string,
    public readonly plan?: BranchMigrationPromotionPlan,
    public readonly applied: MigrationPromotionSummary[] = [],
  ) {
    super(message);
    this.name = "BranchPromotionError";
  }
}

export type BranchReplacementErrorCode =
  | "replacement_locked"
  | "replacement_switch_failed"
  | "replacement_runtime_unavailable";

export class BranchReplacementError extends Error {
  constructor(
    public readonly code: BranchReplacementErrorCode,
    public readonly httpStatus: 423 | 500 | 503,
    message: string,
    public readonly replacementCommitted: boolean,
    public readonly backupDatabase?: string,
    public readonly recoveryRequired: boolean = replacementCommitted,
    public readonly recoveryDatabase?: string,
  ) {
    super(message);
    this.name = "BranchReplacementError";
  }
}

interface BranchPromotionState {
  plan: BranchMigrationPromotionPlan;
  pendingEntries: MigrationLedgerEntry[];
}

interface ReplacementDatabaseNames {
  parentDb: string;
  branchDb: string;
  tempDb: string;
  backupDb: string;
}

interface ReplacementRecoveryResult {
  succeeded: boolean;
  recoveryDatabase: string;
}

class BranchService {
  async createBranch(input: CreateBranchInput): Promise<void> {
    const { parentRef, branchRef, name } = input;
    const dataMode = input.dataMode ?? "schema_only";
    const parent = await projectRepository.findByRef(parentRef);
    if (!parent) throw new Error("Parent project not found");

    const parentDbName = generateDbName(parentRef);
    const branchDbName = generateDbName(branchRef);
    const branchDbUser = resolveRoleName(branchRef);
    const dbPassword = databaseService.generatePassword();

    // Reuse parent's JWT secret and API keys so the same client SDK works.
    const { jwtSecret, anonKey, serviceRoleKey } = {
      jwtSecret: parent.jwt_secret,
      anonKey: parent.anon_key,
      serviceRoleKey: parent.service_role_key,
    };

    // 1. Create branch project row sharing parent credentials.
    const branchProject = await projectRepository.create({
      ref: branchRef,
      name: `${parent.name} [branch: ${name}]`,
      db_name: branchDbName,
      db_user: branchDbUser,
      db_password: dbPassword,
      jwt_secret: jwtSecret,
      anon_key: anonKey,
      service_role_key: serviceRoleKey,
      s3_bucket: resolveBucketName(branchRef),
      region: parent.region || "local",
      config: {
        parent_ref: parentRef,
        branch_name: name,
        is_branch: true,
        branch_data_mode: dataMode,
      },
    });
    if (!branchProject) throw new Error("Failed to create branch project record");

    // 2. Hold the same control-plane lock used by migrations while taking the
    // schema snapshot and copying its ledger. This prevents a migration from
    // committing between pg_dump and the ledger read.
    await this.withBranchProvisionLock({ parentRef, branchRef }, async () => {
      await this.createEmptyTenantDatabase(branchDbName, branchRef, dbPassword);
      await this.cloneDatabase(parentDbName, branchDbName, dataMode);
      if (dataMode === "schema_only") {
        await this.copyMigrationLedgerHistory(parentDbName, branchDbName);
      }
      await this.applyRuntimeGrants(branchDbName, branchRef, dbPassword);
      await this.prepareMigrationDatabaseRole(branchDbName, branchDbUser);
    });

    // 3. Start tenant runtime (PostgREST + GoTrue) for the branch.
    await tenantRuntimeService.restartRuntime(branchRef);

    logger.info(`[branch] created ${branchRef} from ${parentRef}`);
  }

  private async prepareMigrationDatabaseRole(dbName: string, dbUser: string): Promise<void> {
    const adminDb = getProjectDb(dbName);
    await this.ensureMigrationLedgerMetadata(adminDb);
    await prepareProjectMigrationRole(adminDb, dbName, dbUser);
  }

  private async withBranchProvisionLock<T>(
    input: { parentRef: string; branchRef: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    return withProjectMigrationLocks(
      { projectRefs: [input.parentRef, input.branchRef] },
      async () => {
        await branchReplacementJournal.assertInactive([input.parentRef, input.branchRef]);
        return operation();
      },
    );
  }

  private async createEmptyTenantDatabase(
    dbName: string,
    projectRef: string,
    password: string,
  ): Promise<void> {
    const dbUser = resolveRoleName(projectRef);
    const authenticatorRole = resolveAuthenticatorName(projectRef);

    if (await this.databaseExists(dbName)) {
      throw new Error(`Database ${dbName} already exists; refusing to restore into a non-empty target`);
    }
    const passwordVerifier = createPostgresScramVerifier(password);

    await this.executeUnsafeSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN NOINHERIT;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN NOINHERIT;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${this.literalQuote(dbUser)}') THEN
          CREATE ROLE ${this.identQuote(dbUser)} LOGIN CONNECTION LIMIT 20 PASSWORD ${pgDollarQuote(passwordVerifier)};
        ELSE
          ALTER ROLE ${this.identQuote(dbUser)} LOGIN CONNECTION LIMIT 20 PASSWORD ${pgDollarQuote(passwordVerifier)};
        END IF;
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${this.literalQuote(authenticatorRole)}') THEN
          CREATE ROLE ${this.identQuote(authenticatorRole)} CONNECTION LIMIT 30 NOINHERIT LOGIN PASSWORD ${pgDollarQuote(passwordVerifier)};
        ELSE
          ALTER ROLE ${this.identQuote(authenticatorRole)} CONNECTION LIMIT 30 NOINHERIT LOGIN PASSWORD ${pgDollarQuote(passwordVerifier)};
        END IF;
      END
      $$;
    `);

    await this.executeUnsafeSql(`CREATE DATABASE ${this.identQuote(dbName)} OWNER ${this.identQuote(dbUser)}`);
    await this.executeUnsafeSql(`
      GRANT CONNECT, TEMPORARY ON DATABASE ${this.identQuote(dbName)} TO ${this.identQuote(dbUser)};
      GRANT CONNECT, TEMPORARY ON DATABASE ${this.identQuote(dbName)} TO ${this.identQuote(authenticatorRole)};
      GRANT anon, authenticated, service_role TO ${this.identQuote(authenticatorRole)};
    `);
  }

  private async databaseExists(dbName: string): Promise<boolean> {
    const [existing] = await sql`SELECT 1 FROM pg_database WHERE datname = ${dbName} LIMIT 1`;
    return Boolean(existing);
  }

  private async executeUnsafeSql(statement: string): Promise<void> {
    await sql.unsafe(statement);
  }

  private async cloneDatabase(
    sourceDb: string,
    targetDb: string,
    dataMode: BranchDataMode = "full_clone",
  ): Promise<void> {
    // The platform admin DB credentials are used for both sides of the dump/restore.
    const adminDbUrl = process.env.DATABASE_URL;
    if (!adminDbUrl) throw new Error("DATABASE_URL is not set; cannot clone branch database");
    const connection = this.parsePostgresConnection(adminDbUrl);
    const processEnvironment = buildPostgresProcessEnvironment(connection);

    // --no-owner --no-privileges avoids role mismatch errors on restore. Both
    // processes receive discrete argv so credentials never cross a shell or argv.
    const dump = Bun.spawn({
      cmd: [
        "pg_dump",
        "--no-owner",
        "--no-privileges",
        ...(dataMode === "schema_only" ? ["--schema-only"] : []),
        "--host", connection.hostname,
        "--port", connection.port,
        "--username", connection.username,
        "--dbname", sourceDb,
      ],
      env: processEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const restore = Bun.spawn({
      cmd: [
        "psql",
        "--host", connection.hostname,
        "--port", connection.port,
        "--username", connection.username,
        "--dbname", targetDb,
        "--set", "ON_ERROR_STOP=on",
        "--quiet",
      ],
      env: processEnvironment,
      stdin: dump.stdout,
      stdout: "ignore",
      stderr: "pipe",
    });

    const [dumpExitCode, restoreExitCode, dumpStderr, restoreStderr] = await Promise.all([
      dump.exited,
      restore.exited,
      readRedactedBoundedText(dump.stderr, [connection.password]),
      readRedactedBoundedText(restore.stderr, [connection.password]),
    ]);
    if (dumpExitCode !== 0 || restoreExitCode !== 0) {
      const failures: string[] = [];
      if (dumpExitCode !== 0) {
        failures.push(`pg_dump exited with code ${dumpExitCode}: ${dumpStderr.trim() || "no stderr output"}`);
      }
      if (restoreExitCode !== 0) {
        failures.push(`psql exited with code ${restoreExitCode}: ${restoreStderr.trim() || "no stderr output"}`);
      }
      throw new Error(boundedUtf8Text(`Database clone failed: ${failures.join("\n")}`));
    }
  }

  private parsePostgresConnection(value: string): ParsedPostgresConnection {
    if (POSTGRES_CONTROL_CHARACTER.test(value)) {
      throw new Error("DATABASE_URL contains a forbidden control character");
    }

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
    }

    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("DATABASE_URL must use the postgres or postgresql scheme");
    }
    if (parsed.hash) {
      throw new Error("DATABASE_URL must not contain a fragment");
    }

    let username: string;
    let password: string;
    let database: string;
    try {
      username = decodeURIComponent(parsed.username);
      password = decodeURIComponent(parsed.password);
      database = decodeURIComponent(parsed.pathname.slice(1));
    } catch {
      throw new Error("DATABASE_URL contains invalid percent encoding");
    }

    const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
    const port = parsed.port || "5432";
    if (!username || !password || !hostname || !database) {
      throw new Error("DATABASE_URL must include username, password, hostname, and database");
    }
    if (UTF8_ENCODER.encode(password).byteLength > MAX_POSTGRES_SECRET_BYTES) {
      throw new Error(`DATABASE_URL password exceeds ${MAX_POSTGRES_SECRET_BYTES} UTF-8 bytes`);
    }
    if (database.includes("/") || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
      throw new Error("DATABASE_URL contains an invalid database name or port");
    }
    for (const [name, component] of Object.entries({ username, password, hostname, database })) {
      if (POSTGRES_CONTROL_CHARACTER.test(component)) {
        throw new Error(`DATABASE_URL ${name} contains a forbidden control character`);
      }
    }

    const environment: Record<string, string | undefined> = {};
    const sslModes = parsed.searchParams.getAll("sslmode");
    if (sslModes.length > 1 || (sslModes[0] && !POSTGRES_SSL_MODES.has(sslModes[0]))) {
      throw new Error("DATABASE_URL contains an invalid sslmode");
    }
    if (sslModes[0]) environment.PGSSLMODE = sslModes[0];
    return { username, password, hostname, port, database, environment };
  }

  private async readMigrationLedger(database: ProjectSql | ReservedProjectSql): Promise<MigrationLedgerEntry[]> {
    return readMigrationLedger(database);
  }

  private async buildPromotionState(
    parentRef: string,
    branchRef: string,
  ): Promise<BranchPromotionState> {
    const [parentProject, branchProject] = await Promise.all([
      projectRepository.findByRef(parentRef),
      projectRepository.findByRef(branchRef),
    ]);
    if (!parentProject || !branchProject) {
      throw new BranchPromotionError("promotion_apply_failed", 500, "Parent or branch project not found");
    }
    const parentDatabase = getProjectDb(parentProject.db_name);
    const branchDatabase = getProjectDb(branchProject.db_name);
    await Promise.all([
      this.ensureMigrationLedgerMetadata(parentDatabase),
      this.ensureMigrationLedgerMetadata(branchDatabase),
    ]);
    await Promise.all([
      prepareProjectMigrationRole(parentDatabase, parentProject.db_name, parentProject.db_user),
      prepareProjectMigrationRole(branchDatabase, branchProject.db_name, branchProject.db_user),
    ]);
    const [parent, branch] = await Promise.all([
      this.readMigrationLedger(parentDatabase),
      this.readMigrationLedger(branchDatabase),
    ]);
    const plan = buildBranchMigrationPromotionPlan({ parentRef, branchRef, parent, branch });
    const pendingVersions = new Set(plan.pending.map((entry) => entry.version));
    return {
      plan,
      pendingEntries: branch.filter((entry) => pendingVersions.has(entry.version)),
    };
  }

  async planBranchPromotion(input: { parentRef: string; branchRef: string }): Promise<BranchMigrationPromotionPlan> {
    return this.withPromotionLock(input, async () =>
      (await this.buildPromotionState(input.parentRef, input.branchRef)).plan,
    );
  }

  private async withPromotionLock<T>(
    input: { parentRef: string; branchRef: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await withProjectMigrationLocks(
        { projectRefs: [input.parentRef, input.branchRef] },
        async () => {
          await branchReplacementJournal.assertInactive([input.parentRef, input.branchRef]);
          return operation();
        },
      );
    } catch (error: unknown) {
      if (!(error instanceof ProjectMigrationLockError) && !(error instanceof BranchReplacementJournalActiveError)) {
        throw error;
      }
      throw new BranchPromotionError("promotion_locked", 423, error.message);
    }
  }

  private async ensureMigrationLedgerMetadata(connection: ProjectSql | ReservedProjectSql): Promise<void> {
    await ensureLedgerMetadata(connection);
  }

  private async copyMigrationLedgerHistory(sourceDbName: string, targetDbName: string): Promise<void> {
    const source = getProjectDb(sourceDbName);
    const target = getProjectDb(targetDbName);
    const sourceEntries = await this.readMigrationLedger(source);
    if (sourceEntries.length === 0) return;

    const connection = await target.reserve();
    try {
      await this.ensureMigrationLedgerMetadata(connection);
      await connection.begin(async (tx) => {
        for (const entry of sourceEntries) {
          const statements = tx.array(entry.statements, "TEXT");
          await tx`
            INSERT INTO supabase_migrations.schema_migrations
              (version, statements, name, checksum, inserted_at)
            VALUES
              (${entry.version}, ${statements}, ${entry.name}, ${entry.checksum}, COALESCE(CAST(${entry.applied_at} AS TIMESTAMPTZ), now()))
            ON CONFLICT (version) DO NOTHING
          `;
          await tx`
            INSERT INTO public.schema_migrations
              (version, statements, name, checksum, inserted_at)
            VALUES
              (${entry.version}, ${statements}, ${entry.name}, ${entry.checksum}, COALESCE(CAST(${entry.applied_at} AS TIMESTAMPTZ), now()))
            ON CONFLICT (version) DO NOTHING
          `;
        }
      });
    } finally {
      connection.release();
    }
  }

  private async applyMigrationBatch(
    parentRef: string,
    entries: readonly MigrationLedgerEntry[],
  ): Promise<MigrationPromotionSummary[]> {
    if (entries.length === 0) return [];
    const parent = await projectRepository.findByRef(parentRef);
    if (!parent) throw new BranchPromotionError("promotion_apply_failed", 500, "Parent project not found");

    const adminDb = getProjectDb(parent.db_name);
    await this.ensureMigrationLedgerMetadata(adminDb);
    await prepareProjectMigrationRole(adminDb, parent.db_name, parent.db_user);
    const migrationDb = getProjectRoleDb(parent.db_name, parent.db_user, parent.db_password);
    const connection = await migrationDb.reserve();
    const applied: MigrationPromotionSummary[] = [];
    try {
      for (const entry of entries) {
        this.assertPromotionSqlSupported(entry, applied);
        try {
          await this.applyMigrationEntry(connection, adminDb, entry);
          applied.push(summarizeMigrationLedgerEntry(entry));
        } catch (error: unknown) {
          this.throwPromotionApplyError(error, entry, applied);
        }
      }
    } finally {
      await this.releaseMigrationSession(connection, parentRef, parent.db_name);
    }
    await this.ensureOptionalRealtimePublication(adminDb);
    return applied;
  }

  private assertPromotionSqlSupported(
    entry: MigrationLedgerEntry,
    applied: readonly MigrationPromotionSummary[],
  ): void {
    const unsupported = detectUnsupportedMigrationOperations(entry.statements);
    if (unsupported.length === 0) return;
    throw new BranchPromotionError(
      "promotion_plan_changed",
      409,
      `Migration ${entry.version} contains unsupported SQL: ${unsupported.join(", ")}`,
      undefined,
      [...applied],
    );
  }

  private async applyMigrationEntry(
    connection: ReservedProjectSql,
    adminDb: ProjectSql,
    entry: MigrationLedgerEntry,
  ): Promise<void> {
    const leaseHolder: { current?: Awaited<ReturnType<typeof issueMigrationLedgerLease>> } = {};
    try {
      await connection.begin(async (tx) => {
        const existing = await tx<{ version: string }[]>`
          SELECT version::text AS version
          FROM supabase_migrations.schema_migrations
          WHERE version = ${entry.version}
        `;
        if (existing.length > 0) {
          throw new BranchPromotionError(
            "promotion_plan_changed",
            409,
            `Migration ${entry.version} was applied after the promotion plan was created`,
          );
        }
        for (const statement of entry.statements) await tx.unsafe(statement);
        const issuedLease = await issueMigrationLedgerLease(adminDb, entry.version, entry.checksum);
        leaseHolder.current = issuedLease;
        const statements = tx.array(entry.statements, "TEXT");
        await tx`
          SELECT supabase_migrations.record_schema_migration(
            ${entry.version},
            ${statements},
            ${entry.name},
            ${entry.checksum},
            ${issuedLease.token}
          )
        `;
      });
    } finally {
      const lease = leaseHolder.current;
      if (lease) {
        try {
          await releaseMigrationLedgerLease(adminDb, lease.tokenHash);
        } catch (error: unknown) {
          logger.warn(`[branch] failed to clean migration ledger lease for ${entry.version}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private throwPromotionApplyError(
    error: unknown,
    entry: MigrationLedgerEntry,
    applied: readonly MigrationPromotionSummary[],
  ): never {
    if (error instanceof BranchPromotionError) {
      if (applied.length === 0 || error.applied.length > 0) throw error;
      throw new BranchPromotionError(error.code, error.httpStatus, error.message, error.plan, [...applied]);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new BranchPromotionError(
      "promotion_apply_failed",
      500,
      `Failed to apply migration ${entry.version}: ${detail}`,
      undefined,
      [...applied],
    );
  }

  private async releaseMigrationSession(
    connection: ReservedProjectSql,
    parentRef: string,
    dbName: string,
  ): Promise<void> {
    let reset = true;
    try {
      await connection.unsafe("DISCARD ALL");
    } catch (error: unknown) {
      reset = false;
      logger.warn(`[branch] failed to reset migration session for ${parentRef}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    connection.release();
    if (!reset) await removeProjectDbCache(dbName);
  }

  private async ensureOptionalRealtimePublication(adminDb: ProjectSql): Promise<void> {
    try {
      await adminDb`SELECT realtime.ensure_tasks_publication()`;
    } catch {
      // Realtime is optional for older or deliberately minimal tenants.
    }
  }

  async promoteBranch(input: {
    parentRef: string;
    branchRef: string;
    expectedPlanChecksum: string;
    confirmDestructive?: boolean;
  }): Promise<{ applied: MigrationPromotionSummary[]; plan: BranchMigrationPromotionPlan }> {
    return this.withPromotionLock(input, async () => {
      const state = await this.buildPromotionState(input.parentRef, input.branchRef);
      this.assertReviewedPromotionPlan(state.plan, input);
      const applied = await this.applyMigrationBatch(input.parentRef, state.pendingEntries);
      const readback = await this.readBackPromotionState(input, applied);
      if (readback.plan.pending.length > 0 || !readback.plan.safe_to_apply) {
        throw new BranchPromotionError(
          "promotion_readback_failed",
          500,
          "Migration promotion completed but ledger read-back did not converge",
          readback.plan,
          applied,
        );
      }
      return { applied, plan: readback.plan };
    });
  }

  private assertReviewedPromotionPlan(
    plan: BranchMigrationPromotionPlan,
    input: { expectedPlanChecksum: string; confirmDestructive?: boolean },
  ): void {
    if (plan.plan_checksum !== input.expectedPlanChecksum) {
      throw new BranchPromotionError(
        "promotion_plan_changed",
        409,
        "The migration plan changed; review the latest plan before promoting",
        plan,
      );
    }
    if (!plan.safe_to_apply) {
      throw new BranchPromotionError(
        "promotion_blocked",
        409,
        "The migration plan contains blocking conflicts",
        plan,
      );
    }
    if (plan.requires_destructive_confirmation && !input.confirmDestructive) {
      throw new BranchPromotionError(
        "destructive_confirmation_required",
        409,
        "The migration plan contains destructive SQL and requires explicit confirmation",
        plan,
      );
    }
  }

  private async readBackPromotionState(
    input: { parentRef: string; branchRef: string },
    applied: readonly MigrationPromotionSummary[],
  ): Promise<BranchPromotionState> {
    try {
      return await this.buildPromotionState(input.parentRef, input.branchRef);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BranchPromotionError(
        "promotion_readback_failed",
        500,
        `Migration promotion committed, but ledger read-back failed: ${detail}`,
        undefined,
        [...applied],
      );
    }
  }

  async deleteBranch(branchRef: string): Promise<void> {
    // Stop runtime first.
    try {
      await tenantRuntimeService.stopRuntime(branchRef);
    } catch (err: unknown) {
      logger.warn(`[branch] failed to stop runtime for ${branchRef}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Drop the branch database.
    try {
      const dbName = generateDbName(branchRef);
      await sql.unsafe(`DROP DATABASE IF EXISTS ${this.identQuote(dbName)}`);
    } catch (err: unknown) {
      logger.warn(`[branch] failed to drop database for ${branchRef}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Soft-delete the branch project row.
    await projectRepository.softDelete(branchRef);
  }

  async replaceParentDatabaseFromBranch(input: {
    parentRef: string;
    branchRef: string;
  }): Promise<{ backupDatabase: string }> {
    try {
      return await withProjectMigrationLocks(
        { projectRefs: [input.parentRef, input.branchRef] },
        () => this.replaceParentDatabaseUnderLock(input),
      );
    } catch (error: unknown) {
      if (error instanceof ProjectMigrationLockError) {
        throw new BranchReplacementError("replacement_locked", 423, error.message, false);
      }
      throw error;
    }
  }

  private async replaceParentDatabaseUnderLock(input: {
    parentRef: string;
    branchRef: string;
  }): Promise<{ backupDatabase: string }> {
    const { parentRef, branchRef } = input;
    await this.recoverExistingReplacement(parentRef);
    const parent = await projectRepository.findByRef(parentRef);
    if (!parent) throw new Error("Parent project not found");
    const names = this.replacementDatabaseNames(parentRef, branchRef);
    await branchReplacementJournal.begin({
      parentRef,
      branchRef,
      parentDb: names.parentDb,
      branchDb: names.branchDb,
      tempDb: names.tempDb,
      backupDb: names.backupDb,
    });
    try {
      await this.prepareReplacementDatabase(parentRef, parent.db_password, names);
      await branchReplacementJournal.setPhase(parentRef, "prepared");
    } catch (error: unknown) {
      await this.clearReplacementJournalBestEffort(parentRef);
      throw error;
    }
    await this.switchParentDatabase(parentRef, names);
    await this.restartReplacedParentRuntime(parentRef, names);
    await this.clearReplacementJournalBestEffort(parentRef);
    logger.info(`[branch] replaced ${parentRef} from ${branchRef}; previous parent kept as ${names.backupDb}`);
    return { backupDatabase: names.backupDb };
  }

  private async recoverExistingReplacement(parentRef: string): Promise<void> {
    const entry = await branchReplacementJournal.get(parentRef);
    if (!entry) return;
    if (await this.recoverReplacementJournalEntry(entry)) return;
    throw new BranchReplacementError(
      "replacement_switch_failed",
      503,
      `An interrupted database replacement for ${parentRef} still requires manual recovery`,
      entry.replacement_committed,
      entry.backup_db,
      true,
      entry.recovery_database ?? entry.backup_db,
    );
  }

  async recoverInterruptedReplacements(): Promise<{ checked: number; recovered: number; pending: number }> {
    const entries = await branchReplacementJournal.list();
    let recovered = 0;
    let pending = 0;
    for (const entry of entries) {
      try {
        const didRecover = await withProjectMigrationLocks(
          { projectRefs: [entry.parent_ref, entry.branch_ref] },
          async () => {
            const current = await branchReplacementJournal.get(entry.parent_ref);
            return current ? this.recoverReplacementJournalEntry(current) : true;
          },
        );
        if (didRecover) recovered += 1;
        else pending += 1;
      } catch (error: unknown) {
        pending += 1;
        logger.error(`[branch] interrupted replacement recovery failed for ${entry.parent_ref}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { checked: entries.length, recovered, pending };
  }

  private replacementDatabaseNames(parentRef: string, branchRef: string): ReplacementDatabaseNames {
    const parentDb = generateDbName(parentRef);
    const suffix = Date.now().toString(36);
    return {
      parentDb,
      branchDb: generateDbName(branchRef),
      tempDb: this.derivedDbName(parentDb, `promote_${suffix}`),
      backupDb: this.derivedDbName(parentDb, `backup_${suffix}`),
    };
  }

  private async prepareReplacementDatabase(
    parentRef: string,
    password: string,
    names: ReplacementDatabaseNames,
  ): Promise<void> {
    try {
      await this.createEmptyTenantDatabase(names.tempDb, parentRef, password);
      await this.cloneDatabase(names.branchDb, names.tempDb);
      await this.applyRuntimeGrants(names.tempDb, parentRef, password);
      await this.validateRestoredDatabase(names.tempDb);
    } catch (error: unknown) {
      await this.dropDatabaseWithWarning(names.tempDb, "replacement temp DB");
      const detail = error instanceof Error ? error.message : String(error);
      throw new BranchReplacementError("replacement_switch_failed", 500, `Replacement database preparation failed: ${detail}`, false);
    }
  }

  private async switchParentDatabase(parentRef: string, names: ReplacementDatabaseNames): Promise<void> {
    let parentRenamed = false;
    let tempRenamed = false;
    let connectionsDisabled = false;
    try {
      await tenantRuntimeService.stopRuntime(parentRef);
      await this.setDatabaseConnectionsAllowed(names.parentDb, false);
      connectionsDisabled = true;
      await branchReplacementJournal.setPhase(parentRef, "connections_disabled", names.parentDb);
      await removeProjectDbCache(names.parentDb);
      await this.terminateDatabaseConnections(names.parentDb);
      await this.terminateDatabaseConnections(names.tempDb);
      await this.renameDatabase(names.parentDb, names.backupDb);
      parentRenamed = true;
      await branchReplacementJournal.setPhase(parentRef, "parent_renamed", names.backupDb);
      await this.renameDatabase(names.tempDb, names.parentDb);
      tempRenamed = true;
      await branchReplacementJournal.setPhase(parentRef, "replacement_committed", names.backupDb, true);
    } catch (error: unknown) {
      if (tempRenamed) {
        const detail = error instanceof Error ? error.message : String(error);
        try {
          await this.restartParentRuntimeAndVerify(parentRef, names.parentDb);
        } catch (runtimeError: unknown) {
          logger.error(`[branch] committed replacement runtime recovery failed for ${parentRef}`, {
            error: runtimeError instanceof Error ? runtimeError.message : String(runtimeError),
          });
        }
        await this.markReplacementRecoveryRequiredBestEffort(parentRef, names.backupDb, true);
        throw new BranchReplacementError(
          "replacement_switch_failed",
          503,
          `Database replacement committed, but its durable phase could not be recorded: ${detail}`,
          true,
          names.backupDb,
          true,
          names.backupDb,
        );
      }
      const recovery = await this.recoverReplacementSwitch(parentRef, names, {
        parentRenamed,
        tempRenamed,
        connectionsDisabled,
      });
      const detail = error instanceof Error ? error.message : String(error);
      if (recovery.succeeded) {
        await this.clearReplacementJournalBestEffort(parentRef);
      } else {
        await this.markReplacementRecoveryRequiredBestEffort(parentRef, recovery.recoveryDatabase, false);
      }
      throw new BranchReplacementError(
        "replacement_switch_failed",
        500,
        recovery.succeeded
          ? `Replacement failed before the parent database switch completed: ${detail}`
          : `Replacement failed and rollback could not be verified: ${detail}`,
        false,
        recovery.recoveryDatabase === names.backupDb ? names.backupDb : undefined,
        !recovery.succeeded,
        recovery.succeeded ? undefined : recovery.recoveryDatabase,
      );
    }
  }

  private async recoverReplacementSwitch(
    parentRef: string,
    names: ReplacementDatabaseNames,
    state: { parentRenamed: boolean; tempRenamed: boolean; connectionsDisabled: boolean },
  ): Promise<ReplacementRecoveryResult> {
    let rollbackSucceeded = true;
    let recoveryDatabase = state.parentRenamed ? names.backupDb : names.parentDb;
    if (state.parentRenamed && !state.tempRenamed) {
      rollbackSucceeded = await this.restoreParentDatabaseName(parentRef, names);
      if (rollbackSucceeded) recoveryDatabase = names.parentDb;
    }
    if (!state.tempRenamed && state.connectionsDisabled && rollbackSucceeded) {
      rollbackSucceeded = await this.reenableParentConnections(parentRef, names.parentDb);
    }
    if (!state.tempRenamed) await this.dropDatabaseWithWarning(names.tempDb, "promote temp DB");
    await this.restartParentRuntimeBestEffort(parentRef, names.parentDb);
    return { succeeded: rollbackSucceeded, recoveryDatabase };
  }

  private async restoreParentDatabaseName(
    parentRef: string,
    names: ReplacementDatabaseNames,
  ): Promise<boolean> {
    try {
      await this.renameDatabase(names.backupDb, names.parentDb);
      return true;
    } catch (error: unknown) {
      logger.error(`[branch] failed to roll back promote rename for ${parentRef}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async reenableParentConnections(parentRef: string, parentDb: string): Promise<boolean> {
    try {
      await this.setDatabaseConnectionsAllowed(parentDb, true);
      return true;
    } catch (error: unknown) {
      logger.error(`[branch] failed to re-enable parent database connections for ${parentRef}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async restartParentRuntimeBestEffort(parentRef: string, parentDb: string): Promise<void> {
    try {
      await removeProjectDbCache(parentDb);
      await tenantRuntimeService.restartRuntime(parentRef);
    } catch (error: unknown) {
      logger.warn(`[branch] failed to restart parent runtime after replacement attempt ${parentRef}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async restartReplacedParentRuntime(
    parentRef: string,
    names: ReplacementDatabaseNames,
  ): Promise<void> {
    try {
      await this.restartParentRuntimeAndVerify(parentRef, names.parentDb);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.markReplacementRecoveryRequiredBestEffort(parentRef, names.backupDb, true);
      throw new BranchReplacementError(
        "replacement_runtime_unavailable",
        503,
        `Database replacement committed, but the parent runtime is not healthy: ${detail}`,
        true,
        names.backupDb,
        true,
        names.backupDb,
      );
    }
  }

  private async restartParentRuntimeAndVerify(parentRef: string, parentDb: string): Promise<void> {
    await removeProjectDbCache(parentDb);
    const runtimeStatus = await tenantRuntimeService.restartRuntime(parentRef);
    if (runtimeStatus.status !== "running" || runtimeStatus.health !== "healthy") {
      throw new Error(`runtime status is ${runtimeStatus.status}/${runtimeStatus.health}`);
    }
  }

  private async recoverReplacementJournalEntry(entry: BranchReplacementJournalEntry): Promise<boolean> {
    const names: ReplacementDatabaseNames = {
      parentDb: entry.parent_db,
      branchDb: entry.branch_db,
      tempDb: entry.temp_db,
      backupDb: entry.backup_db,
    };
    const [parentExists, backupExists, tempExists] = await Promise.all([
      this.databaseExists(names.parentDb),
      this.databaseExists(names.backupDb),
      this.databaseExists(names.tempDb),
    ]);

    try {
      if (parentExists && backupExists && !tempExists) {
        await this.restartParentRuntimeAndVerify(entry.parent_ref, names.parentDb);
        await branchReplacementJournal.remove(entry.parent_ref);
        return true;
      }

      if (parentExists && !backupExists) {
        await this.setDatabaseConnectionsAllowed(names.parentDb, true);
        if (tempExists) await this.dropDatabaseIfExists(names.tempDb);
        await this.restartParentRuntimeAndVerify(entry.parent_ref, names.parentDb);
        await branchReplacementJournal.remove(entry.parent_ref);
        return true;
      }

      if (!parentExists && backupExists) {
        await this.renameDatabase(names.backupDb, names.parentDb);
        await this.setDatabaseConnectionsAllowed(names.parentDb, true);
        if (tempExists) await this.dropDatabaseIfExists(names.tempDb);
        await this.restartParentRuntimeAndVerify(entry.parent_ref, names.parentDb);
        await branchReplacementJournal.remove(entry.parent_ref);
        return true;
      }
    } catch (error: unknown) {
      logger.error(`[branch] failed to recover interrupted replacement for ${entry.parent_ref}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const recoveryDatabase = backupExists ? names.backupDb : parentExists ? names.parentDb : undefined;
    const replacementCommitted = entry.replacement_committed || (parentExists && backupExists && !tempExists);
    await this.markReplacementRecoveryRequiredBestEffort(
      entry.parent_ref,
      recoveryDatabase,
      replacementCommitted,
    );
    return false;
  }

  private async markReplacementRecoveryRequiredBestEffort(
    parentRef: string,
    recoveryDatabase?: string,
    replacementCommitted?: boolean,
  ): Promise<void> {
    try {
      await branchReplacementJournal.setPhase(
        parentRef,
        "recovery_required",
        recoveryDatabase,
        replacementCommitted,
      );
    } catch (error: unknown) {
      logger.error(`[branch] failed to persist recovery-required state for ${parentRef}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async clearReplacementJournalBestEffort(parentRef: string): Promise<void> {
    try {
      await branchReplacementJournal.remove(parentRef);
    } catch (error: unknown) {
      logger.warn(`[branch] failed to clear replacement journal for ${parentRef}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async renameDatabase(source: string, target: string): Promise<void> {
    await sql.unsafe(`ALTER DATABASE ${this.identQuote(source)} RENAME TO ${this.identQuote(target)}`);
  }

  private async dropDatabaseWithWarning(dbName: string, label: string): Promise<void> {
    try {
      await this.dropDatabaseIfExists(dbName);
    } catch (error: unknown) {
      logger.warn(`[branch] failed to drop ${label} ${dbName}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async applyRuntimeGrants(dbName: string, projectRef: string, password: string): Promise<void> {
    const dbUser = resolveRoleName(projectRef);
    const authenticatorRole = resolveAuthenticatorName(projectRef);
    const connection = this.adminPostgresConnection(dbName);
    const grantSql = `
      GRANT anon, authenticated, service_role TO ${this.identQuote(authenticatorRole)};
      GRANT CONNECT, TEMPORARY ON DATABASE ${this.identQuote(dbName)} TO ${this.identQuote(dbUser)};
      GRANT CONNECT, TEMPORARY ON DATABASE ${this.identQuote(dbName)} TO ${this.identQuote(authenticatorRole)};
      GRANT USAGE, CREATE ON SCHEMA public TO ${this.identQuote(dbUser)};
      GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO ${this.identQuote(dbUser)};
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${this.identQuote(dbUser)};
      GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO ${this.identQuote(dbUser)};
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT ALL ON SCHEMA public TO authenticated, service_role;
      GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
      GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
      GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO service_role;
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'auth') THEN
          EXECUTE 'GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, ${this.identQuote(dbUser)}';
          EXECUTE 'GRANT ALL ON SCHEMA auth TO supabase_auth_admin';
          EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin';
          EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth TO supabase_auth_admin';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'storage') THEN
          EXECUTE 'GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role, ${this.identQuote(dbUser)}';
          EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA storage TO service_role, ${this.identQuote(dbUser)}';
          EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA storage TO service_role, ${this.identQuote(dbUser)}';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'realtime') THEN
          EXECUTE 'GRANT USAGE ON SCHEMA realtime TO ${this.identQuote(dbUser)}';
          EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA realtime TO ${this.identQuote(dbUser)}';
          EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA realtime TO ${this.identQuote(dbUser)}';
        END IF;
      END
      $$;
    `;

    await this.runPsql(connection, grantSql, "apply runtime grants", [password]);
  }

  private async validateRestoredDatabase(dbName: string): Promise<void> {
    const connection = this.adminPostgresConnection(dbName);
    const validationSql = `
      DO $$
      DECLARE
        required_schema text;
      BEGIN
        FOREACH required_schema IN ARRAY ARRAY['public', 'auth', 'storage'] LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = required_schema) THEN
            RAISE EXCEPTION 'restored database % is missing required schema %', current_database(), required_schema;
          END IF;
        END LOOP;
      END
      $$;
    `;
    await this.runPsql(connection, validationSql, "validate restored database");
  }

  private adminPostgresConnection(database: string): ParsedPostgresConnection {
    const adminDbUrl = process.env.DATABASE_URL;
    if (!adminDbUrl) throw new Error("DATABASE_URL is not set");
    return { ...this.parsePostgresConnection(adminDbUrl), database };
  }

  private async runPsql(
    connection: ParsedPostgresConnection,
    sqlText: string,
    label: string,
    additionalSecrets: readonly string[] = [],
  ): Promise<void> {
    const diagnosticSecrets = [connection.password, ...additionalSecrets];
    diagnosticSecretPatterns(diagnosticSecrets);
    const processEnvironment = buildPostgresProcessEnvironment(connection);
    const child = Bun.spawn({
      cmd: [
        "psql",
        "--host", connection.hostname,
        "--port", connection.port,
        "--username", connection.username,
        "--dbname", connection.database,
        "--set", "ON_ERROR_STOP=on",
        "--quiet",
      ],
      env: processEnvironment,
      stdin: new Blob([sqlText], { type: "text/plain;charset=utf-8" }),
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      readRedactedBoundedText(child.stderr, diagnosticSecrets),
    ]);
    if (exitCode !== 0) {
      const diagnostic = stderr.trim() || "no stderr output";
      throw new Error(boundedUtf8Text(`${label} failed: psql exited with code ${exitCode}: ${diagnostic}`));
    }
  }

  private async terminateDatabaseConnections(dbName: string): Promise<void> {
    await sql`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = ${dbName}
        AND pid <> pg_backend_pid()
    `;
  }

  private async setDatabaseConnectionsAllowed(dbName: string, allowed: boolean): Promise<void> {
    await sql.unsafe(
      `ALTER DATABASE ${this.identQuote(dbName)} WITH ALLOW_CONNECTIONS ${allowed ? "true" : "false"}`,
    );
  }

  private async dropDatabaseIfExists(dbName: string): Promise<void> {
    await this.terminateDatabaseConnections(dbName);
    await sql.unsafe(`DROP DATABASE IF EXISTS ${this.identQuote(dbName)}`);
  }

  private derivedDbName(base: string, suffix: string): string {
    const maxLength = 63;
    const suffixWithSep = `_${suffix}`;
    const prefix = base.slice(0, maxLength - suffixWithSep.length);
    return `${prefix}${suffixWithSep}`;
  }

  private identQuote(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  private literalQuote(value: string): string {
    return value.replace(/'/g, "''");
  }
}

export const branchService = new BranchService();
