/**
 * Compatibility re-export. The ZenStack adapter lives in `@supacloud/db-zenstack`.
 * Catalog and governance code in this package must not import it.
 * Install `@supacloud/db-zenstack` before importing this path.
 */
export {
  createZenStackDatabase,
  type ModelClient,
  type ModelCommandTransaction,
  type ModelReadClient,
  type ReadFunctionScalar,
} from "@supacloud/db-zenstack";
export type {
  CallFunctionOptions,
  CallFunctionPolicy,
  CallFunctionVolatility,
  JsonArgument,
  ReadFunctionArg,
  ReadFunctionRow,
} from "@supacloud/db-zenstack";
