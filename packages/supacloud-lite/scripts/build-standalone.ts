import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  buildRealtimeCore,
  resetEmbeddedRealtimeCore,
  stageEmbeddedCore,
} from './build-realtime-core'
import {
  isHostTarget,
  libraryNameForPlatform,
  parseRequestedTargets,
  resolveStagedCore,
  stagedCorePath,
  STANDALONE_TARGETS,
  type RealtimeCoreTarget,
} from './realtime-core-targets'

const packageDir = resolve(import.meta.dir, '..')
const outputDir = join(packageDir, 'dist', 'standalone')
const requestedTargets = parseRequestedTargets(process.argv)
for (const requestedTarget of requestedTargets) {
  if (!STANDALONE_TARGETS[requestedTarget]) {
    throw new Error(
      `unknown standalone target: ${requestedTarget}; expected one of ${Object.keys(STANDALONE_TARGETS).join(', ')}`
    )
  }
}

const skipCore = process.env.SUPACLOUD_LITE_SKIP_REALTIME_CORE === '1'
const requireCore = process.env.SUPACLOUD_LITE_REQUIRE_REALTIME_CORE === '1'

/**
 * Embed the Realtime core for one target and describe what was embedded.
 *
 * - Matching host targets compile the cdylib with cargo.
 * - Other targets need a prebuilt library for their Rust triple, staged under
 *   `dist/native/<triple>/` or `SUPACLOUD_LITE_REALTIME_CORE_DIR/<triple>/`.
 * - `SUPACLOUD_LITE_REQUIRE_REALTIME_CORE=1` turns a missing core into a build
 *   failure instead of shipping a binary that fails closed at runtime.
 */
async function embedCoreForTarget(target: RealtimeCoreTarget): Promise<string | null> {
  if (skipCore) return null
  if (isHostTarget(target)) {
    try {
      const core = await buildRealtimeCore({ embed: true, target: target.rustTarget ?? undefined })
      return `${core.filename} (${core.sha256.slice(0, 12)})`
    } catch (error) {
      if (requireCore) throw error
      console.warn(
        `Realtime core was not embedded; the standalone binary will fail closed when Realtime needs it.\n${(error as Error).message}`
      )
      return null
    }
  }

  const staged = resolveStagedCore(packageDir, target)
  if (!staged) {
    const expected = stagedCorePath(
      process.env.SUPACLOUD_LITE_REALTIME_CORE_DIR ?? join(packageDir, 'dist', 'native'),
      target
    )
    const message =
      `no prebuilt Realtime core for ${target.name} (${target.rustTarget}); expected ${expected}. ` +
      `Build it on a matching host with "bun run build:realtime-core --target ${target.rustTarget}" ` +
      `and stage it under dist/native/${target.rustTarget}/.`
    if (requireCore) throw new Error(message)
    console.warn(`${message}\nThe ${target.name} binary will fail closed when Realtime needs the Rust core.`)
    return null
  }
  const sha256 = await stageEmbeddedCore(staged, libraryNameForPlatform(target.platform))
  console.log(`Embedding prebuilt Realtime core for ${target.name} from ${staged} (${sha256.slice(0, 12)})`)
  return `${target.rustTarget} (${sha256.slice(0, 12)})`
}

for (const requestedTarget of requestedTargets) {
  const target = STANDALONE_TARGETS[requestedTarget]!
  let embedded = false
  try {
    const description = await embedCoreForTarget(target)
    embedded = description !== null
    if (description) console.log(`Embedding Realtime core ${description}`)

    await mkdir(outputDir, { recursive: true })
    const output = join(outputDir, target.filename)
    const buildResult = await Bun.build({
      entrypoints: [join(packageDir, 'src', 'standalone.ts')],
      target: 'bun',
      packages: 'bundle',
      naming: { asset: '[name].[ext]' },
      loader: {
        '.wasm': 'file',
        '.data': 'file',
        '.gz': 'file',
        '.dylib': 'file',
        '.so': 'file',
        '.dll': 'file',
      },
      compile:
        target.bunTarget === true
          ? { outfile: output, autoloadDotenv: false, autoloadBunfig: false }
          : { target: target.bunTarget, outfile: output, autoloadDotenv: false, autoloadBunfig: false },
    })
    if (!buildResult.success) {
      for (const log of buildResult.logs) console.error(log)
      throw new Error(`failed to build standalone target ${requestedTarget}`)
    }
    console.log(`Built ${requestedTarget}: ${output}`)
  } finally {
    // The embedded module is shared by every target; restore the checked-in
    // null module so the next target (and the working tree) start clean.
    if (embedded) await resetEmbeddedRealtimeCore()
  }
}
