export const STANDALONE_PGLITE_ASSETS = Symbol.for('supacloud-lite.pglite-standalone-assets')

export type StandaloneExtensionName =
  | 'uuid_ossp'
  | 'pgcrypto'
  | 'citext'
  | 'pg_trgm'
  | 'ltree'
  | 'hstore'
  | 'fuzzystrmatch'

export interface PreparedExtensionBundles {
  bundles: Record<StandaloneExtensionName, URL>
  cleanup: () => Promise<void>
}

export interface StandalonePgliteAssets {
  pgliteWasmModule: WebAssembly.Module
  initdbWasmModule: WebAssembly.Module
  fsBundle: Blob | File
  prepareExtensionBundles: () => Promise<PreparedExtensionBundles>
}
