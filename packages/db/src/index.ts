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
