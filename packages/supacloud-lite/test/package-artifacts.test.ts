import { expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { packConsumerArtifacts } from '../scripts/package-artifacts.mjs'

test('packed consumer installs the exact local contracts/database graph without workspace links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-packed-graph-'))
  try {
    const packages = join(root, 'packages')
    const packDir = join(root, 'packs')
    const consumer = join(root, 'consumer')
    await mkdir(packDir)
    await mkdir(consumer)
    for (const [directory, name, dependencies] of [
      ['contracts', '@supacloud/contracts', {}],
      ['db', '@supacloud/db', { '@supacloud/contracts': 'file:../contracts' }],
      ['supacloud-lite', '@supacloud/lite', { '@supacloud/db': 'file:../db' }],
    ] as const) {
      const path = join(packages, directory)
      await mkdir(join(path, 'dist'), { recursive: true })
      await writeFile(join(path, 'dist/index.js'), 'export const packed = true\n')
      await writeFile(join(path, 'package.json'), JSON.stringify({
        name, version: '987.654.321', type: 'module', files: ['dist'],
        exports: './dist/index.js', dependencies,
      }))
    }
    const source = join(packages, 'supacloud-lite/package.json')
    const before = await readFile(source, 'utf8')
    const archives = await packConsumerArtifacts(dirname(source), packDir, run, npmCommand)
    expect(archives).toHaveLength(3)
    expect(await readFile(source, 'utf8')).toBe(before)
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true }))
    await run(npmCommand(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...archives]), consumer)
    for (const [name, dependency] of [['lite', 'db'], ['db', 'contracts']] as const) {
      const installed = join(consumer, 'node_modules/@supacloud', name)
      const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
      expect(manifest.dependencies[`@supacloud/${dependency}`]).toBe('987.654.321')
      expect((await lstat(installed)).isSymbolicLink()).toBe(false)
      expect((await realpath(installed)).startsWith(await realpath(consumer))).toBe(true)
    }
    expect((await lstat(join(consumer, 'node_modules/@supacloud/contracts'))).isSymbolicLink()).toBe(false)
    expect(JSON.parse(await readFile(join(consumer, 'node_modules/@supacloud/contracts/package.json'), 'utf8')).version)
      .toBe('987.654.321')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

function npmCommand(args: string[]) {
  if (process.platform !== 'win32') return ['npm', ...args]
  const node = Bun.which('node'), npm = Bun.which('npm')
  if (!node || !npm) throw new Error('Missing Node/npm')
  return [node, join(dirname(npm), 'node_modules/npm/bin/npm-cli.js'), ...args]
}
async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (status !== 0) throw new Error(`${command.join(' ')} failed: ${stderr}`)
  return stdout
}
