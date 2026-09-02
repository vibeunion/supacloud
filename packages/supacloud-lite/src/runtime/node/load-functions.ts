/** Loads edge functions from supabase/functions/<name>/index.{ts,js,mjs} (Node only). */
import { readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EdgeFunction, FrameworkObjectHandler, FunctionFramework, LoadedFunction } from '../functions/handler.js'
import { installDenoShim, resetCapturedHandler, takeCapturedHandler } from '../functions/deno-shim.js'
import { bundleFunction } from './bundle-function.js'

/**
 * Load edge-function secrets from supabase/functions/.env (KEY=VALUE lines,
 * `#` comments). These are exposed to functions via Deno.env and ctx.env -
 * the local equivalent of `supabase functions serve --env-file`.
 */
export async function loadFunctionEnv(projectDir: string): Promise<Record<string, string>> {
  let text: string
  try {
    text = await readFile(join(projectDir, 'supabase', 'functions', '.env'), 'utf8')
  } catch {
    return {}
  }
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key) env[key] = val
  }
  return env
}

/** Per-function options from config.toml [functions.<name>]. */
export interface LoadFunctionOptions {
  /** Skip loading when explicitly disabled. */
  enabled?: boolean
  /** Custom entrypoint path, relative to the project root. */
  entrypoint?: string
  /** Framework profile: fetch (default, legacy routing), elysia, or hono. */
  framework?: FunctionFramework
  /** Invocation timeout in ms (Edge Runtime limits.timeout_ms). */
  timeoutMs?: number
  /** Max inbound request body bytes (Edge Runtime limits.max_request_body_bytes). */
  maxRequestBodyBytes?: number
  /** Max outbound response body bytes (Edge Runtime limits.max_response_body_bytes). */
  maxResponseBodyBytes?: number
  /** Max wait for EdgeRuntime.waitUntil tasks after the response (Edge Runtime limits.wait_until_timeout_ms). */
  waitUntilTimeoutMs?: number
  /** Outbound fetch host allowlist (Edge Runtime capabilities.outbound_hosts). */
  outboundHosts?: string[]
  /** Env keys exposed to the function beyond the SUPABASE_* base trio (Edge Runtime capabilities.secrets). */
  secrets?: string[]
  /** EdgeRuntime.waitUntil gate (Edge Runtime capabilities.background); lite defaults to allowed. */
  background?: boolean
}

const FUNCTION_FRAMEWORKS: ReadonlySet<string> = new Set(['fetch', 'elysia', 'hono'])

function resolveFramework(name: string, value: string | undefined): FunctionFramework | undefined {
  if (value === undefined) return undefined
  if (FUNCTION_FRAMEWORKS.has(value)) return value as FunctionFramework
  console.warn(`  warning: function "${name}" has unsupported framework "${value}", expected one of fetch/elysia/hono; falling back to fetch`)
  return undefined
}

let loadQueue: Promise<void> = Promise.resolve()

/**
 * Discover and load every edge function under supabase/functions/, keyed by
 * directory name. Dirs starting with `_` or `.` are skipped (shared code), as
 * are functions disabled in config.toml. Each function is bundled with esbuild
 * when available (falling back to a plain import), then its handler is taken
 * from a default function export, a default `{ fetch() }` / `{ handle() }`
 * object export (Elysia/Hono routers), or a captured `Deno.serve()` call.
 * Load failures warn and skip rather than throwing, so one broken function
 * can't block startup.
 */
export async function loadFunctions(
  projectDir: string,
  options: Record<string, LoadFunctionOptions> = {}
): Promise<Map<string, LoadedFunction>> {
  let releaseQueue!: () => void
  const previous = loadQueue
  loadQueue = new Promise<void>((resolveQueue) => {
    releaseQueue = resolveQueue
  })
  await previous
  try {
    return await loadFunctionsUnlocked(projectDir, options)
  } finally {
    releaseQueue()
  }
}

