/**
 * Standalone build targets and the Rust cdylib that belongs to each one.
 *
 * Bun can cross-compile the JavaScript bundle from any host, but a cdylib is
 * native code: it must be built for (or on) the target platform. The build
 * scripts therefore resolve the core per target instead of assuming the host
 * library fits every binary.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { realtimeCoreLibraryName } from '../src/runtime/realtime/core-ffi.js'

export type CorePlatform = 'linux' | 'darwin' | 'win32'

export interface RealtimeCoreTarget {
  name: string
  bunTarget: Bun.Build.CompileTarget | true
  filename: string
  /** Rust target triple; `null` means "build for the host". */
  rustTarget: string | null
  platform: CorePlatform
  arch: 'x64' | 'arm64'
}

export const STANDALONE_TARGETS: Record<string, RealtimeCoreTarget> = {
  host: {
    name: 'host',
    bunTarget: true,
    filename: 'supacloud-lite',
    rustTarget: null,
    platform: process.platform as CorePlatform,
    arch: process.arch as 'x64' | 'arm64',
  },
  'linux-x64': {
    name: 'linux-x64',
    bunTarget: 'bun-linux-x64-baseline',
    filename: 'supacloud-lite-linux-x64',
    rustTarget: 'x86_64-unknown-linux-gnu',
    platform: 'linux',
    arch: 'x64',
  },
  'linux-arm64': {
    name: 'linux-arm64',
    bunTarget: 'bun-linux-arm64',
    filename: 'supacloud-lite-linux-arm64',
    rustTarget: 'aarch64-unknown-linux-gnu',
    platform: 'linux',
    arch: 'arm64',
  },
  'macos-x64': {
    name: 'macos-x64',
    bunTarget: 'bun-darwin-x64',
    filename: 'supacloud-lite-macos-x64',
    rustTarget: 'x86_64-apple-darwin',
    platform: 'darwin',
    arch: 'x64',
  },
  'macos-arm64': {
    name: 'macos-arm64',
    bunTarget: 'bun-darwin-arm64',
    filename: 'supacloud-lite-macos-arm64',
    rustTarget: 'aarch64-apple-darwin',
    platform: 'darwin',
    arch: 'arm64',
  },
  'windows-x64': {
    name: 'windows-x64',
    bunTarget: 'bun-windows-x64-baseline',
    filename: 'supacloud-lite-windows-x64.exe',
    rustTarget: 'x86_64-pc-windows-msvc',
    platform: 'win32',
    arch: 'x64',
  },
}

export function parseRequestedTargets(argv: string[]): string[] {
  const requested = argv.slice(2)
  return requested.length === 0 ? ['host'] : requested
}

export function platformFromRustTarget(triple: string): CorePlatform {
  if (triple.includes('apple-darwin')) return 'darwin'
  if (triple.includes('windows')) return 'win32'
  if (triple.includes('linux')) return 'linux'
  throw new Error(`unsupported realtime core target: ${triple}`)
}

export function libraryNameForPlatform(platform: CorePlatform): string {
  return realtimeCoreLibraryName(platform)
}

/** `crates/realtime-core/target[/<triple>]/<profile>/<library>` */
export function coreArtifactPath(crateDir: string, rustTarget: string | null, profile: 'debug' | 'release'): string {
  const platform = rustTarget ? platformFromRustTarget(rustTarget) : (process.platform as CorePlatform)
  return join(crateDir, 'target', ...(rustTarget ? [rustTarget] : []), profile, libraryNameForPlatform(platform))
}

/**
 * Layout for prebuilt cores: `<root>/<lib>` for the host, `<root>/<triple>/<lib>`
 * for cross targets. `root` is `SUPACLOUD_LITE_REALTIME_CORE_DIR` or `dist/native`.
 */
export function stagedCorePath(root: string, target: RealtimeCoreTarget): string {
  const library = libraryNameForPlatform(target.platform)
  return target.rustTarget ? join(root, target.rustTarget, library) : join(root, library)
}

export interface StagedCoreOptions {
  env?: Record<string, string | undefined>
}

/** Find a prebuilt core for `target`, or `null` when nothing is staged. */
export function resolveStagedCore(packageDir: string, target: RealtimeCoreTarget, options: StagedCoreOptions = {}): string | null {
  const root = options.env?.SUPACLOUD_LITE_REALTIME_CORE_DIR ?? process.env.SUPACLOUD_LITE_REALTIME_CORE_DIR
  const roots = root ? [root] : [join(packageDir, 'dist', 'native')]
  for (const base of roots) {
    const candidate = stagedCorePath(base, target)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** True when the standalone target runs on the machine doing the build. */
export function isHostTarget(target: RealtimeCoreTarget, platform = process.platform, arch = process.arch): boolean {
  return target.platform === platform && target.arch === arch
}
