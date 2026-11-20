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
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The URL Bun must fetch itself; every other specifier resolves locally. Pure. */
export function remoteUrlSpecifier(spec: string): string | null {
  return /^https?:\/\//.test(spec) ? spec : null
}

const NPM_SPECIFIER = /npm:([@A-Za-z0-9._/-]+)/

/** Explain an unresolved `npm:` import instead of surfacing a bare Bun error. */
function missingPackageHint(details: string): string {
  if (!/could not resolve/i.test(details)) return ''
  const specifier = NPM_SPECIFIER.exec(details)?.[1]
  if (!specifier) return ''
  return `\nInstall it in the project (\`bun add ${specifier}\`): npm: specifiers resolve from node_modules and are no longer fetched from a CDN at load time.`
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

/** Bun plugin: fetch only `https://` imports; `npm:` stays with Bun. */
function remotePlugin(): Bun.BunPlugin {
  return {
    name: 'supacloud-lite-remote',
    setup(build: Bun.PluginBuilder) {
      build.onResolve({ filter: /^https?:\/\// }, (args: { path: string }) => ({
        path: remoteUrlSpecifier(args.path) ?? args.path,
        namespace: 'http-url',
      }))
      // imports *inside* a fetched module resolve relative to its URL
      build.onResolve({ filter: /.*/, namespace: 'http-url' }, (args: { path: string; importer: string }) => ({
        path: new URL(args.path, args.importer).href,
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
      plugins: [remotePlugin()],
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
    throw new Error(`failed to bundle ${entryPath}\n${details}${missingPackageHint(details)}`, { cause: buildThrow })
  }
  try {
    if (!buildOutput.success || buildOutput.outputs.length === 0) {
      const details = buildOutput.logs.map((item) => item.message).join('\n')
      throw new Error(`failed to bundle ${entryPath}\n${details}${missingPackageHint(details)}`)
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
