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
import { sql, removeProjectDbCache } from "../db";
import { databaseService } from "./database.service";
import { projectRepository } from "../repositories/project.repository";
import { generateDbName, resolveRoleName, resolveBucketName, resolveAuthenticatorName } from "../db";
import { tenantRuntimeService } from "./tenant-runtime.service";
import { logger } from "../utils/logger";
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

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
}

class BranchService {
  async createBranch(input: CreateBranchInput): Promise<void> {
    const { parentRef, branchRef, name } = input;
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
      },
    });
    if (!branchProject) throw new Error("Failed to create branch project record");

    // 2. Clone the parent database into a fresh, empty branch database.
    await this.createEmptyTenantDatabase(branchDbName, branchRef, dbPassword);
    await this.cloneDatabase(parentDbName, branchDbName);
    await this.applyRuntimeGrants(branchDbName, branchRef, dbPassword);

    // 3. Start tenant runtime (PostgREST + GoTrue) for the branch.
    await tenantRuntimeService.restartRuntime(branchRef);

    logger.info(`[branch] created ${branchRef} from ${parentRef}`);
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

  private async cloneDatabase(sourceDb: string, targetDb: string): Promise<void> {
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

  async promoteBranch(input: { parentRef: string; branchRef: string }): Promise<void> {
    const { parentRef, branchRef } = input;
    const parent = await projectRepository.findByRef(parentRef);
    if (!parent) throw new Error("Parent project not found");

    const parentDb = generateDbName(parentRef);
    const branchDb = generateDbName(branchRef);
    const suffix = Date.now().toString(36);
    const tempDb = this.derivedDbName(parentDb, `promote_${suffix}`);
    const backupDb = this.derivedDbName(parentDb, `backup_${suffix}`);

    await this.createEmptyTenantDatabase(tempDb, parentRef, parent.db_password);
    await this.cloneDatabase(branchDb, tempDb);
    await this.applyRuntimeGrants(tempDb, parentRef, parent.db_password);
    await this.validateRestoredDatabase(tempDb);

    let parentRenamed = false;
    let tempRenamed = false;
    try {
      // Stop parent runtime only after the replacement database has restored successfully.
      try {
        await tenantRuntimeService.stopRuntime(parentRef);
      } catch (err: unknown) {
        logger.warn(`[branch] failed to stop parent runtime before promote ${parentRef}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await removeProjectDbCache(parentDb);
      await this.terminateDatabaseConnections(parentDb);
      await this.terminateDatabaseConnections(tempDb);
      await sql.unsafe(`ALTER DATABASE ${this.identQuote(parentDb)} RENAME TO ${this.identQuote(backupDb)}`);
      parentRenamed = true;
      await sql.unsafe(`ALTER DATABASE ${this.identQuote(tempDb)} RENAME TO ${this.identQuote(parentDb)}`);
      tempRenamed = true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (parentRenamed && !tempRenamed) {
        try {
          await sql.unsafe(`ALTER DATABASE ${this.identQuote(backupDb)} RENAME TO ${this.identQuote(parentDb)}`);
        } catch (rollbackErr: unknown) {
          logger.error(`[branch] failed to roll back promote rename for ${parentRef}`, {
            error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          });
        }
      }
      await this.dropDatabaseIfExists(tempDb).catch((dropErr: unknown) => {
        logger.warn(`[branch] failed to drop promote temp DB ${tempDb}`, {
          error: dropErr instanceof Error ? dropErr.message : String(dropErr),
        });
      });
      throw new Error(`Promote failed before parent database switch completed: ${message}`);
    } finally {
      try {
        await removeProjectDbCache(parentDb);
        await tenantRuntimeService.restartRuntime(parentRef);
      } catch (err: unknown) {
        logger.warn(`[branch] failed to restart parent runtime after promote attempt ${parentRef}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info(`[branch] promoted ${branchRef} into ${parentRef}; previous parent kept as ${backupDb}`);
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
