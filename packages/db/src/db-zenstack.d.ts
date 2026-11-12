// Build-time declaration bridge for the required `@supacloud/db-zenstack` peer.
// The compatibility entry points re-export the adapter but must type-check and
// emit declarations while the adapter is built in its owning package.
// Consumers resolve the required peer's real runtime and declaration types.
declare module "@supacloud/db-zenstack" {
  export function createZenStackDatabase(...args: unknown[]): unknown;
  export class BunPostgresDialect {
    constructor(...args: unknown[]);
  }
  export type BunSqlPool = unknown;
  export type ModelClient = unknown;
  export type ModelCommandTransaction = unknown;
  export type ModelReadClient = unknown;
  export type ReadFunctionScalar = unknown;
  export type CallFunctionOptions = unknown;
  export type CallFunctionPolicy = unknown;
  export type CallFunctionVolatility = unknown;
  export type JsonArgument = unknown;
  export type ReadFunctionArg = unknown;
  export type ReadFunctionRow = unknown;
}

declare module "@supacloud/db-zenstack/model" {
  export const BOOTSTRAP_MODEL_SCHEMA: string;
  export function compileModel(...args: unknown[]): Promise<unknown>;
  export function modelProcess(...args: unknown[]): unknown;
  export type ModelCommand = unknown;
}

declare module "@supacloud/db-zenstack/cli" {
  export type ModelToolCommand = { readonly executable: string; readonly args?: readonly string[] };
  export interface ModelToolchain { resolve(binary: "zen" | "prisma"): ModelToolCommand; }
  export function modelMain(argv: string[], toolchain?: ModelToolchain): Promise<void>;
}
