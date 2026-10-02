import { chmod } from 'node:fs/promises'
import { resolve } from 'node:path'

const packageDir = resolve(import.meta.dir, '..')
const sourcePath = resolve(packageDir, 'src/launcher.mjs')
const outputPath = resolve(packageDir, 'dist/launcher.mjs')

await Bun.write(outputPath, Bun.file(sourcePath))
await chmod(outputPath, 0o755)
