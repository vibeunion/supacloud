import { getProjectDb, resolveDbName } from "../db";

export type WrapperKind = "stripe" | "mongodb";
export type WrapperCredentialInput = {
  type: WrapperKind;
  server_name: string;
  credential: string;
  api_version?: string;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SECRET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class DatabaseWrapperError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = "wrapper_error") {
    super(message);
    this.name = "DatabaseWrapperError";
  }
}

export function normalizeWrapperResourceName(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new DatabaseWrapperError(`${field} must be a PostgreSQL identifier`);
  }
  return value;
}

export function wrapperDefinition(kind: WrapperKind) {
  if (kind === "stripe") {
    return { fdw: "stripe_wrapper", handler: "stripe_fdw_handler", validator: "stripe_fdw_validator", schema: "stripe", importSchema: "stripe" } as const;
  }
  return { fdw: "mongodb_wrapper", handler: "mongodb_fdw_handler", validator: "mongodb_fdw_validator", schema: "mongo", importSchema: null } as const;
}

function quoteIdentifier(value: string): string {
  return `"${normalizeWrapperResourceName(value, "identifier")}"`;
}

function validateCredential(input: Pick<WrapperCredentialInput, "type" | "credential">): void {
  if (!input.credential || input.credential.length > 64 * 1024) {
    throw new DatabaseWrapperError("credential is required and must not exceed 64 KiB");
  }
  if (input.type === "mongodb" && !/^mongodb(?:\+srv)?:\/\//i.test(input.credential)) {
    throw new DatabaseWrapperError("MongoDB credential must be a mongodb:// or mongodb+srv:// connection string");
  }
  if (input.type === "stripe" && !/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+$/.test(input.credential)) {
    throw new DatabaseWrapperError("Stripe credential must be a secret or restricted API key");
  }
}

function validateApiVersion(type: WrapperKind, value: string | undefined): string | undefined {
  const apiVersion = value?.trim();
  if (type === "stripe" && apiVersion && !/^\d{4}-\d{2}-\d{2}(?:\.[A-Za-z0-9_-]+)?$/.test(apiVersion)) {
    throw new DatabaseWrapperError("api_version is invalid");
  }
  return apiVersion;
}

function secretIdFromOptions(options: unknown, key: "api_key_id" | "conn_string_id"): string {
  const values = Array.isArray(options) ? options.filter((value): value is string => typeof value === "string") : [];
  const prefix = `${key}=`;
  const value = values.find(option => option.startsWith(prefix))?.slice(prefix.length);
  if (!value || !SECRET_ID.test(value)) {
    throw new DatabaseWrapperError(`Foreign server is missing a valid Vault ${key} reference`, 409, "wrapper_secret_reference_missing");
  }
  return value;
}

async function ensureWrapperBase(ref: string) {
  const database = getProjectDb(await resolveDbName(ref));
  try {
    await database.unsafe("CREATE EXTENSION IF NOT EXISTS wrappers WITH SCHEMA extensions");
    await database.unsafe("CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE");
    const [vaultFunction] = await database`
      SELECT to_regprocedure('vault.create_secret(text,text,text)') AS function_name
    `;
    if (!vaultFunction?.function_name) throw new Error("vault.create_secret is unavailable");
  } catch (error: unknown) {
    throw new DatabaseWrapperError(
      `Wrappers require pgsodium and Supabase Vault to be initialized: ${error instanceof Error ? error.message : String(error)}`,
      501,
      "wrapper_vault_unavailable",
    );
  }
  return database;
}

