// Build-time shim for the optional `@supacloud/db-zenstack` adapter.
// The compatibility entry points re-export the adapter but must type-check and
// emit declarations without installing the adapter in the control-plane package.
// Consumers that import those entry points resolve the adapter's real types.
declare module "@supacloud/db-zenstack" {
  export function createZenStackDatabase(...args: any[]): any;
  export class BunPostgresDialect {
    constructor(...args: any[]);
  }
  export type BunSqlPool = any;
  export type ModelClient = any;
  export type ModelCommandTransaction = any;
  export type ModelReadClient = any;
  export type ReadFunctionScalar = any;
  export type CallFunctionOptions = any;
  export type CallFunctionPolicy = any;
  export type CallFunctionVolatility = any;
  export type JsonArgument = any;
  export type ReadFunctionArg = any;
  export type ReadFunctionRow = any;
}

declare module "@supacloud/db-zenstack/model" {
  export const BOOTSTRAP_MODEL_SCHEMA: any;
  export function compileModel(...args: any[]): any;
  export function modelProcess(...args: any[]): any;
  export type ModelCommand = any;
}

declare module "@supacloud/db-zenstack/cli" {
  export function modelMain(argv: string[]): Promise<void>;
}
