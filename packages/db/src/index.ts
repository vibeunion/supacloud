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
  type DatabaseCatalog,
  type QueryExecutor,
} from './catalog.js';

export {
  reconcileModule,
  type ReconcileIssue,
  type ReconcileReport,
} from './reconcile.js';

export { lintModule, lintSql, type LintIssue } from './lint.js';

export {
  buildDatabaseManifest,
  explainObject,
  type DatabaseManifest,
  type DatabaseManifestModule,
} from './manifest.js';
