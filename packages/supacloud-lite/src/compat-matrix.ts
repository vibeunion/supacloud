/**
 * Declared compatibility pins for the local Supabase import lab.
 * A row is checked only when this process actually exercised that pin.
 * Pins that are documentation-only stay unchecked.
 */

export const SUPABASE_JS_PIN = '2.118.0'
export const SUPABASE_CLI_PIN = '2.122.0'
export const REALTIME_IMAGE_TAG = 'v2.150.0'
export const EDGE_RUNTIME_PACKAGE_VERSION = '0.37.2'

export type MatrixComponent = 'supabase-js' | 'cli' | 'realtime' | 'storage' | 'edge-functions'

export interface VersionMatrixRow {
  component: MatrixComponent
  declared_version: string
  observed_version: string | null
  version_source: string
  checked: boolean
  blocker: string | null
}

export async function readInstalledSupabaseJsVersion(): Promise<string | null> {
  try {
    const manifest: unknown = await import('@supabase/supabase-js/package.json', { with: { type: 'json' } })
    if (manifest && typeof manifest === 'object') {
      const record = manifest as { version?: unknown; default?: { version?: unknown } }
      if (typeof record.version === 'string') return record.version
      if (typeof record.default?.version === 'string') return record.default.version
    }
    return null
  } catch {
    return null
  }
}

export async function buildVersionMatrix(input: { supabaseJsExercised: boolean }): Promise<VersionMatrixRow[]> {
  const observed = await readInstalledSupabaseJsVersion()
  let supabaseBlocker: string | null = null
  if (!observed) supabaseBlocker = '@supabase/supabase-js is not installed in this runtime'
  else if (observed !== SUPABASE_JS_PIN) {
    supabaseBlocker = `installed @supabase/supabase-js ${observed} does not match declared pin ${SUPABASE_JS_PIN}`
  } else if (!input.supabaseJsExercised) {
    supabaseBlocker = 'this command did not complete a local supabase-js verify call'
  }
  return [
    {
      component: 'supabase-js',
      declared_version: SUPABASE_JS_PIN,
      observed_version: observed,
      version_source: 'docs/supabase-upstream-adoption.md and packages/supacloud-lite/package.json',
      checked: supabaseBlocker === null,
      blocker: supabaseBlocker,
    },
    {
      component: 'cli',
      declared_version: SUPABASE_CLI_PIN,
      observed_version: null,
      version_source: 'docs/supabase-upstream-adoption.md SUPABASE_CLI_VERSION',
      checked: false,
      blocker: 'Recommended pin only. This command does not execute the official Supabase CLI.',
    },
    {
      component: 'realtime',
      declared_version: REALTIME_IMAGE_TAG,
      observed_version: null,
      version_source: 'install.sh public.ecr.aws/supabase/realtime:v2.150.0',
      checked: false,
      blocker: 'Platform image pin only. This command does not open a Realtime WebSocket.',
    },
    {
      component: 'storage',
      declared_version: 'repository-owned',
      observed_version: null,
      version_source: 'docs/platform-component-upgrade-notes.md (Storage is not an upstream storage-api image)',
      checked: false,
      blocker: 'Object bytes are recorded on the objects checklist when files are present. No upstream storage-api version is pinned, so this row stays unchecked.',
    },
    {
      component: 'edge-functions',
      declared_version: EDGE_RUNTIME_PACKAGE_VERSION,
      observed_version: null,
      version_source: 'packages/edge-runtime/package.json',
      checked: false,
      blocker: 'In-process Lite function invokes are recorded on the functions checklist when function files are present. @supacloud/edge-runtime was not started, so this row stays unchecked.',
    },
  ]
}
