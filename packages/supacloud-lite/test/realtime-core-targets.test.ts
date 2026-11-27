import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  coreArtifactPath,
  isHostTarget,
  libraryNameForPlatform,
  parseRequestedTargets,
  platformFromRustTarget,
  resolveStagedCore,
  STANDALONE_TARGETS,
} from '../scripts/realtime-core-targets.js'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'supacloud-lite-core-targets-'))
  temporary.push(directory)
  return directory
}

describe('standalone Realtime core targets', () => {
  test('maps every standalone target to a Rust triple and library name', () => {
    expect(STANDALONE_TARGETS['linux-x64']!.rustTarget).toBe('x86_64-unknown-linux-gnu')
    expect(STANDALONE_TARGETS['linux-arm64']!.rustTarget).toBe('aarch64-unknown-linux-gnu')
    expect(STANDALONE_TARGETS['macos-x64']!.rustTarget).toBe('x86_64-apple-darwin')
    expect(STANDALONE_TARGETS['macos-arm64']!.rustTarget).toBe('aarch64-apple-darwin')
    expect(STANDALONE_TARGETS['windows-x64']!.rustTarget).toBe('x86_64-pc-windows-msvc')
    expect(libraryNameForPlatform('darwin')).toBe('libsupacloud_realtime_core.dylib')
    expect(libraryNameForPlatform('linux')).toBe('libsupacloud_realtime_core.so')
    expect(libraryNameForPlatform('win32')).toBe('supacloud_realtime_core.dll')
    expect(platformFromRustTarget('aarch64-apple-darwin')).toBe('darwin')
    expect(platformFromRustTarget('x86_64-pc-windows-msvc')).toBe('win32')
    expect(() => platformFromRustTarget('wasm32-unknown-unknown')).toThrow('unsupported realtime core target')
  })

  test('places cross artifacts under the triple directory', () => {
    expect(coreArtifactPath('/repo/crates/realtime-core', null, 'release')).toBe(
      join('/repo/crates/realtime-core', 'target', 'release', libraryNameForPlatform(process.platform as never))
    )
    expect(coreArtifactPath('/repo/crates/realtime-core', 'aarch64-unknown-linux-gnu', 'debug')).toBe(
      join('/repo/crates/realtime-core', 'target', 'aarch64-unknown-linux-gnu', 'debug', 'libsupacloud_realtime_core.so')
    )
  })

  test('defaults to the host target and rejects nothing at parse time', () => {
    expect(parseRequestedTargets(['bun', 'build-standalone.ts'])).toEqual(['host'])
    expect(parseRequestedTargets(['bun', 'build-standalone.ts', 'linux-x64', 'macos-arm64'])).toEqual([
      'linux-x64',
      'macos-arm64',
    ])
  })

  test('host detection is platform and arch specific', () => {
    expect(isHostTarget(STANDALONE_TARGETS['linux-x64']!, 'linux', 'x64')).toBe(true)
    expect(isHostTarget(STANDALONE_TARGETS['linux-x64']!, 'linux', 'arm64')).toBe(false)
    expect(isHostTarget(STANDALONE_TARGETS['macos-arm64']!, 'darwin', 'arm64')).toBe(true)
    expect(isHostTarget(STANDALONE_TARGETS['windows-x64']!, 'linux', 'x64')).toBe(false)
  })

  test('resolves a staged cross core from the override directory only', async () => {
    const packageDir = await temporaryDirectory()
    const override = await temporaryDirectory()
    const target = STANDALONE_TARGETS['linux-arm64']!
    expect(resolveStagedCore(packageDir, target, { env: {} })).toBeNull()

    const library = join(override, target.rustTarget!, libraryNameForPlatform('linux'))
    await mkdir(join(dirname(library)), { recursive: true })
    await writeFile(library, 'staged')
    expect(resolveStagedCore(packageDir, target, { env: { SUPACLOUD_LITE_REALTIME_CORE_DIR: override } })).toBe(library)
    // An override replaces the default lookup instead of chaining after it.
    const fallback = join(packageDir, 'dist', 'native', target.rustTarget!, libraryNameForPlatform('linux'))
    await mkdir(dirname(fallback), { recursive: true })
    await writeFile(fallback, 'fallback')
    expect(resolveStagedCore(packageDir, target, { env: { SUPACLOUD_LITE_REALTIME_CORE_DIR: override } })).toBe(library)
    expect(resolveStagedCore(packageDir, target, { env: {} })).toBe(fallback)
  })
})
