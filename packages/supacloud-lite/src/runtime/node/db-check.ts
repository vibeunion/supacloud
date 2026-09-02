/**
 * `db check` support: reconcile declared database modules (@supacloud/db
 * manifests) against the live Lite database catalog, plus SQL source lint.
 * Read-only - never mutates the database.
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  lintModule,
  readCatalog,
  reconcileModule,
  type DatabaseModule,
  type LintIssue,
  type QueryExecutor,
  type ReconcileReport,
} from '@supacloud/db'

export interface DatabaseModuleCheckOptions {
  /** Path to the module manifest file (default export: module or module[]). */
  moduleFile: string
  /** Catalog schema filter. Default: public. */
  schema?: string
  /** Live database query executor (superuser introspection channel). */
  executor: QueryExecutor
}

export interface DatabaseModuleCheckReport {
  module: string
  lintIssues: LintIssue[]
  reconcile: ReconcileReport
}

export interface DatabaseModuleCheckResult {
  ok: boolean
  reports: DatabaseModuleCheckReport[]
}

/** Load database module declarations from a manifest file. */
export async function loadDatabaseModules(moduleFile: string): Promise<DatabaseModule[]> {
  const absolute = resolve(moduleFile)
  try {
    await stat(absolute)
  } catch {
    throw new Error(`database module manifest not found: ${absolute}`)
  }
  const mod = (await import(pathToFileURL(absolute).href)) as {
    default?: DatabaseModule | DatabaseModule[]
    modules?: DatabaseModule[]
  }
  const candidate = mod.default ?? mod.modules
  const list = Array.isArray(candidate) ? candidate : candidate ? [candidate] : []
  if (list.length === 0) {
    throw new Error(`database module manifest ${absolute} must export a default module or module array`)
  }
  for (const entry of list) {
    if (!entry || typeof entry.name !== 'string') {
      throw new Error(`database module manifest ${absolute} contains an entry without a name`)
    }
  }
  return list
}

/**
 * Lint declared SQL sources and reconcile every declared module against the
 * live catalog. `ok` is false when any error-severity issue exists.
 */
export async function checkDatabaseModules(
  options: DatabaseModuleCheckOptions
): Promise<DatabaseModuleCheckResult> {
  const modules = await loadDatabaseModules(options.moduleFile)
  const baseDir = dirname(resolve(options.moduleFile))
  const readSource = (path: string) => readFile(resolve(baseDir, path), 'utf8')
  const catalog = await readCatalog(options.executor, [options.schema ?? 'public'])

  const reports: DatabaseModuleCheckReport[] = []
  for (const module of modules) {
    const lintIssues = await lintModule(module, readSource)
    const reconcile = reconcileModule(module, catalog)
    reports.push({ module: module.name, lintIssues, reconcile })
  }
  const ok = reports.every(
    (report) =>
      report.reconcile.ok && !report.lintIssues.some((issue) => issue.severity === 'error')
  )
  return { ok, reports }
}

/** Human-readable rendering for the CLI. */
export function formatDatabaseModuleCheck(result: DatabaseModuleCheckResult): string {
  const lines: string[] = []
  for (const report of result.reports) {
    lines.push(`module ${report.module}:`)
    for (const issue of report.lintIssues) {
      lines.push(`  [lint ${issue.severity}] ${issue.code}: ${issue.message} (${issue.file})`)
    }
    for (const issue of report.reconcile.issues) {
      lines.push(`  [catalog ${issue.severity}] ${issue.code}: ${issue.message} (${issue.object})`)
    }
    if (report.lintIssues.length === 0 && report.reconcile.issues.length === 0) {
      lines.push('  ok')
    }
  }
  return `${lines.join('\n')}\n`
}
