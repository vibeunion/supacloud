import { ZenStackClient, type AuthType, type ClientOptions, type QueryOptions, type ModelOperations } from "@zenstackhq/orm";
import { PolicyPlugin } from "@zenstackhq/plugin-policy";
import type { SchemaDef, GetModels } from "@zenstackhq/schema";
import { CommandError, type CommandStore, type CommandRetentionStore } from "@supacloud/contracts";
import { BunPostgresDialect, type BunSqlPool } from "./bun-dialect";
import { createPostgresCommandStore, type CommandDatabase, type CommandTransaction, type CommandSubmissionBinding } from "./command-adapter";
import {
  type CallFunctionOptions,
  type CallFunctionPolicy,
  type CallFunctionVolatility,
  type JsonArgument,
  type ModelCommandTransaction as ModelCommandTransactionPort,
  type ReadFunctionArg,
  type ReadFunctionRow,
} from "./model-contract";
import { isSafeDefinerSearchPath } from "./search-path";

const reads = ["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"] as const;
const operations = [...reads, "create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"] as const;
const typing = { typing: { exactQueryArgs: true } } as const;
type Delegate<S extends SchemaDef, M extends GetModels<S>, K extends string> = Pick<ModelOperations<S, M, typeof typing>, Extract<K, keyof ModelOperations<S, M, typeof typing>>>;
export type ModelClient<S extends SchemaDef> = { readonly [M in GetModels<S> as Uncapitalize<M>]: Delegate<S, M, typeof operations[number]> };
export type ModelReadClient<S extends SchemaDef> = { readonly [M in GetModels<S> as Uncapitalize<M>]: Delegate<S, M, typeof reads[number]> };
/** Backend compatibility alias. New consumers should import the neutral port. */
export type ModelCommandTransaction<S extends SchemaDef> = ModelCommandTransactionPort<ModelClient<S>>;
export type ReadFunctionScalar = string | number | boolean | null;
export type { CallFunctionOptions, CallFunctionPolicy, CallFunctionVolatility, JsonArgument, ReadFunctionArg, ReadFunctionRow } from "./model-contract";

