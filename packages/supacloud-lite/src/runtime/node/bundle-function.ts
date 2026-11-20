/**
 * Bundle an edge function with Bun.build so TypeScript and dependency imports
 * resolve before the function is loaded:
 *   - TypeScript and multi-file functions (relative imports)
 *   - `npm:` specifiers     → Bun's own resolution from project `node_modules`
 *   - `https://` URL imports → fetched at bundle time and disk-cached
 *
 * npm packages are not fetched from a CDN during load: a function that imports
 * `npm:x` needs `x` installed in the project, and the resulting bundle error
 * says so instead of reaching a third-party registry on every boot.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const NPM_SPECIFIER = /^npm:((?:@[\w-][\w.-]*\/)?[\w-][\w.-]*)(?:@([^/\s]+))?(\/[^\s\\?#]+)?$/

function installedPackageVersion(path: string, packageName: string): string | undefined {
  // Resolve exports first: many packages do not export their package.json.
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      const { name, version } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: unknown
        version?: unknown
      }
      if (name === packageName) return typeof version === 'string' ? version : undefined
    }
    if (dirname(dir) === dir) return undefined
  }
}

function resolveNpmImport(specifier: string, importer: string): string {
  const [, packageName, range, subpath = ''] = NPM_SPECIFIER.exec(specifier) ?? []
  if (!packageName) throw new Error(`Invalid npm import: ${specifier}`)
  const install = `bun add ${packageName}${range ? `@${range}` : ''}`
  let path: string
  try {
    path = Bun.resolveSync(`${packageName}${subpath}`, dirname(importer))
  } catch (cause) {
    throw new Error(`Could not resolve ${specifier}. Install it in the project (\`${install}\`) and check that the package exports ${subpath || 'its main entry'}.`, { cause })
  }
  if (range) {
    const version = installedPackageVersion(path, packageName)
    if (!version || !Bun.semver.satisfies(version, range)) {
      throw new Error(`${specifier} requires ${packageName}@${range}; found ${version ?? 'no package version'}. Install the requested semver version (\`${install}\`), or use an unversioned import for an installed dist-tag.`)
    }
  }
  return path
}

const HTTP_CACHE = join(tmpdir(), 'supacloud-lite-fn-http')

async function fetchModule(url: string): Promise<string> {
  const key = createHash('sha256').update(url).digest('hex')
  const cached = join(HTTP_CACHE, key)
  if (existsSync(cached)) return readFile(cached, 'utf8')
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status}`)
  const body = await res.text()
  await mkdir(HTTP_CACHE, { recursive: true })
  await writeFile(cached, body)
  return body
}

function dependencyPlugin(): Bun.BunPlugin {
  return {
    name: 'supacloud-lite-function-dependencies',
    setup(build: Bun.PluginBuilder) {
      const resolveHttpDependency: Bun.OnResolveCallback = (args) => {
        if (!/^https?:\/\//.test(args.importer)) return
        const url = new URL(args.path, args.importer)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error(`Unsupported import ${args.path} in URL module ${args.importer}`)
        }
        return { path: url.href, namespace: 'http-url' }
      }
      // Bun can dispatch relative imports from URL modules through the file hooks.
      build.onResolve({ filter: /.*/ }, resolveHttpDependency)
      build.onResolve({ filter: /.*/, namespace: 'http-url' }, resolveHttpDependency)
      build.onResolve({ filter: /^npm:/ }, (args) => ({
        path: resolveNpmImport(args.path, args.importer),
      }))
      build.onResolve({ filter: /^https?:\/\// }, (args: { path: string }) => ({
        path: args.path,
        namespace: 'http-url',
      }))
      build.onLoad({ filter: /.*/, namespace: 'http-url' }, async (args: { path: string }) => ({
        contents: await fetchModule(args.path),
        loader: 'js',
      }))
    },
  }
}

/**
 * Bundle `entryPath` to a single ESM file and return its path (written under
 * the OS temp dir).
 */
export async function bundleFunction(entryPath: string, name: string): Promise<string> {
  const outDir = join(tmpdir(), 'supacloud-lite-fn-bundle', name)
  await mkdir(outDir, { recursive: true })
  let buildOutput: Awaited<ReturnType<typeof Bun.build>>
  try {
    buildOutput = await Bun.build({
      entrypoints: [entryPath],
      format: 'esm',
      target: 'bun',
      outdir: outDir,
      naming: `${name}-[hash].[ext]`,
      plugins: [dependencyPlugin()],
    })
  } catch (buildThrow) {
    // Bun.build throws an AggregateError("Bundle failed") whose sub-errors carry
    // the actual diagnostics; surface them so CI logs are actionable.
    const details = buildThrow instanceof AggregateError
      ? buildThrow.errors.map((item) => (item as Error)?.message ?? String(item)).filter(Boolean).join('\n')
      : buildThrow instanceof Error ? buildThrow.message : String(buildThrow)
    try {
      await rm(outDir, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([buildThrow, cleanupError], `failed to clean function bundle directory ${outDir}`)
    }
    throw new Error(`failed to bundle ${entryPath}\n${details}`, { cause: buildThrow })
  }
  try {
    if (!buildOutput.success || buildOutput.outputs.length === 0) {
      const details = buildOutput.logs.map((item) => item.message).join('\n')
      throw new Error(`failed to bundle ${entryPath}\n${details}`)
    }
    const output = buildOutput.outputs[0]
    if (!output) throw new Error(`bundle produced no output for ${entryPath}`)
    return output.path
  } catch (buildError) {
    try {
      await rm(outDir, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([buildError, cleanupError], `failed to clean function bundle directory ${outDir}`)
    }
    throw buildError
  }
}