async function loadFunctionsUnlocked(
  projectDir: string,
  options: Record<string, LoadFunctionOptions>
): Promise<Map<string, LoadedFunction>> {
  const functions = new Map<string, LoadedFunction>()
  const root = join(projectDir, 'supabase', 'functions')

  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return functions
  }

  // so Supabase-style `Deno.serve(handler)` functions run unchanged
  installDenoShim()

  for (const name of entries) {
    if (name.startsWith('_') || name.startsWith('.')) continue
    if (options[name]?.enabled === false) continue // disabled in config.toml
    const dir = join(root, name)
    if (!(await stat(dir)).isDirectory()) continue
    // A config.toml entrypoint overrides the default index.* discovery.
    const candidates = options[name]?.entrypoint
      ? [join(projectDir, options[name].entrypoint!)]
      : ['index.ts', 'index.tsx', 'index.js', 'index.mjs'].map((f) => join(dir, f))
    for (const path of candidates) {
      try {
        await stat(path)
      } catch {
        continue
      }
      let bundledPath: string | undefined
      try {
        // Bundle with esbuild so TS, relative imports, and npm:/jsr:/URL
        // specifiers resolve. If esbuild isn't installed, import the file
        // directly (Web-API / Deno.serve functions still work).
        let importUrl: string
        try {
          bundledPath = await realpath(await bundleFunction(path, `${name}-${crypto.randomUUID()}`))
          importUrl = pathToFileURL(bundledPath).href
        } catch (e) {
          if ((e as Error).message !== 'esbuild-not-available') throw e
          importUrl = pathToFileURL(path).href
        }
        resetCapturedHandler()
        const mod = (await import(importUrl)) as {
          default?: EdgeFunction | FrameworkObjectHandler
        }
        const denoHandler = takeCapturedHandler()
        const defaultExport = mod.default
        const handler: EdgeFunction | FrameworkObjectHandler | undefined =
          typeof defaultExport === 'function'
            ? defaultExport
            : defaultExport &&
                (typeof defaultExport.handle === 'function' || typeof defaultExport.fetch === 'function')
              ? defaultExport
              : denoHandler
                ? (req: Request) => denoHandler(req)
                : undefined
        if (handler) {
          const opts = options[name]
          const limits =
            opts &&
            (opts.timeoutMs !== undefined ||
              opts.maxRequestBodyBytes !== undefined ||
              opts.maxResponseBodyBytes !== undefined ||
              opts.waitUntilTimeoutMs !== undefined)
              ? {
                  ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
                  ...(opts.maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes: opts.maxRequestBodyBytes } : {}),
                  ...(opts.maxResponseBodyBytes !== undefined ? { maxResponseBodyBytes: opts.maxResponseBodyBytes } : {}),
                  ...(opts.waitUntilTimeoutMs !== undefined ? { waitUntilTimeoutMs: opts.waitUntilTimeoutMs } : {}),
                }
              : undefined
          const capabilities =
            opts && (opts.outboundHosts !== undefined || opts.secrets !== undefined || opts.background !== undefined)
              ? {
                  ...(opts.outboundHosts !== undefined ? { outboundHosts: opts.outboundHosts } : {}),
                  ...(opts.secrets !== undefined ? { secrets: opts.secrets } : {}),
                  ...(opts.background !== undefined ? { background: opts.background } : {}),
                }
              : undefined
          functions.set(name, {
            handler,
            framework: resolveFramework(name, opts?.framework),
            ...(limits ? { limits } : {}),
            ...(capabilities ? { capabilities } : {}),
          })
        } else {
          console.warn(`  warning: function "${name}" has no default function, handle/fetch object, or Deno.serve() handler, skipped`)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/Unknown file extension|Cannot find module/.test(msg)) {
          console.warn(`  warning: function "${name}" could not be bundled by Bun: ${msg}`)
        } else {
          console.warn(`  warning: failed to load function "${name}": ${msg}`)
        }
      } finally {
        if (bundledPath) await rm(dirname(bundledPath), { recursive: true, force: true }).catch(() => {})
      }
      break
    }
  }
  return functions
}
