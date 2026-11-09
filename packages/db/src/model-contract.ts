import type { CommandRetentionStore, CommandStore } from "@supacloud/contracts";

/**
 * Platform-owned model contract.
 *
 * ZenStack is the current implementation backend, but application code should
 * depend on these ports rather than on a backend client.
 */
export type ModelScalar = string | number | boolean | null;
export type ReadFunctionArg = ModelScalar | readonly ModelScalar[];
export type JsonArgument = string | number | boolean | null | readonly JsonArgument[] | { readonly [key: string]: JsonArgument };
export type CallFunctionVolatility = "stable" | "immutable" | "volatile";

export interface CallFunctionOptions {
  /** Assert the catalog volatility instead of accepting any reviewed function. */
  readonly volatility?: CallFunctionVolatility;
}

export interface ReadFunctionRow {
  /** Schema-qualified ordinary or partitioned table name. */
  readonly table: string;
  /** Single-column primary key name. */
  readonly key: string;
  /** Scalar primary-key value. */
  readonly value: ModelScalar;
}

export interface CallFunctionPolicy {
  /** Schemas whose SECURITY DEFINER functions may be called. Defaults to `public`. */
  readonly schemas?: readonly string[];
  /** Trusted function owners. Defaults to the current database role. */
  readonly owners?: readonly string[];
}

/** Capabilities available to a durable model-backed command. */
export interface ModelCommandTransaction<Database> {
  readonly db: Database;
  /**
   * Serialize competing writes inside the command transaction with
   * transaction-scoped advisory locks. Keys are deduplicated and acquired in
   * sorted order, so they are released on commit/rollback and cannot deadlock
   * against another command using the same key set in a different order.
   */
  readonly lock: (keys: readonly string[]) => Promise<void>;
  /**
   * Call a schema-qualified read-only database function inside the command
   * transaction. The function is catalog-checked on every call: it must be
   * ordinary, uniquely resolved by arity, and STABLE or IMMUTABLE. Arguments
   * are positional scalars or one-dimensional scalar arrays, bound as
   * parameters. System schemas are rejected.
   */
  readonly readFunction: (name: string, args?: readonly ReadFunctionArg[]) => Promise<unknown>;
  /**
   * Read a composite row through a STABLE/IMMUTABLE function that takes the
   * table row type, addressed by that table's single-column primary key. The
   * table, key and row type are catalog-verified; zero rows, multiple rows,
   * non-primary keys and volatile functions fail closed.
   */
  readonly readFunctionByRow: (name: string, row: ReadFunctionRow) => Promise<unknown>;
  /**
   * Call a reviewed schema-qualified function inside the command transaction,
   * including VOLATILE functions that write domain state. The catalog is
   * checked on every call: ordinary function, exact arity, SECURITY DEFINER,
   * fixed search_path, EXECUTE for the current role, trusted owner and an
   * allowed schema. Scalar and JSON arguments are always bound as parameters.
   * The result must be exactly one row.
   */
  readonly callFunction: (name: string, args?: readonly JsonArgument[], options?: CallFunctionOptions) => Promise<unknown>;
}

export type ModelCommandStore<Database> = CommandStore<ModelCommandTransaction<Database>> & CommandRetentionStore;

/** Identity-bound read and command ports supplied by a trusted model host. */
export interface ModelIdentityScope<ReadDatabase, CommandDatabase> {
  readonly models: ReadDatabase;
  readonly commandStore: ModelCommandStore<CommandDatabase>;
}

/** Backend-neutral composition-root contract. */
export interface ModelDatabase<Identity, ReadDatabase, CommandDatabase, Submission = unknown> {
  forIdentity(identity: Identity, submission?: Submission): ModelIdentityScope<ReadDatabase, CommandDatabase>;
  dispose(): Promise<void>;
}
