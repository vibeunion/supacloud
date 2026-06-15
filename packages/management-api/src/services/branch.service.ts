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
import { $ } from "bun";

function pgDollarQuote(value: string): string {
  const tag = `pw${Bun.hash(value).toString(36).slice(0, 6)}${crypto.randomUUID().slice(0, 8)}`;
  return `$${tag}$${value}$${tag}$`;
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

    const [existing] = await sql`SELECT 1 FROM pg_database WHERE datname = ${dbName} LIMIT 1`;
    if (existing) {
      throw new Error(`Database ${dbName} already exists; refusing to restore into a non-empty target`);
    }

    await sql.unsafe(`
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
          CREATE ROLE ${this.identQuote(dbUser)} LOGIN CONNECTION LIMIT 20 PASSWORD ${pgDollarQuote(password)};
        ELSE
          ALTER ROLE ${this.identQuote(dbUser)} LOGIN CONNECTION LIMIT 20 PASSWORD ${pgDollarQuote(password)};
        END IF;
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${this.literalQuote(authenticatorRole)}') THEN
          CREATE ROLE ${this.identQuote(authenticatorRole)} CONNECTION LIMIT 30 NOINHERIT LOGIN PASSWORD ${pgDollarQuote(password)};
        ELSE
          ALTER ROLE ${this.identQuote(authenticatorRole)} CONNECTION LIMIT 30 NOINHERIT LOGIN PASSWORD ${pgDollarQuote(password)};
        END IF;
      END
      $$;
    `);

    await sql.unsafe(`CREATE DATABASE ${this.identQuote(dbName)} OWNER ${this.identQuote(dbUser)}`);
    await sql.unsafe(`
      GRANT CONNECT, TEMPORARY ON DATABASE ${this.identQuote(dbName)} TO ${this.identQuote(dbUser)};
      GRANT CONNECT, TEMPORARY ON DATABASE ${this.identQuote(dbName)} TO ${this.identQuote(authenticatorRole)};
      GRANT anon, authenticated, service_role TO ${this.identQuote(authenticatorRole)};
    `);
  }

  private async cloneDatabase(sourceDb: string, targetDb: string): Promise<void> {
    // The platform admin DB credentials are used for both sides of the dump/restore.
    const adminDbUrl = process.env.DATABASE_URL;
    if (!adminDbUrl) throw new Error("DATABASE_URL is not set; cannot clone branch database");

    // Build source and target connection strings by swapping the db name.
    const sourceUrl = this.swapDbName(adminDbUrl, sourceDb);
    const targetUrl = this.swapDbName(adminDbUrl, targetDb);

    // Pipe pg_dump | psql to copy schema + data.
    // --no-owner --no-privileges avoids role mismatch errors on restore.
    const dumpCmd = `pg_dump --no-owner --no-privileges --dbname=${this.shellQuote(sourceUrl)}`;
    const restoreCmd = `psql --dbname=${this.shellQuote(targetUrl)} --set ON_ERROR_STOP=on -q`;

    // Use a shell pipeline via Bun.$ so stdout of pg_dump feeds psql stdin.
    const result = await $`${{ raw: `${dumpCmd} | ${restoreCmd}` }}`.nothrow().quiet();
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString();
      throw new Error(`Database clone failed: ${stderr.slice(0, 500)}`);
    }
  }

  private swapDbName(url: string, newDb: string): string {
    try {
      const parsed = new URL(url);
      parsed.pathname = `/${newDb}`;
      return parsed.toString();
    } catch {
      // postgresql://user:pass@host:port/dbname?sslmode=...
      const slashIdx = url.lastIndexOf("/");
      if (slashIdx === -1) return url;
      const queryIdx = url.indexOf("?", slashIdx);
      const base = url.slice(0, slashIdx + 1);
      const query = queryIdx === -1 ? "" : url.slice(queryIdx);
      return `${base}${newDb}${query}`;
    }
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
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
    const adminDbUrl = process.env.DATABASE_URL;
    if (!adminDbUrl) throw new Error("DATABASE_URL is not set");

    const dbUser = resolveRoleName(projectRef);
    const authenticatorRole = resolveAuthenticatorName(projectRef);
    const dbUrl = this.swapDbName(adminDbUrl, dbName);
    const grantSql = `
      GRANT anon, authenticated, service_role TO ${this.identQuote(authenticatorRole)};
      ALTER ROLE ${this.identQuote(authenticatorRole)} LOGIN PASSWORD ${pgDollarQuote(password)};
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

    await this.runPsql(dbUrl, grantSql, "apply runtime grants");
  }

  private async validateRestoredDatabase(dbName: string): Promise<void> {
    const adminDbUrl = process.env.DATABASE_URL;
    if (!adminDbUrl) throw new Error("DATABASE_URL is not set");
    const dbUrl = this.swapDbName(adminDbUrl, dbName);
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
    await this.runPsql(dbUrl, validationSql, "validate restored database");
  }

  private async runPsql(dbUrl: string, sqlText: string, label: string): Promise<void> {
    const cmd = `psql --dbname=${this.shellQuote(dbUrl)} --set ON_ERROR_STOP=on -q --command=${this.shellQuote(sqlText)}`;
    const result = await $`${{ raw: cmd }}`.nothrow().quiet();
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString();
      throw new Error(`${label} failed: ${stderr.slice(0, 500)}`);
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
