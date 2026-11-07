import { ZenStackClient, type AuthType, type ClientOptions, type QueryOptions, type ModelOperations } from "@zenstackhq/orm";
import { PolicyPlugin } from "@zenstackhq/plugin-policy";
import type { SchemaDef, GetModels } from "@zenstackhq/schema";
import { CommandError, type CommandStore, type CommandRetentionStore } from "@supacloud/contracts";
import { BunPostgresDialect, type BunSqlPool } from "./bun-dialect";
import { createPostgresCommandStore, type CommandDatabase, type CommandTransaction, type CommandSubmissionBinding } from "./command-adapter";

const reads = ["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"] as const;
const operations = [...reads, "create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"] as const;
const typing = { typing: { exactQueryArgs: true } } as const;
type Delegate<S extends SchemaDef, M extends GetModels<S>, K extends string> = Pick<ModelOperations<S, M, typeof typing>, Extract<K, keyof ModelOperations<S, M, typeof typing>>>;
export type ModelClient<S extends SchemaDef> = { readonly [M in GetModels<S> as Uncapitalize<M>]: Delegate<S, M, typeof operations[number]> };
export type ModelReadClient<S extends SchemaDef> = { readonly [M in GetModels<S> as Uncapitalize<M>]: Delegate<S, M, typeof reads[number]> };
export type ReadFunctionScalar = string | number | boolean | null;
export type ReadFunctionArg = ReadFunctionScalar | readonly ReadFunctionScalar[];
export interface ModelCommandTransaction<S extends SchemaDef> {
  readonly db: ModelClient<S>;
  /**
   * Serialize competing writes inside the command transaction.
   *
   * Keys are folded into 64-bit advisory locks (`pg_advisory_xact_lock`) on the
   * command connection, so they are released when the transaction commits or
   * rolls back and never leak to another command. Keys are deduplicated and
   * acquired in sorted order, therefore two commands that take the same key set
   * in a different order cannot deadlock each other.
   *
   * Use it when a decision depends on an aggregate that another transaction may
   * insert into concurrently (write skew): read-then-check-then-write is only
   * safe when every writer of the same key set holds the lock.
   */
  readonly lock: (keys: readonly string[]) => Promise<void>;
  /**
   * Call an existing schema-qualified read-only database function inside the
   * command transaction.
   *
   * Models cover data. Some decisions also need a definition that already lives
   * in SQL and must not be duplicated in TypeScript — an authorization
   * predicate, a DTO projection, a status derivation with joins the model layer
   * would have to re-derive. Reimplementing those in application code creates a
   * second source of truth that silently drifts, so the platform offers a
   * narrow bridge instead of raw SQL.
   *
   * The name must be schema-qualified and `pg_proc`-verified on every call:
   * the function exists, is not an aggregate/window/procedure, and is
   * `STABLE` or `IMMUTABLE`. A `VOLATILE` function may write or run DDL and is
   * rejected. System schemas (`pg_*`, `information_schema`) are rejected too.
   * Arguments are only positional scalars, bound as parameters.
   *
   * The call runs on the command connection, so it observes uncommitted writes
   * of the same transaction and participates in its snapshot.
   */
  readonly readFunction: (name: string, args?: readonly ReadFunctionArg[]) => Promise<unknown>;
}

const functionName = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/;
const systemSchemas = new Set(["pg_catalog", "information_schema", "pg_toast"]);