const functionName = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/;
const qualifiedObject = /^[A-Za-z_][A-Za-z0-9_]{0,62}\.[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const identifierName = /^[a-z_][a-z0-9_]{0,62}$/;
const objectName = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const systemSchemas = new Set(["pg_catalog", "information_schema", "pg_toast"]);
const sqlType = /^[A-Za-z0-9_$ .\"()\[\],]+$/;

function postgresArrayLiteral(values: readonly ReadFunctionScalar[]): string {
  return `{${values.map((value) => {
    if (value === null) return "NULL";
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }).join(",")}}`;
}

function isJsonArgument(value: unknown): value is JsonArgument {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonArgument);
  return typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
    && Object.values(value).every(isJsonArgument);
}

const volatilityCodes = { stable: "s", immutable: "i", volatile: "v" } as const;

/** Copy only operation closures. Never return the ORM delegate (it can retain its client). */
function facade<S extends SchemaDef>(schema: S, client: object, allowed: typeof reads, assertActive: () => void): ModelReadClient<S>;
function facade<S extends SchemaDef>(schema: S, client: object, allowed: typeof operations, assertActive: () => void): ModelClient<S>;
function facade(schema: SchemaDef, client: object, allowed: readonly string[], assertActive: () => void): object {
  return Object.freeze(Object.fromEntries(Object.keys(schema.models).map((name) => {
    const key = name[0]!.toLowerCase() + name.slice(1);
    const delegate: unknown = Reflect.get(client, key);
    if (!delegate || typeof delegate !== "object") throw new Error(`Missing model delegate: ${key}`);
    const methods = allowed.map(method => {
      const invoke: unknown = Reflect.get(delegate, method);
      if (typeof invoke !== "function") throw new Error(`Unsupported model operation: ${method}`);
      return [method, async (...args: unknown[]) => { assertActive(); return await Reflect.apply(invoke, delegate, args); }];
    });
    return [key, Object.freeze(Object.fromEntries(methods))];
  })));
}

/** Trusted composition root only. Options permit schema-required computed fields/procedures. */
export function createZenStackDatabase<S extends SchemaDef>(schema: S, pool: BunSqlPool, options: Omit<ClientOptions<S>, keyof QueryOptions<S> | "dialect" | "plugins" | "validateInput" | "skipValidationForComputedFields"> & { readonly callFunction?: CallFunctionPolicy }) {
  const { callFunction: callFunctionPolicy, ...clientOptions } = options;
  const policySchemas = callFunctionPolicy?.schemas === undefined
    ? new Set(["public"]) : new Set(callFunctionPolicy.schemas);
  const policyOwners = callFunctionPolicy?.owners === undefined
    ? undefined : new Set(callFunctionPolicy.owners);
  if (policySchemas.size === 0 || [...policySchemas].some((name) => !identifierName.test(name))) {
    throw new Error("callFunction schemas must be explicit non-system identifiers");
  }
  if (policyOwners && (policyOwners.size === 0 || [...policyOwners].some((name) => name.trim() === ""))) {
    throw new Error("callFunction owners must be explicit role names");
  }
  const reserved = ["dialect", "plugins", "typing", "omit", "allowQueryTimeOmitOverride", "slicing", "validateInput", "skipValidationForComputedFields"];
  if (Object.keys(clientOptions).some(key => reserved.includes(key))) throw new Error("Model facade validation and capabilities cannot be overridden");
  // Query typing/omission/slicing and validation switches are not configurable on this facade.
  // Only private CommandStore SQL can access raw methods. Public facades contain no client,
  // query builder, raw SQL, plugin controls, identity setter or nested transaction methods.
  const client = new ZenStackClient(schema, {
    ...clientOptions, ...typing, dialect: new BunPostgresDialect(pool),
    plugins: [new PolicyPlugin({ dangerouslyAllowRawSql: true })],
  } as unknown as ClientOptions<S>);
  let disposed = false;
  const assertOpen = () => { if (disposed) throw new Error("Database is disposed"); };
  return Object.freeze({
    forIdentity(identity: AuthType<S>, submission?: CommandSubmissionBinding) {
      assertOpen();
      if (identity === null || identity === undefined) throw new Error("Verified database identity is required");
      const scoped = client.$setAuth(structuredClone(identity));
      type InternalTransaction = CommandTransaction & ModelCommandTransaction<S>;
      const database: CommandDatabase<InternalTransaction> = {
        transaction: (work) => {
          assertOpen();
          return scoped.$transaction(async (tx) => {
            let active = true;
            const assertActive = () => { assertOpen(); if (!active) throw new Error("Command transaction is closed"); };
            const inspectFunction = async (name: string, argCount: number) => {
              if (typeof name !== "string" || !functionName.test(name)) throw new CommandError("COMMAND_INPUT_INVALID");
              const [schemaName, procName] = name.split(".") as [string, string];
              if (systemSchemas.has(schemaName) || schemaName.startsWith("pg_")) throw new CommandError("COMMAND_INPUT_INVALID");
              if (!Number.isSafeInteger(argCount) || argCount < 0 || argCount > 16) throw new CommandError("COMMAND_INPUT_INVALID");
              // Re-read the definition on every call: CREATE OR REPLACE can change
              // volatility, ownership or SECURITY DEFINER between commands.
              const resolved = (await tx.$queryRawUnsafe<unknown>(
                `SELECT p.prokind::text AS kind, p.provolatile::text AS volatility, p.proretset AS returns_set,
                        p.prosecdef AS security_definer, pg_get_userbyid(p.proowner) AS owner,
                        has_function_privilege(current_user, p.oid, 'EXECUTE') AS can_execute,
                        COALESCE(p.proconfig, ARRAY[]::text[]) AS config,
                        COALESCE((SELECT array_agg(format_type(u.type_oid, NULL)::text ORDER BY u.ordinality)
                          FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS u(type_oid, ordinality)
                          WHERE u.ordinality IS NOT NULL), ARRAY[]::text[]) AS arg_types,
                        COALESCE((SELECT array_agg(u.type_oid::text ORDER BY u.ordinality)
                          FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS u(type_oid, ordinality)
                          WHERE u.ordinality IS NOT NULL), ARRAY[]::text[]) AS arg_type_oids,
                        COALESCE((SELECT array_agg((t.typelem <> 0) ORDER BY u.ordinality)
                          FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS u(type_oid, ordinality)
                          JOIN pg_catalog.pg_type t ON t.oid = u.type_oid
                          WHERE u.ordinality IS NOT NULL), ARRAY[]::boolean[]) AS arg_arrays,
                        COALESCE((SELECT array_agg(COALESCE(et.typtype::text, '') ORDER BY u.ordinality)
                          FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS u(type_oid, ordinality)
                          JOIN pg_catalog.pg_type t ON t.oid = u.type_oid
                          LEFT JOIN pg_catalog.pg_type et ON et.oid = t.typelem
                          WHERE u.ordinality IS NOT NULL), ARRAY[]::text[]) AS arg_element_kinds
                   FROM pg_catalog.pg_proc p
                   JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = $1 AND p.proname = $2 AND p.pronargs = $3`,
                schemaName, procName, argCount,
              )) as readonly Record<string, unknown>[];
              if (!Array.isArray(resolved) || resolved.length !== 1) throw new CommandError("COMMAND_INPUT_INVALID");
              const signature = resolved[0];
              if (signature === undefined || signature["kind"] !== "f") throw new CommandError("COMMAND_INPUT_INVALID");
              const argTypes = signature["arg_types"];
              const argTypeOids = signature["arg_type_oids"];
              const argArrays = signature["arg_arrays"];
              const argElementKinds = signature["arg_element_kinds"];
              if (!Array.isArray(argTypes) || !Array.isArray(argTypeOids) || !Array.isArray(argArrays) || !Array.isArray(argElementKinds)
                || argTypes.length !== argCount || argTypeOids.length !== argCount
                || argArrays.length !== argCount || argElementKinds.length !== argCount) {
                throw new CommandError("COMMAND_INPUT_INVALID");
              }
              return { schemaName, procName, signature, argTypes, argTypeOids, argArrays, argElementKinds };
            };
            try {
              return await work({
                db: facade<S>(schema, tx, operations, assertActive),
                query: async (text, parameters = []) => {
                  assertActive();
                  return await tx.$queryRawUnsafe<unknown>(text, ...parameters);
                },
                readFunction: async (name, args = []) => {
                  if (!Array.isArray(args) || args.length > 16) throw new CommandError("COMMAND_INPUT_INVALID");
                  for (const arg of args) {
                    const values = Array.isArray(arg) ? arg : [arg];
                    if (Array.isArray(arg) && values.some(value => Array.isArray(value))) throw new CommandError("COMMAND_INPUT_INVALID");
                    for (const value of values) {
                      if (value === null || typeof value === "string" || typeof value === "boolean") continue;
                      if (typeof value === "number" && Number.isFinite(value)) continue;
                      throw new CommandError("COMMAND_INPUT_INVALID");
                    }
                  }
                  const { schemaName, procName, signature, argTypes, argArrays, argElementKinds } = await inspectFunction(name, args.length);
                  const volatility = signature["volatility"];
                  if (volatility !== "s" && volatility !== "i") throw new CommandError("COMMAND_INPUT_INVALID");
                  if (signature["returns_set"] === true) throw new CommandError("COMMAND_INPUT_INVALID");
                  const placeholders = args.map((arg, index) => {
                    const type = argTypes[index];
                    const expectsArray = argArrays[index] === true;
                    const elementKind = argElementKinds[index];
                    if (typeof type !== "string" || !sqlType.test(type)
                      || Array.isArray(arg) !== expectsArray
                      || (expectsArray && !["b", "d", "e"].includes(elementKind as string))) throw new CommandError("COMMAND_INPUT_INVALID");
                    return `$${index + 1}::${type}`;
                  }).join(", ");
                  const boundArgs = args.map(arg => Array.isArray(arg) ? postgresArrayLiteral(arg) : arg);
                  const rows = (await tx.$queryRawUnsafe<unknown>(
                    `SELECT "${schemaName}"."${procName}"(${placeholders}) AS result`,
                    ...boundArgs,
                  )) as readonly Record<string, unknown>[];
                  const row = Array.isArray(rows) ? rows[0] : undefined;
                  assertActive();
                  return row === undefined ? undefined : row["result"];
                },
                readFunctionByRow: async (name, row) => {
                  if (row === null || typeof row !== "object" || Array.isArray(row)) throw new CommandError("COMMAND_INPUT_INVALID");
                  const { table, key, value } = row;
                  if (typeof table !== "string" || !qualifiedObject.test(table)) throw new CommandError("COMMAND_INPUT_INVALID");
                  if (typeof key !== "string" || !objectName.test(key)) throw new CommandError("COMMAND_INPUT_INVALID");
                  if (value !== null && typeof value !== "string" && typeof value !== "boolean"
                    && !(typeof value === "number" && Number.isFinite(value))) throw new CommandError("COMMAND_INPUT_INVALID");
                  const [tableSchema, tableName] = table.split(".") as [string, string];
                  if (systemSchemas.has(tableSchema) || tableSchema.startsWith("pg_")) throw new CommandError("COMMAND_INPUT_INVALID");
                  const { schemaName, procName, signature, argTypes, argTypeOids } = await inspectFunction(name, 1);
                  const volatility = signature["volatility"];
                  if (volatility !== "s" && volatility !== "i") throw new CommandError("COMMAND_INPUT_INVALID");
                  if (signature["returns_set"] === true) throw new CommandError("COMMAND_INPUT_INVALID");
                  const tableInfo = (await tx.$queryRawUnsafe<unknown>(
                    `SELECT c.relkind::text AS kind, c.reltype::text AS row_type_oid,
                            format_type(a.atttypid, NULL)::text AS key_type,
                            (SELECT count(*) FROM pg_catalog.pg_index i
                              JOIN pg_catalog.pg_attribute ia ON ia.attrelid = i.indrelid AND ia.attnum = ANY(i.indkey)
                             WHERE i.indrelid = c.oid AND i.indisprimary) AS primary_columns,
                            EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                              JOIN pg_catalog.pg_attribute ia ON ia.attrelid = i.indrelid AND ia.attnum = ANY(i.indkey)
                             WHERE i.indrelid = c.oid AND i.indisprimary AND ia.attname = $3) AS key_is_primary
                       FROM pg_catalog.pg_class c
                       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = $3 AND a.attnum > 0 AND NOT a.attisdropped
                      WHERE n.nspname = $1 AND c.relname = $2`,
                    tableSchema, tableName, key,
                  )) as readonly Record<string, unknown>[];
                  if (!Array.isArray(tableInfo) || tableInfo.length !== 1) throw new CommandError("COMMAND_INPUT_INVALID");
                  const tableRow = tableInfo[0];
                  if (tableRow === undefined || (tableRow["kind"] !== "r" && tableRow["kind"] !== "p")
                    || tableRow["key_is_primary"] !== true || Number(tableRow["primary_columns"]) !== 1
                    || tableRow["row_type_oid"] !== argTypeOids[0] || argTypes.length !== 1
                    || typeof tableRow["key_type"] !== "string" || !sqlType.test(tableRow["key_type"])) {
                    throw new CommandError("COMMAND_INPUT_INVALID");
                  }
                  const rows = (await tx.$queryRawUnsafe<unknown>(
                    `SELECT "${schemaName}"."${procName}"(t) AS result
                       FROM "${tableSchema}"."${tableName}" AS t
                      WHERE t."${key}" = $1::${tableRow["key_type"]}
                      LIMIT 2`,
                    value,
                  )) as readonly Record<string, unknown>[];
                  if (!Array.isArray(rows) || rows.length !== 1) throw new CommandError("COMMAND_INPUT_INVALID");
                  const result = rows[0];
                  assertActive();
                  return result === undefined ? undefined : result["result"];
                },
                callFunction: async (name, args = [], options = {}) => {
                  if (!Array.isArray(args) || args.length > 16) throw new CommandError("COMMAND_INPUT_INVALID");
                  if (!args.every(isJsonArgument)) throw new CommandError("COMMAND_INPUT_INVALID");
                  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new CommandError("COMMAND_INPUT_INVALID");
                  const requestedVolatility = options.volatility;
                  if (requestedVolatility !== undefined && !(requestedVolatility in volatilityCodes)) {
                    throw new CommandError("COMMAND_INPUT_INVALID");
                  }
                  const { schemaName, procName, signature, argTypes, argArrays } = await inspectFunction(name, args.length);
                  if (!policySchemas.has(schemaName)) throw new CommandError("COMMAND_INPUT_INVALID");
                  const volatility = signature["volatility"];
                  if (volatility !== "s" && volatility !== "i" && volatility !== "v") throw new CommandError("COMMAND_INPUT_INVALID");
                  if (requestedVolatility !== undefined && volatilityCodes[requestedVolatility] !== volatility) {
                    throw new CommandError("COMMAND_INPUT_INVALID");
                  }
                  if (signature["security_definer"] !== true || signature["can_execute"] !== true) {
                    throw new CommandError("COMMAND_INPUT_INVALID");
                  }
                  const owner = signature["owner"];
                  if (typeof owner !== "string" || owner === "") throw new CommandError("COMMAND_INPUT_INVALID");
                  if (policyOwners) {
                    if (!policyOwners.has(owner)) throw new CommandError("COMMAND_INPUT_INVALID");
                  } else {
                    const current = (await tx.$queryRawUnsafe<unknown>("SELECT current_user::text AS name")) as readonly Record<string, unknown>[];
                    if (!Array.isArray(current) || current.length !== 1 || current[0]?.["name"] !== owner) {
                      throw new CommandError("COMMAND_INPUT_INVALID");
                    }
                  }
                  const config = signature["config"];
                  if (!isSafeDefinerSearchPath(config)) throw new CommandError("COMMAND_INPUT_INVALID");
                  const placeholders = args.map((arg, index) => {
                    const type = argTypes[index];
                    if (typeof type !== "string" || !sqlType.test(type) || argArrays[index] === true) {
                      throw new CommandError("COMMAND_INPUT_INVALID");
                    }
                    const jsonType = type === "json" || type === "jsonb";
                    if ((Array.isArray(arg) || (arg !== null && typeof arg === "object")) && !jsonType) {
                      throw new CommandError("COMMAND_INPUT_INVALID");
                    }
                    return `$${index + 1}::${type}`;
                  }).join(", ");
                  // JSON values stay as structured parameters: the driver owns
                  // JSON encoding, and pre-stringifying would store a JSON string.
                  const rows = (await tx.$queryRawUnsafe<unknown>(
                    `SELECT * FROM "${schemaName}"."${procName}"(${placeholders}) LIMIT 2`,
                    ...args,
                  )) as readonly Record<string, unknown>[];
                  if (!Array.isArray(rows) || rows.length !== 1) throw new CommandError("COMMAND_INPUT_INVALID");
                  const result = rows[0];
                  assertActive();
                  if (result === undefined) return undefined;
                  const keys = Object.keys(result);
                  return keys.length === 1 ? result[keys[0]!] : result;
                },
                lock: async (keys) => {
                  // Validate before touching the connection: a bad key set must
                  // fail the command, never silently serialize on a shared hash.
                  if (!Array.isArray(keys) || keys.length === 0) throw new CommandError("COMMAND_INPUT_INVALID");
                  if (keys.length > 16) throw new CommandError("COMMAND_INPUT_INVALID");
                  const unique = [...new Set(keys.map((key) => {
                    if (typeof key !== "string" || key.trim() === "") throw new CommandError("COMMAND_INPUT_INVALID");
                    if (key.length > 200) throw new CommandError("COMMAND_INPUT_INVALID");
                    return key;
                  }))].sort();
                  assertActive();
                  for (const key of unique) await tx.$queryRawUnsafe<unknown>("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", key);
                  assertActive();
                },
              });
            } finally { active = false; }
          });
        },
      };
      const internal = createPostgresCommandStore(database, submission ? { submission } : {});
      const commandStore: CommandStore<ModelCommandTransaction<S>> & CommandRetentionStore = {
        transaction: run => internal.transaction(session => run({
          ...session, transaction: Object.freeze({
            db: session.transaction.db, lock: session.transaction.lock,
            readFunction: session.transaction.readFunction,
            readFunctionByRow: session.transaction.readFunctionByRow,
            callFunction: session.transaction.callFunction,
          }),
        })),
        redactCompleted: scope => internal.redactCompleted(scope),
      };
      const models: ModelReadClient<S> = facade<S>(schema, scoped, reads, assertOpen);
      return Object.freeze({ models, commandStore: Object.freeze(commandStore) });
    },
    // The caller owns pool.close().
    async dispose() { disposed = true; await client.$disconnect(); },
  });
}
