/** Loads migrations + seed following Supabase CLI conventions (supabase/ dir). */
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderMigrationBindings, type MigrationBindingTarget } from '@supacloud/db'
import type { MigrationFile } from '../types.js'

/** Migrations and optional seed SQL discovered under a project's supabase/ dir. */
export interface SupabaseProject {
  /** Migrations in filename order (timestamp-prefixed, so lexical == chronological). */
  migrations: MigrationFile[]
  /** Concatenated seed files, if any were found and seeding is enabled. */
  seedSql?: string
  bindingAttestation?: ReturnType<typeof renderMigrationBindings>['attestation']
}

/** Seed config from config.toml [db.seed] (enabled + explicit file paths). */
export interface SeedOptions {
  /** whether seeding runs; only `false` disables it (undefined means enabled) */
  enabled?: boolean
  /** Files or Bun glob patterns relative to supabase/, applied in order. Defaults to ['seed.sql']. */
  paths?: string[]
  bindings?: {
    manifest: unknown
    target: MigrationBindingTarget
    values: Readonly<Record<string, string | undefined>>
  }
}

/**
 * Read supabase/migrations/*.sql (sorted) and, unless disabled, the configured
 * seed files. A missing migrations dir or seed file is not an error.
 */
export async function loadSupabaseProject(projectDir: string, seed: SeedOptions = {}): Promise<SupabaseProject> {
  const migrationsDir = join(projectDir, 'supabase', 'migrations')
  let migrations: MigrationFile[] = []
  const sources: Array<{ file: string; sql: string }> = []

  let entries: string[] = []
  try {
    entries = await readdir(migrationsDir)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  for (const entry of entries.sort()) {
    const info = await lstat(join(migrationsDir, entry))
    if (info.isSymbolicLink()) throw new Error(`migration paths must not be symbolic links: ${entry}`)
    let file: string
    let name: string
    if (info.isFile() && entry.endsWith('.sql')) {
      file = entry
      name = entry.replace(/\.sql$/, '')
    } else if (info.isDirectory() && /^\d/.test(entry)) {
      file = `${entry}/migration.sql`
      name = entry
      const sqlInfo = await lstat(join(migrationsDir, file)).catch((error) => {
        if (isNotFound(error)) throw new Error(`migration folder is missing migration.sql: ${entry}`)
        throw error
      })
      if (!sqlInfo.isFile() || sqlInfo.isSymbolicLink()) throw new Error(`invalid migration file: ${file}`)
    } else continue
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    sources.push({ file, sql })
    migrations.push({ name, sql })
  }
  const versions = new Set<string>()
  for (const migration of migrations) {
    const version = migration.name.match(/^(\d+)/)?.[1] ?? migration.name
    if (versions.has(version)) throw new Error(`duplicate migration version: ${version}`)
    versions.add(version)
  }
  const rendered = seed.bindings ? renderMigrationBindings({
    ...seed.bindings,
    migrations: sources,
  }) : undefined
  if (rendered) migrations = migrations.map((migration, index) => ({
    ...migration, sql: rendered.migrations[index]!.sql,
  }))
  else if (sources.some(({ sql }) => /__SC_BINDING_[A-Z0-9_]+__/.test(sql))) {
    throw new Error('migration binding placeholders require an explicit manifest and target')
  }

  let seedSql: string | undefined
  if (seed.enabled !== false) {
    const parts: string[] = []
    const supabaseDir = join(projectDir, 'supabase')
    for (const configuredPath of seed.paths ?? ['seed.sql']) {
      const pattern = configuredPath.replace(/^\.\//, '')
      const matches = /[*?[\]{}]/.test(pattern)
        ? [...new Bun.Glob(pattern).scanSync({ cwd: supabaseDir, onlyFiles: true })].sort()
        : [pattern]
      for (const relativePath of matches) {
        try {
          parts.push(await readFile(join(supabaseDir, relativePath), 'utf8'))
        } catch (error) {
          if (!isNotFound(error)) throw error
        }
      }
    }
    if (parts.length) seedSql = parts.join('\n')
  }

  return { migrations, seedSql, ...(rendered ? { bindingAttestation: rendered.attestation } : {}) }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}
