/**
 * Minimal `EdgeRuntime` global shim: Supabase-style background tasks via
 * `EdgeRuntime.waitUntil(promise)`, aligned with the SupaCloud Edge Runtime
 * (worker-executor.ts) semantics:
 *
 *   EdgeRuntime.waitUntil(promise)   // runs past the response
 *
 * Like the Deno/fetch-policy shims, the global is installed once per process
 * and the per-invocation task list lives in an AsyncLocalStorage store, so
 * concurrent invocations each track their own tasks. waitUntil is scoped to
 * the invocation: tasks scheduled while a function runs are flushed after its
 * response returns (the flush never blocks the response), and tasks scheduled
 * from within a background task are tracked too (while-splice drain loop,
 * mirroring flushWaitUntilTasks).
 *
 * Capability gating: production requires capabilities.background; lite
 * defaults to ALLOWED for local-development back-compat, and only an explicit
 * `background = false` takes the production error path. A waitUntil call
 * outside any invocation runs detached (there is no per-invocation scope to
 * gate or track it against).
 */
import { AsyncLocalStorage } from 'node:async_hooks'

interface BackgroundScope {
  /** capabilities.background; lite defaults to true unless explicitly false. */
  allowed: boolean
  /** tasks scheduled by this invocation, in scheduling order */
  tasks: Promise<unknown>[]
}

const scopeStore = new AsyncLocalStorage<BackgroundScope>()

/** The production error message, kept verbatim for compatibility tests. */
const NOT_ENABLED_MESSAGE = 'EdgeRuntime.waitUntil is not enabled by the Function capability policy'

interface EdgeRuntimeGlobal {
  waitUntil(promise: PromiseLike<unknown> | unknown): void
}

// Kept so repeat installs return early instead of clobbering, and so tests can
// assert the installed surface.
let installed: EdgeRuntimeGlobal | undefined

/** Install globalThis.EdgeRuntime.waitUntil once per process (idempotent). */
export function installEdgeRuntimeShim(): void {
  if (installed) return
  const runtime: EdgeRuntimeGlobal = {
    waitUntil(promise: PromiseLike<unknown> | unknown) {
      const scope = scopeStore.getStore()
      if (scope && !scope.allowed) {
        throw new Error(NOT_ENABLED_MESSAGE)
      }
      const task = Promise.resolve(promise).catch((error) => {
        console.error('[EdgeRuntime.waitUntil] background task failed', error)
      })
      // outside an invocation there is no flush to join; run detached
      scope?.tasks.push(task)
    },
  }
  installed = runtime
  ;(globalThis as Record<string, unknown>).EdgeRuntime = runtime
}

/**
 * Run `fn` with an EdgeRuntime.waitUntil scope. When `fn` settles, its
 * background tasks are flushed without blocking the returned value: the flush
 * waits for allSettled up to `timeoutMs` (wait_until_timeout_ms), after which
 * it stops waiting and warns - like production, abandoned tasks keep running.
 * Lite backend close() does not wait for in-flight background tasks; tasks
 * still drifting at shutdown are dropped with the process.
 */
export function runWithBackgroundTasks<T>(
  options: { allowed: boolean; timeoutMs?: number },
  fn: () => Promise<T>
): Promise<T> {
  installEdgeRuntimeShim()
  const scope: BackgroundScope = { allowed: options.allowed, tasks: [] }
  return scopeStore.run(scope, async () => {
    try {
      return await fn()
    } finally {
      // fire-and-forget: never block the response on background work
      void flushBackgroundTasks(scope.tasks, options.timeoutMs)
    }
  })
}

/**
 * Drain `tasks` (including tasks scheduled by tasks themselves) with an
 * optional overall wait cap. Mutates `tasks` in place; on timeout the
 * remaining tasks are left to drift, matching production's wait_until
 * timeout behavior.
 */
async function flushBackgroundTasks(tasks: Promise<unknown>[], timeoutMs?: number): Promise<void> {
  if (tasks.length === 0) return
  const drain = (async () => {
    while (tasks.length > 0) {
      const batch = tasks.splice(0)
      await Promise.allSettled(batch)
    }
  })()
  if (timeoutMs === undefined) {
    await drain
    return
  }
  const timedOut = await Promise.race([
    drain.then(() => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
  ])
  if (timedOut) {
    console.warn(`[EdgeRuntime.waitUntil] background tasks did not settle within ${timeoutMs}ms; no longer waiting`)
  }
}
