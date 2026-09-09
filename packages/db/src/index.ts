export {
  defineDatabaseModule,
  type DatabaseModule,
  type DatabaseModuleOptions,
  type DrizzleTableLike,
  type FunctionDecl,
  type GrantDecl,
  type PolicyDecl,
  type PolicyOperation,
  type TableRef,
  type TriggerDecl,
} from './module.js';

export {
  extractSearchPath,
  readCatalog,
  type CatalogFunction,
  type CatalogGrant,
  type CatalogPolicy,
  type CatalogTable,
  type CatalogTrigger,
  type DatabaseCatalog,
  type QueryExecutor,
} from './catalog.js';

export {
  reconcileModule,
  splitQualifiedName,
  type ReconcileIssue,
  type ReconcileReport,
} from './reconcile.js';

export { lintModule, lintSql, type LintIssue } from './lint.js';

export { planModule, type ModulePlan, type PlanStep } from './plan.js';

export { applyModulePlan, type ApplyResult } from './apply.js';

export {
  migrationBindingSha256,
  parseMigrationBindingManifest,
  renderMigrationBindings,
  type MigrationBindingManifest,
  type MigrationBindingParameter,
  type MigrationBindingSource,
  type MigrationBindingTarget,
  type MigrationBindingTemplate,
  type MigrationBindingType,
} from './migration-bindings.js';

export {
  buildDatabaseManifest,
  explainObject,
  type DatabaseManifest,
  type DatabaseManifestModule,
} from './manifest.js';

export {
  createDatabaseAccessBoundary,
  DatabaseAccessError,
  type AuthenticatedDatabaseIdentity,
  type DatabaseAccessBoundary,
  type DatabaseAccessBoundaryOptions,
  type DatabaseAccessErrorCode,
} from './access.js';

export {
  createRpcClient,
  defineRpcContract,
  RpcContractError,
  type RpcArgs,
  type RpcCallResult,
  type RpcContract,
  type RpcDecoder,
  type RpcResult,
  type RpcTransport,
} from './rpc.js';

export { COMMAND_PERSISTENCE_SQL, COMMAND_PERSISTENCE_UPGRADE_SQL } from "./command-schema";
export {
  createPostgresCommandStore, type CommandDatabase, type CommandTransaction,
} from "./command-adapter";
