import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackend, type LoadedFunction } from '../src/runtime/index.js'
import { loadProjectConfig } from '../src/runtime/node/load-config.js'
import { loadFunctions } from '../src/runtime/node/load-functions.js'
import { testTimeout } from './helpers/timeouts.js'

type Backend = Awaited<ReturnType<typeof createBackend>>

async function withBackend(
  functions: Map<string, Parameters<Backend['functions']['register']>[1]>,
  run: (backend: Backend) => Promise<void>
) {
  const backend = await createBackend({ startRuntimeServices: false, log: () => {}, functions })
  try {
    await run(backend)
  } finally {
    await backend.close()
  }
}

function invoke(backend: Backend, path: string) {
  return backend.fetch(
    new Request(`http://localhost/functions/v1${path}`, {
      headers: { apikey: backend.anonKey, authorization: `Bearer ${backend.anonKey}` },
    })
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const edgeRuntime = () => (globalThis as unknown as { EdgeRuntime: { waitUntil(p: unknown): void } }).EdgeRuntime

/** Poll `cond` until it holds; background tasks settle off the response path. */
async function eventually(cond: () => boolean, budgetMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for background task')
    await sleep(10)
  }
}

test(
  'response with content-length over maxResponseBodyBytes is replaced with a 502',
  async () => {
    const entry: LoadedFunction = {
      handler: () => new Response('x'.repeat(100), { headers: { 'content-length': '100' } }),
      limits: { maxResponseBodyBytes: 8 },
    }
    await withBackend(new Map([['big', entry]]), async (backend) => {
      const res = await invoke(backend, '/big')
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'function "big" response exceeded 8 bytes' })
    })
  },
  testTimeout(15_000)
)

test(
  'streamed response over maxResponseBodyBytes fails the read',
  async () => {
    const entry: LoadedFunction = {
      handler: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('x'.repeat(100)))
              controller.close()
            },
          })
        ),
      limits: { maxResponseBodyBytes: 8 },
    }
    await withBackend(new Map([['big-stream', entry]]), async (backend) => {
      const res = await invoke(backend, '/big-stream')
      // the status line was committed before the limit tripped
      expect(res.status).toBe(200)
      await expect(res.text()).rejects.toThrow('function "big-stream" response exceeded 8 bytes')
    })
  },
  testTimeout(15_000)
)

test(
  'response within maxResponseBodyBytes streams through untouched',
  async () => {
    const entry: LoadedFunction = {
      handler: () => new Response('ok'),
      limits: { maxResponseBodyBytes: 8 },
    }
    await withBackend(new Map([['small', entry]]), async (backend) => {
      const res = await invoke(backend, '/small')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('ok')
    })
  },
  testTimeout(15_000)
)

test(
  'EdgeRuntime.waitUntil is allowed by default and runs past the response',
  async () => {
    const done: string[] = []
    const entry: LoadedFunction = {
      handler: () => {
        edgeRuntime().waitUntil(sleep(50).then(() => done.push('ran')))
        return new Response('first')
      },
    }
    await withBackend(new Map([['bg', entry]]), async (backend) => {
      const res = await invoke(backend, '/bg')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('first')
      // the task is still in flight when the response lands
      expect(done).toEqual([])
      await eventually(() => done.length === 1)
      expect(done).toEqual(['ran'])
    })
  },
  testTimeout(15_000)
)

test(
  'background = false gates EdgeRuntime.waitUntil like production',
  async () => {
    const entry: LoadedFunction = {
      capabilities: { background: false },
      handler: () => {
        edgeRuntime().waitUntil(Promise.resolve())
        return new Response('unreachable')
      },
    }
    await withBackend(new Map([['no-bg', entry]]), async (backend) => {
      const res = await invoke(backend, '/no-bg')
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({
        error: 'EdgeRuntime.waitUntil is not enabled by the Function capability policy',
      })
    })
  },
  testTimeout(15_000)
)

test(
  'waitUntilTimeoutMs stops waiting on slow tasks without blocking the response',
  async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
    try {
      const done: string[] = []
      const entry: LoadedFunction = {
        limits: { waitUntilTimeoutMs: 50 },
        handler: () => {
          edgeRuntime().waitUntil(sleep(500).then(() => done.push('late')))
          return new Response('fast')
        },
      }
      await withBackend(new Map([['slow-bg', entry]]), async (backend) => {
        const res = await invoke(backend, '/slow-bg')
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('fast')
        await eventually(() => warnings.length > 0)
        expect(warnings[0]).toContain('did not settle within 50ms')
      })
    } finally {
      console.warn = originalWarn
    }
  },
  testTimeout(15_000)
)

test(
  'tasks scheduled from within a background task are tracked too',
  async () => {
    const done: string[] = []
    const entry: LoadedFunction = {
      handler: () => {
        edgeRuntime().waitUntil(
          sleep(30).then(() => {
            done.push('outer')
            edgeRuntime().waitUntil(sleep(30).then(() => done.push('inner')))
          })
        )
        return new Response('ok')
      },
    }
    await withBackend(new Map([['nested', entry]]), async (backend) => {
      const res = await invoke(backend, '/nested')
      expect(res.status).toBe(200)
      await res.text()
      await eventually(() => done.length === 2)
      expect(done).toEqual(['outer', 'inner'])
    })
  },
  testTimeout(15_000)
)

test(
  'loadFunctions maps config.toml response/waitUntil limits and background onto LoadedFunction',
  async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-fn-bg-'))
    try {
      await mkdir(join(projectDir, 'supabase', 'functions', 'api'), { recursive: true })
      await writeFile(
        join(projectDir, 'supabase', 'functions', 'api', 'index.ts'),
        `export default () => new Response('ok')`
      )
      await writeFile(
        join(projectDir, 'supabase', 'config.toml'),
        `
[functions.api]
max_response_body_bytes = 524288
wait_until_timeout_ms = 2000
background = false
`
      )
      const config = loadProjectConfig(projectDir)
      expect(config.functions.api).toMatchObject({
        maxResponseBodyBytes: 524288,
        waitUntilTimeoutMs: 2000,
        background: false,
      })

      const loaded = await loadFunctions(projectDir, config.functions)
      const fn = loaded.get('api')
      expect(fn).toBeDefined()
      expect(fn!.limits).toEqual({ maxResponseBodyBytes: 524288, waitUntilTimeoutMs: 2000 })
      expect(fn!.capabilities).toEqual({ background: false })
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  },
  testTimeout(15_000)
)
