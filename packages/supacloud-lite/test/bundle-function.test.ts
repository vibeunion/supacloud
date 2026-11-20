import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleFunction } from '../src/runtime/node/bundle-function.js'

test('removes its isolated output directory when bundling fails', async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'supacloud-lite-bundle-failure-'))
  const entryPath = join(fixtureDirectory, 'index.ts')
  const bundleName = `failure-${crypto.randomUUID()}`
  const outputDirectory = join(tmpdir(), 'supacloud-lite-fn-bundle', bundleName)
  try {
    await writeFile(entryPath, `import './missing-module.ts'\n`)
    await expect(bundleFunction(entryPath, bundleName)).rejects.toThrow()
    expect(existsSync(outputDirectory)).toBe(false)
  } finally {
    await Promise.all([
      rm(fixtureDirectory, { recursive: true, force: true }),
      rm(outputDirectory, { recursive: true, force: true }),
    ])
  }
})

test('bundles installed npm: imports, including scoped versioned exports', async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'supacloud-lite-bundle-local-npm-'))
  const entryPath = join(fixtureDirectory, 'index.ts')
  const packagePath = join(fixtureDirectory, 'node_modules', '@fixture', 'pkg')
  const bundleName = `local-npm-${crypto.randomUUID()}`
  const outputDirectory = join(tmpdir(), 'supacloud-lite-fn-bundle', bundleName)
  try {
    await mkdir(packagePath, { recursive: true })
    await writeFile(join(packagePath, 'package.json'), JSON.stringify({
      name: '@fixture/pkg',
      version: '1.2.3',
      exports: { '.': { import: './index.js', require: './not-esm.cjs' }, './sub': './sub.js' },
    }))
    await writeFile(join(packagePath, 'index.js'), "export default 'local'\n")
    await writeFile(join(packagePath, 'sub.js'), "export default 'subpath'\n")
    await writeFile(entryPath, `
      import root from 'npm:@fixture/pkg'
      import sub from 'npm:@fixture/pkg@^1.2/sub'
      export default [root, sub]
    `)
    expect((await import(await bundleFunction(entryPath, bundleName))).default).toEqual(['local', 'subpath'])

    await writeFile(entryPath, "export { default } from 'npm:@fixture/pkg@2.0.0/sub'\n")
    await expect(bundleFunction(entryPath, bundleName)).rejects.toThrow(
      /requires @fixture\/pkg@2\.0\.0; found 1\.2\.3/,
    )
  } finally {
    await Promise.all([
      rm(fixtureDirectory, { recursive: true, force: true }),
      rm(outputDirectory, { recursive: true, force: true }),
    ])
  }
})

test('keeps transitive HTTP imports relative to the fetched module', async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'supacloud-lite-bundle-url-'))
  const entryPath = join(fixtureDirectory, 'index.ts')
  const bundleName = `http-${crypto.randomUUID()}`
  const outputDirectory = join(tmpdir(), 'supacloud-lite-fn-bundle', bundleName)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    routes: {
      [`/${bundleName}/main.js`]: () => new Response("export { default } from './dep.js'"),
      [`/${bundleName}/dep.js`]: () => new Response("export default 'relative URL'"),
    },
  })
  try {
    await writeFile(entryPath, `export { default } from '${new URL(`${bundleName}/main.js`, server.url)}'\n`)
    expect((await import(await bundleFunction(entryPath, bundleName))).default).toBe('relative URL')
  } finally {
    await server.stop()
    await Promise.all([
      rm(fixtureDirectory, { recursive: true, force: true }),
      rm(outputDirectory, { recursive: true, force: true }),
    ])
  }
})

test('names the install command when an npm: import cannot be resolved', async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'supacloud-lite-bundle-npm-'))
  const entryPath = join(fixtureDirectory, 'index.ts')
  const bundleName = `npm-${crypto.randomUUID()}`
  const outputDirectory = join(tmpdir(), 'supacloud-lite-fn-bundle', bundleName)
  try {
    await writeFile(entryPath, "import missing from 'npm:@supacloud/definitely-not-published'\nexport default missing\n")
    await expect(bundleFunction(entryPath, bundleName)).rejects.toThrow(
      /bun add @supacloud\/definitely-not-published/,
    )
    expect(existsSync(outputDirectory)).toBe(false)
  } finally {
    await Promise.all([
      rm(fixtureDirectory, { recursive: true, force: true }),
      rm(outputDirectory, { recursive: true, force: true }),
    ])
  }
})
