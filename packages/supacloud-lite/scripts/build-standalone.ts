import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

interface StandaloneTarget {
  bunTarget: Bun.Build.CompileTarget | true
  filename: string
}

const packageDir = resolve(import.meta.dir, '..')
const outputDir = join(packageDir, 'dist', 'standalone')
const targets: Record<string, StandaloneTarget> = {
  host: { bunTarget: true, filename: 'supacloud-lite' },
  'linux-x64': { bunTarget: 'bun-linux-x64-baseline', filename: 'supacloud-lite-linux-x64' },
  'linux-arm64': { bunTarget: 'bun-linux-arm64', filename: 'supacloud-lite-linux-arm64' },
  'macos-x64': { bunTarget: 'bun-darwin-x64', filename: 'supacloud-lite-macos-x64' },
  'macos-arm64': { bunTarget: 'bun-darwin-arm64', filename: 'supacloud-lite-macos-arm64' },
  'windows-x64': { bunTarget: 'bun-windows-x64-baseline', filename: 'supacloud-lite-windows-x64.exe' },
}

const requestedTargets = process.argv.slice(2)
if (requestedTargets.length === 0) requestedTargets.push('host')

for (const requestedTarget of requestedTargets) {
  const target = targets[requestedTarget]
  if (!target) {
    throw new Error(`unknown standalone target: ${requestedTarget}; expected one of ${Object.keys(targets).join(', ')}`)
  }

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
    },
    compile: target.bunTarget === true
      ? { outfile: output, autoloadDotenv: false, autoloadBunfig: false }
      : { target: target.bunTarget, outfile: output, autoloadDotenv: false, autoloadBunfig: false },
  })
  if (!buildResult.success) {
    for (const log of buildResult.logs) console.error(log)
    throw new Error(`failed to build standalone target ${requestedTarget}`)
  }
  console.log(`Built ${requestedTarget}: ${output}`)
}