function postgresArrayLiteral(values: readonly ReadFunctionScalar[]): string {
  return `{${values.map((value) => {
    if (value === null) return "NULL";
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }).join(",")}}`;
}

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
export function createZenStackDatabase<S extends SchemaDef>(schema: S, pool: BunSqlPool, options: Omit<ClientOptions<S>, keyof QueryOptions<S> | "dialect" | "plugins" | "validateInput" | "skipValidationForComputedFields">) {
  const reserved = ["dialect", "plugins", "typing", "omit", "allowQueryTimeOmitOverride", "slicing", "validateInput", "skipValidationForComputedFields"];
  if (Object.keys(options).some(key => reserved.includes(key))) throw new Error("Model facade validation and capabilities cannot be overridden");
  // Query typing/omission/slicing and validation switches are not configurable on this facade.
  // Only private CommandStore SQL can access raw methods. Public facades contain no client,
  // query builder, raw SQL, plugin controls, identity setter or nested transaction methods.
  const client = new ZenStackClient(schema, {
    ...options, ...typing, dialect: new BunPostgresDialect(pool),
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
            try {
              return await work({
                db: facade<S>(schema, tx, operations, assertActive),
                query: async (text, parameters = []) => {
                  assertActive();
                  return await tx.$queryRawUnsafe<unknown>(text, ...parameters);
                },
                readFunction: async (name, args = []) => {
                  if (typeof name !== "string" || !functionName.test(name)) {
                    throw new CommandError("COMMAND_INPUT_INVALID");
                  }
                  const [schemaName, procName] = name.split(".") as [string, string];
                  if (systemSchemas.has(schemaName) || schemaName.startsWith("pg_")) throw new CommandError("COMMAND_INPUT_INVALID");
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
                  assertActive();
                  // Volatility is re-checked on every call: CREATE OR REPLACE can turn a
                  // reviewable STABLE helper into a writing VOLATILE one, and a cached
                  // verdict would keep trusting the old definition.
                  const resolved = (await tx.$queryRawUnsafe<unknown>(
                    `SELECT prokind::text AS kind, provolatile::text AS volatility, proretset AS returns_set,
                            COALESCE(array_agg(format_type(u.type_oid, NULL)::text ORDER BY u.ordinality)
                              FILTER (WHERE u.ordinality IS NOT NULL), ARRAY[]::text[]) AS arg_types,
                            COALESCE(array_agg((t.typelem <> 0) ORDER BY u.ordinality)
                              FILTER (WHERE u.ordinality IS NOT NULL), ARRAY[]::boolean[]) AS arg_arrays,
                            COALESCE(array_agg(COALESCE(et.typtype::text, '') ORDER BY u.ordinality)
                              FILTER (WHERE u.ordinality IS NOT NULL), ARRAY[]::text[]) AS arg_element_kinds
                       FROM pg_catalog.pg_proc p
                       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                       LEFT JOIN LATERAL unnest(p.proargtypes::oid[]) WITH ORDINALITY AS u(type_oid, ordinality) ON TRUE
                       LEFT JOIN pg_catalog.pg_type t ON t.oid = u.type_oid
                       LEFT JOIN pg_catalog.pg_type et ON et.oid = t.typelem
                      WHERE n.nspname = $1 AND p.proname = $2 AND p.pronargs = $3
                      GROUP BY p.prokind, p.provolatile, p.proretset`,
                    schemaName, procName, args.length,
                  )) as readonly Record<string, unknown>[];
                  if (!Array.isArray(resolved) || resolved.length !== 1) throw new CommandError("COMMAND_INPUT_INVALID");
                  const signature = resolved[0];
                  if (signature === undefined || signature["kind"] !== "f") throw new CommandError("COMMAND_INPUT_INVALID");
                  const volatility = signature["volatility"];
                  if (volatility !== "s" && volatility !== "i") throw new CommandError("COMMAND_INPUT_INVALID");
                  if (signature["returns_set"] === true) throw new CommandError("COMMAND_INPUT_INVALID");
                  const argTypes = signature["arg_types"];
                  const argArrays = signature["arg_arrays"];
                  const argElementKinds = signature["arg_element_kinds"];
                  if (!Array.isArray(argTypes) || !Array.isArray(argArrays) || !Array.isArray(argElementKinds)
                    || argTypes.length !== args.length || argArrays.length !== args.length || argElementKinds.length !== args.length) {
                    throw new CommandError("COMMAND_INPUT_INVALID");
                  }
                  const placeholders = args.map((arg, index) => {
                    const type = argTypes[index];
                    const expectsArray = argArrays[index] === true;
                    const elementKind = argElementKinds[index];
                    if (typeof type !== "string" || !/^[A-Za-z0-9_$ .\"()[\],]+$/.test(type)
                      || Array.isArray(arg) !== expectsArray
                      || (expectsArray && !["b", "d", "e"].includes(elementKind))) throw new CommandError("COMMAND_INPUT_INVALID");
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
            db: session.transaction.db, lock: session.transaction.lock, readFunction: session.transaction.readFunction,
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
