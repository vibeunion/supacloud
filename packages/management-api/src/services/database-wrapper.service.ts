import { getProjectDb, resolveDbName } from "../db";

type WrapperKind = "stripe" | "mongodb";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

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
      SELECT f.fdwname AS name, s.srvname AS server,
             CASE WHEN f.fdwname = 'stripe_wrapper' THEN 'stripe'
                  WHEN f.fdwname = 'mongodb_wrapper' THEN 'mongodb'
                  ELSE 'custom' END AS type
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
    if (!input.credential || input.credential.length > 64 * 1024) throw new DatabaseWrapperError("credential is required and must not exceed 64 KiB");
    if (input.type === "mongodb" && !/^mongodb(?:\+srv)?:\/\//i.test(input.credential)) {
      throw new DatabaseWrapperError("MongoDB credential must be a mongodb:// or mongodb+srv:// connection string");
    }
    if (input.type === "stripe" && !/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+$/.test(input.credential)) {
      throw new DatabaseWrapperError("Stripe credential must be a secret or restricted API key");
    }
    const definition = wrapperDefinition(input.type);
    const serverName = normalizeWrapperResourceName(input.server_name || `${input.type}_server`, "server_name");
    const schemaName = normalizeWrapperResourceName(input.schema_name || definition.schema, "schema_name");
    const apiVersion = input.api_version?.trim();
    if (input.type === "stripe" && apiVersion && !/^\d{4}-\d{2}-\d{2}(?:\.[A-Za-z0-9_-]+)?$/.test(apiVersion)) {
      throw new DatabaseWrapperError("api_version is invalid");
    }
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
};
