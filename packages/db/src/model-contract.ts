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
  readonly volatility?: CallFunctionVolatility;
}

export interface ReadFunctionRow {
  readonly table: string;
  readonly key: string;
  readonly value: ModelScalar;
}

export interface CallFunctionPolicy {
  readonly schemas?: readonly string[];
  readonly owners?: readonly string[];
}

/** Capabilities available to a durable model-backed command. */
export interface ModelCommandTransaction<Database> {
  readonly db: Database;
  readonly lock: (keys: readonly string[]) => Promise<void>;
  readonly readFunction: (name: string, args?: readonly ReadFunctionArg[]) => Promise<unknown>;
  readonly readFunctionByRow: (name: string, row: ReadFunctionRow) => Promise<unknown>;
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
