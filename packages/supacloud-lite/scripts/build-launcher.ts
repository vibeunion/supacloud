import { chmod } from 'node:fs/promises'
import { resolve } from 'node:path'

const packageDir = resolve(import.meta.dir, '..')
const sourcePath = resolve(packageDir, 'src/launcher.cjs')
const outputPath = resolve(packageDir, 'dist/launcher.cjs')

await Bun.write(outputPath, Bun.file(sourcePath))
await chmod(outputPath, 0o755)
