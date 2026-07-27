/** Loads migrations + seed following Supabase CLI conventions (supabase/ dir). */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MigrationFile } from '../types.js'

/** Migrations and optional seed SQL discovered under a project's supabase/ dir. */
export interface SupabaseProject {
  /** Migrations in filename order (timestamp-prefixed, so lexical == chronological). */
  migrations: MigrationFile[]
  /** Concatenated seed files, if any were found and seeding is enabled. */
  seedSql?: string
}

/** Seed config from config.toml [db.seed] (enabled + explicit file paths). */
export interface SeedOptions {
  /** whether seeding runs; only `false` disables it (undefined means enabled) */
  enabled?: boolean
  /** Files or Bun glob patterns relative to supabase/, applied in order. Defaults to ['seed.sql']. */
  paths?: string[]
}

/**
 * Read supabase/migrations/*.sql (sorted) and, unless disabled, the configured
 * seed files. A missing migrations dir or seed file is not an error.
 */
export async function loadSupabaseProject(projectDir: string, seed: SeedOptions = {}): Promise<SupabaseProject> {
  const migrationsDir = join(projectDir, 'supabase', 'migrations')
  const migrations: MigrationFile[] = []

  let entries: string[] = []
  try {
    entries = await readdir(migrationsDir)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.sql')) continue
    const sql = await readFile(join(migrationsDir, entry), 'utf8')
    migrations.push({ name: entry.replace(/\.sql$/, ''), sql })
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

  return { migrations, seedSql }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}
