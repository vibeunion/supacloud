export {
  createQueryAdapter,
  createQueryKey,
  createProcedureClient,
} from "./adapter.js";
export type {
  QueryAdapter,
  ProcedureSource,
  ProceduresOf,
  ProcedureQueryLike,
  ProcedureMutateLike,
  QueryProcedureAdapter,
  MutateProcedureAdapter,
} from "./adapter.js";
export { invalidateByTags } from "./invalidation.js";
export type {
  QueryKey,
  QueryOptionsResult,
  MutationOptionsResult,
  QueryClientLike,
  QueryAdapterOptions,
} from "./types.js";
