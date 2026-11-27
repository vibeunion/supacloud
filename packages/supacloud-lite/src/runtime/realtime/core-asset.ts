/**
 * Resolve and open the embedded Realtime core.
 *
 * Order of precedence:
 *
 * 1. `SUPACLOUD_LITE_REALTIME_CORE` — explicit operator override.
 * 2. Embedded single-file asset — extracted to a `0700` temp dir, SHA-256
 *    verified against the build-time digest, then loaded.
 * 3. Package-relative `dist/native/<triple>/<library>` — the npm package
 *    publishes prebuilt cores for every supported platform.
 * 4. `<dir of executable>/native/<library>` — sidecar layout for unpacked
 *    installs.
 * 5. `crates/realtime-core/target/{release,debug}` — development builds.
 *
 * Missing or mismatched resources fail closed with
 * {@link RealtimeCoreUnavailableError}; there is no silent fallback to an
 * unverified binary or to a different protocol implementation.
 */
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadRealtimeCore,
  realtimeCoreLibraryName,
  RealtimeCoreUnavailableError,
  type RealtimeCore,
} from './core-ffi.js'
import { embeddedRealtimeCore } from './embedded-core.js'

export interface OpenRealtimeCoreOptions {
  /** Explicit library path; defaults to the precedence list above. */
  path?: string
  /** Override for tests. */
  env?: Record<string, string | undefined>
  /** Skip embedded extraction (used by tests that pass `path`). */
  ignoreEmbedded?: boolean
}

export interface OpenedRealtimeCore {
  core: RealtimeCore
  /** Absolute path the library was loaded from. */
  path: string
  /** Remove any private extraction dir. Safe to call more than once. */
  close(): Promise<void>
}

const EXTRACT_PREFIX = 'supacloud-lite-realtime-core-'

/** Rust triples staged by the release workflow for npm consumers. */
const REALTIME_CORE_TRIPLES: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

function hostTriple(): string | undefined {
  return REALTIME_CORE_TRIPLES[`${process.platform}-${process.arch}`]
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(new Uint8Array(await Bun.file(path).arrayBuffer()))
  return hash.digest('hex')
}

function executableDir(): string {
  // In a compiled Bun binary `process.execPath` is the executable itself.
  return dirname(process.execPath)
}

async function extractEmbedded(
  asset: { source: string; filename: string; sha256: string }
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), EXTRACT_PREFIX))
  await chmod(directory, 0o700)
  const destination = join(directory, asset.filename)
  try {
    await Bun.write(destination, Bun.file(asset.source))
    const actual = await sha256File(destination)
    if (actual !== asset.sha256) {
      throw new RealtimeCoreUnavailableError(
        `embedded realtime core failed SHA-256 verification (expected ${asset.sha256}, got ${actual})`
      )
    }
    await chmod(destination, 0o700)
    return {
      path: destination,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

function registerExitCleanup(directory: string): void {
  const cleanup = () => {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Best effort: a later start reclaims stale `supacloud-lite-*` dirs.
    }
  }
  process.once('exit', cleanup)
}

async function resolveLibraryPath(
  options: OpenRealtimeCoreOptions
): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
  const env = options.env ?? process.env
  const name = realtimeCoreLibraryName()

  const override = options.path ?? env.SUPACLOUD_LITE_REALTIME_CORE
  if (override) {
    const path = resolve(override)
    if (!(await fileExists(path))) {
      throw new RealtimeCoreUnavailableError(
        `realtime core override does not exist: ${path}`
      )
    }
    return { path, cleanup: async () => {} }
  }

  if (!options.ignoreEmbedded && embeddedRealtimeCore) {
    const extracted = await extractEmbedded(embeddedRealtimeCore)
    registerExitCleanup(dirname(extracted.path))
    return extracted
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const triple = hostTriple()
  const nativeRoot = resolve(here, '..', '..', 'native')
  const packageCandidates = [
    join(nativeRoot, name),
    ...(triple ? [join(nativeRoot, triple, name)] : []),
  ]
  for (const candidate of packageCandidates) {
    if (await fileExists(candidate)) {
      return { path: candidate, cleanup: async () => {} }
    }
  }

  const sidecarCandidates = [
    join(executableDir(), 'native', name),
    ...(triple ? [join(executableDir(), 'native', triple, name)] : []),
  ]
  for (const candidate of sidecarCandidates) {
    if (await fileExists(candidate)) {
      return { path: candidate, cleanup: async () => {} }
    }
  }

  let current = here
  for (let depth = 0; depth < 8; depth += 1) {
    for (const profile of ['release', 'debug']) {
      const candidate = join(
        current,
        'crates',
        'realtime-core',
        'target',
        profile,
        name
      )
      if (existsSync(candidate)) {
        return { path: candidate, cleanup: async () => {} }
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return null
}

/**
 * Open the core, or throw a capability error naming every location tried.
 * Callers should treat a missing core as an unavailable optional capability,
 * not as permission to run a different Realtime implementation.
 */
export async function openRealtimeCore(
  options: OpenRealtimeCoreOptions = {}
): Promise<OpenedRealtimeCore> {
  const resolved = await resolveLibraryPath(options)
  if (!resolved) {
    throw new RealtimeCoreUnavailableError(
      `realtime core library not found. Looked for ${realtimeCoreLibraryName()} in ` +
        `$SUPACLOUD_LITE_REALTIME_CORE, the embedded standalone asset, ` +
        `${join(executableDir(), 'native')} and crates/realtime-core/target. ` +
        `Run "bun run build:realtime-core" or use a standalone build that embeds it.`
    )
  }
  try {
    const core = loadRealtimeCore(resolved.path)
    return {
      core,
      path: resolved.path,
      async close() {
        core.close()
        await resolved.cleanup()
      },
    }
  } catch (error) {
    await resolved.cleanup()
    throw error
  }
}

/** Ensure a private extraction directory exists (used by the build script). */
export async function prepareNativeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
}