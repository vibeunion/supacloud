import type { DbEngine } from '../../db/engine.js'

export type ExtensionInventorySource = 'pglite-bundled' | 'native-postgresql'
export type ExtensionInventoryStatus = 'inspected' | 'unavailable'

export interface PostgresExtension {
  name: string
  default_version: string | null
  installed_version: string | null
  comment: string | null
}

export interface PostgresExtensionInventory {
  source: ExtensionInventorySource
  status: ExtensionInventoryStatus
  available: PostgresExtension[]
  installed: Array<{ name: string; version: string }>
  reason?: string
}

export async function inspectPostgresExtensions(
  engine: DbEngine,
  source: ExtensionInventorySource,
): Promise<PostgresExtensionInventory> {
  try {
    const [available, installed] = await Promise.all([
      engine.query<PostgresExtension>(`
        SELECT name, default_version, installed_version, comment
        FROM pg_available_extensions
        ORDER BY name
      `),
      engine.query<{ name: string; version: string }>(`
        SELECT extname AS name, extversion AS version
        FROM pg_extension
        ORDER BY extname
      `),
    ])
    return {
      source,
      status: 'inspected',
      available: available.rows,
      installed: installed.rows,
    }
  } catch (error) {
    return {
      source,
      status: 'unavailable',
      available: [],
      installed: [],
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
