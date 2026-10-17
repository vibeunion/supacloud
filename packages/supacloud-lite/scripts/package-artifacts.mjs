import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { prepareCommandPackage } from '../../../.github/scripts/prepare-command-package.mjs'

// Keep the smoke consumer outside the checkout, with the same exact dependency
// versions as publication. Never let npm resolve file:../db against a tarball.
/**
 * @param {string} packageDir
 * @param {string} packDir
 * @param {(command: string[], cwd: string) => Promise<string>} run
 * @param {(args: string[]) => string[]} npmCommand
 * @returns {Promise<string[]>}
 */
export async function packConsumerArtifacts(packageDir, packDir, run, npmCommand) {
  const { x: extract } = await import('tar')
  const packagesDir = resolve(packageDir, '..')
  const siblings = new Map()
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const manifest = JSON.parse(await readFile(join(packagesDir, entry.name, 'package.json'), 'utf8'))
      siblings.set(manifest.name, manifest)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const raw = join(packDir, 'raw')
  const prepared = join(packDir, 'prepared')
  await mkdir(raw)
  await mkdir(prepared)
  const archives = []
  for (const directory of ['contracts', 'db', 'supacloud-lite']) {
    const source = join(packagesDir, directory)
    // Lite's prepack still performs its real build and package policy check.
    // Dependencies were built by workspace preparation before this smoke runs.
    const original = await pack(source, raw, directory !== 'supacloud-lite')
    const stage = join(packDir, directory)
    await mkdir(stage)
    await extract({ file: original, cwd: stage, strict: true })
    const stagedPackage = join(stage, 'package')
    const manifest = JSON.parse(await readFile(join(stagedPackage, 'package.json'), 'utf8'))
    const normalized = prepareCommandPackage(manifest, siblings).package
    await writeFile(join(stagedPackage, 'package.json'), `${JSON.stringify(normalized, null, 2)}\n`)
    archives.push(await pack(stagedPackage, prepared, true))
  }
  return archives

  /** @param {string} directory @param {string} destination @param {boolean} ignoreScripts */
  async function pack(directory, destination, ignoreScripts) {
    const output = await run(npmCommand(['pack', '--json', '--pack-destination', destination,
      ...(ignoreScripts ? ['--ignore-scripts'] : [])]), directory)
    const jsonStart = output.lastIndexOf('[\n  {')
    if (jsonStart === -1) throw new Error(`npm pack did not emit JSON:\n${output}`)
    const reports = JSON.parse(output.slice(jsonStart))
    if (reports.length !== 1 || typeof reports[0].filename !== 'string' ||
      basename(reports[0].filename) !== reports[0].filename) throw new Error('Invalid npm pack filename')
    return join(destination, reports[0].filename)
  }
}