export const databaseWrapperService = {
  async list(ref: string) {
    const database = getProjectDb(await resolveDbName(ref));
    const rows = await database`
      SELECT f.fdwname AS name, s.srvname AS server, s.srvname AS server_name,
             (SELECT min(ns.nspname)
                FROM pg_foreign_table ft
                JOIN pg_class c ON c.oid = ft.ftrelid
                JOIN pg_namespace ns ON ns.oid = c.relnamespace
               WHERE ft.ftserver = s.oid) AS schema_name,
             CASE WHEN f.fdwname = 'stripe_wrapper' THEN 'stripe'
                  WHEN f.fdwname = 'mongodb_wrapper' THEN 'mongodb'
                  ELSE 'custom' END AS type,
             CASE WHEN s.srvname IS NULL THEN 'unconfigured' ELSE 'configured' END AS status,
             'vault' AS credential_source,
             'platform-egress-policy-required' AS egress_status
      FROM pg_foreign_data_wrapper f
      LEFT JOIN pg_foreign_server s ON s.srvfdw = f.oid
      ORDER BY f.fdwname, s.srvname
    `;
    return { items: rows, total: rows.length };
  },

  async create(ref: string, input: {
    type: WrapperKind;
    server_name?: string;
    schema_name?: string;
    credential: string;
    api_version?: string;
  }) {
    if (input.type !== "stripe" && input.type !== "mongodb") throw new DatabaseWrapperError("type must be stripe or mongodb");
    validateCredential(input);
    const definition = wrapperDefinition(input.type);
    const serverName = normalizeWrapperResourceName(input.server_name || `${input.type}_server`, "server_name");
    const schemaName = normalizeWrapperResourceName(input.schema_name || definition.schema, "schema_name");
    const apiVersion = validateApiVersion(input.type, input.api_version);
    const database = await ensureWrapperBase(ref);

    return database.begin(async (transaction) => {
      const tx = transaction as typeof database;
      const [existingServer] = await tx`SELECT 1 FROM pg_foreign_server WHERE srvname = ${serverName}`;
      if (existingServer) throw new DatabaseWrapperError(`Foreign server '${serverName}' already exists`, 409, "wrapper_server_conflict");
      const [secret] = await tx`
        SELECT vault.create_secret(
          ${input.credential},
          ${`wrapper_${input.type}_${serverName}`},
          ${`${input.type} credential managed by SupaCloud Wrappers`}
        )::text AS id
      `;
      const secretId = String(secret.id);
      const [fdw] = await tx`SELECT 1 FROM pg_foreign_data_wrapper WHERE fdwname = ${definition.fdw}`;
      if (!fdw) {
        await tx.unsafe(
          `CREATE FOREIGN DATA WRAPPER ${quoteIdentifier(definition.fdw)} HANDLER extensions.${quoteIdentifier(definition.handler)} VALIDATOR extensions.${quoteIdentifier(definition.validator)}`,
        );
      }
      await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`);
      if (input.type === "stripe") {
        const apiVersionOption = apiVersion ? `, api_version '${apiVersion}'` : "";
        await tx.unsafe(
          `CREATE SERVER ${quoteIdentifier(serverName)} FOREIGN DATA WRAPPER ${quoteIdentifier(definition.fdw)} OPTIONS (api_key_id '${secretId}'${apiVersionOption})`,
        );
        await tx.unsafe(
          `IMPORT FOREIGN SCHEMA ${quoteIdentifier(definition.importSchema!)} FROM SERVER ${quoteIdentifier(serverName)} INTO ${quoteIdentifier(schemaName)}`,
        );
      } else {
        await tx.unsafe(
          `CREATE SERVER ${quoteIdentifier(serverName)} FOREIGN DATA WRAPPER ${quoteIdentifier(definition.fdw)} OPTIONS (conn_string_id '${secretId}')`,
        );
      }
      return { type: input.type, server_name: serverName, schema_name: schemaName, credential: "********", imported: input.type === "stripe" };
    });
  },

  async rotate(ref: string, input: WrapperCredentialInput) {
    validateCredential(input);
    const apiVersion = validateApiVersion(input.type, input.api_version);
    const definition = wrapperDefinition(input.type);
    const serverName = normalizeWrapperResourceName(input.server_name, "server_name");
    const database = await ensureWrapperBase(ref);
    try {
      return await database.begin(async (transaction) => {
        const tx = transaction as typeof database;
        const [server] = await tx`
          SELECT s.srvname, f.fdwname, s.srvoptions,
                 (SELECT min(ns.nspname)
                    FROM pg_foreign_table ft
                    JOIN pg_class c ON c.oid = ft.ftrelid
                    JOIN pg_namespace ns ON ns.oid = c.relnamespace
                   WHERE ft.ftserver = s.oid) AS schema_name
          FROM pg_foreign_server s
          JOIN pg_foreign_data_wrapper f ON f.oid = s.srvfdw
          WHERE s.srvname = ${serverName}
        `;
        if (!server) throw new DatabaseWrapperError(`Foreign server '${serverName}' was not found`, 404, "wrapper_server_not_found");
        if (server.fdwname !== definition.fdw) throw new DatabaseWrapperError(`Foreign server '${serverName}' is not a ${input.type} wrapper`, 409, "wrapper_type_conflict");
        const secretId = secretIdFromOptions(server.srvoptions, input.type === "stripe" ? "api_key_id" : "conn_string_id");
        const [updateFunction] = await tx`SELECT to_regprocedure('vault.update_secret(uuid,text,text,text,uuid)') AS function_name`;
        if (!updateFunction?.function_name) throw new DatabaseWrapperError("Vault secret rotation is unavailable", 501, "wrapper_vault_rotation_unavailable");
        await tx`SELECT vault.update_secret(${secretId}::uuid, ${input.credential}, NULL, NULL, NULL)`;
        if (input.type === "stripe" && apiVersion) {
          const escaped = apiVersion.replaceAll("'", "''");
          await tx.unsafe(`ALTER SERVER ${quoteIdentifier(serverName)} OPTIONS (SET api_version '${escaped}')`);
        }
        return { type: input.type, server_name: serverName, schema_name: server.schema_name ?? null, credential: "********", rotated: true };
      });
    } catch (error) {
      if (error instanceof DatabaseWrapperError) throw error;
      throw new DatabaseWrapperError(`Wrapper credential rotation failed: ${error instanceof Error ? error.message : String(error)}`, 409, "wrapper_rotation_failed");
    }
  },

  async remove(ref: string, input: Pick<WrapperCredentialInput, "type" | "server_name">) {
    const definition = wrapperDefinition(input.type);
    const serverName = normalizeWrapperResourceName(input.server_name, "server_name");
    const database = await ensureWrapperBase(ref);
    try {
      return await database.begin(async (transaction) => {
        const tx = transaction as typeof database;
        const [server] = await tx`
          SELECT s.srvname, f.fdwname, s.srvoptions,
                 (SELECT min(ns.nspname)
                    FROM pg_foreign_table ft
                    JOIN pg_class c ON c.oid = ft.ftrelid
                    JOIN pg_namespace ns ON ns.oid = c.relnamespace
                   WHERE ft.ftserver = s.oid) AS schema_name
          FROM pg_foreign_server s
          JOIN pg_foreign_data_wrapper f ON f.oid = s.srvfdw
          WHERE s.srvname = ${serverName}
        `;
        if (!server) throw new DatabaseWrapperError(`Foreign server '${serverName}' was not found`, 404, "wrapper_server_not_found");
        if (server.fdwname !== definition.fdw) throw new DatabaseWrapperError(`Foreign server '${serverName}' is not a ${input.type} wrapper`, 409, "wrapper_type_conflict");
        const secretId = secretIdFromOptions(server.srvoptions, input.type === "stripe" ? "api_key_id" : "conn_string_id");
        const [deleteFunction] = await tx`SELECT to_regprocedure('vault.delete_secret(uuid)') AS function_name`;
        if (!deleteFunction?.function_name) throw new DatabaseWrapperError("Vault secret deletion is unavailable; wrapper was not changed", 501, "wrapper_vault_deletion_unavailable");
        await tx.unsafe(`DROP SERVER ${quoteIdentifier(serverName)} RESTRICT`);
        await tx`SELECT vault.delete_secret(${secretId}::uuid)`;
        return { type: input.type, server_name: serverName, schema_name: server.schema_name ?? null, removed: true };
      });
    } catch (error) {
      if (error instanceof DatabaseWrapperError) throw error;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "2BP01") {
        throw new DatabaseWrapperError("Wrapper server is still referenced by foreign tables; remove those tables explicitly before deleting the server", 409, "wrapper_server_in_use");
      }
      throw new DatabaseWrapperError(`Wrapper removal failed: ${error instanceof Error ? error.message : String(error)}`, 409, "wrapper_removal_failed");
    }
  },
};
