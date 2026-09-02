/**
 * Outbound fetch policy for edge functions: while a function that declares
 * capabilities.outbound_hosts runs, globalThis.fetch may only reach the
 * declared hosts (exact host match, port excluded) plus loopback - loopback is
 * always allowed so a function can call back into the local API. Mirrors the
 * SupaCloud Edge Runtime Manifest v2 capabilities.outbound_hosts semantics.
 *
 * Like the Deno/pgredis shims, the wrapped fetch is installed once per process
 * and the allowlist lives in an AsyncLocalStorage store, so concurrent
 * invocations of functions with different policies each enforce their own list
 * (a naive global swap + finally-restore would race across interleaved awaits).
 * Outside a policy scope - including functions that don't declare
 * outbound_hosts - the wrapper passes straight through to the original fetch.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const policyStore = new AsyncLocalStorage<ReadonlySet<string>>()

// functions legitimately call back into the Lite API / DB on loopback
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1'])

let installed = false

function installFetchPolicyShim(): void {
  if (installed) return
  installed = true
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const allowed = policyStore.getStore()
    if (!allowed) return original(input, init)
    const host = hostOf(input)
    if (host !== undefined && !LOOPBACK_HOSTS.has(host) && !allowed.has(host)) {
      throw new Error(`outbound host not allowed: ${host}`)
    }
    return original(input, init)
  }) as typeof fetch
}

/**
 * Run `fn` with fetch restricted to `allowedHosts` (plus loopback). The
 * binding lives in an async-context store, so it stays correct across awaits
 * and never leaks into other invocations - there is nothing to restore.
 */
export function runWithFetchPolicy<T>(allowedHosts: string[], fn: () => Promise<T>): Promise<T> {
  installFetchPolicyShim()
  return policyStore.run(new Set(allowedHosts), fn)
}

/** Extract the comparison host (no port, no IPv6 brackets) from a fetch input. */
function hostOf(input: RequestInfo | URL): string | undefined {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const host = new URL(raw).hostname
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  } catch {
    return undefined
  }
}
