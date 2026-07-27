/**
 * Bundle an edge function with Bun.build so it runs under Bun like it would on
 * Supabase's Deno edge runtime. This resolves what a plain `import()` can't:
 *   - TypeScript and multi-file functions (relative imports)
 *   - `npm:` / `jsr:` specifiers  → rewritten to esm.sh and fetched
 *   - `https://` URL imports       → fetched (and their transitive deps)
 *
 * Remote modules are fetched at bundle time (first run) and disk-cached, the
 * same trade Deno makes.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Map a Deno-style specifier to a fetchable URL. Pure - unit tested. */
export function rewriteRemoteSpecifier(spec: string): string {
  if (spec.startsWith('npm:')) return `https://esm.sh/${spec.slice(4)}`
  if (spec.startsWith('jsr:')) return `https://esm.sh/jsr/${spec.slice(4)}`
  return spec // already an http(s) URL
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

/** Bun plugin: resolve npm:/jsr:/https imports by fetching from esm.sh. */
function remotePlugin(): Bun.BunPlugin {
  return {
    name: 'supacloud-lite-remote',
    setup(build: any) {
      build.onResolve({ filter: /^(npm:|jsr:|https?:\/\/)/ }, (args: { path: string }) => ({
        path: rewriteRemoteSpecifier(args.path),
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
  const outDir = join(tmpdir(), 'supacloud-lite-fn-bundle')
  await mkdir(outDir, { recursive: true })
  const result = await Bun.build({
    entrypoints: [entryPath],
    format: 'esm',
    target: 'bun',
    outdir: outDir,
    naming: `${name}-[hash].[ext]`,
    plugins: [remotePlugin()],
  })
  if (!result.success || result.outputs.length === 0) {
    throw new Error(result.logs.map((item) => item.message).join('\n') || `failed to bundle ${entryPath}`)
  }
  return result.outputs[0]!.path
}
