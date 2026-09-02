import { expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createBackend, type LoadedFunction } from '../src/runtime/index.js'
import { loadProjectConfig } from '../src/runtime/node/load-config.js'
import { loadFunctions } from '../src/runtime/node/load-functions.js'

type Backend = Awaited<ReturnType<typeof createBackend>>

async function withBackend(
  functions: Map<string, Parameters<Backend['functions']['register']>[1]>,
  run: (backend: Backend) => Promise<void>,
  config: { functionEnv?: Record<string, string> } = {}
) {
  const backend = await createBackend({
    startRuntimeServices: false,
    log: () => {},
    functions,
    ...config,
  })
  try {
    await run(backend)
  } finally {
    await backend.close()
  }
}

function invoke(
  backend: Backend,
  path: string,
  init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}
) {
  return backend.fetch(
    new Request(`http://localhost/functions/v1${path}`, {
      method: init.method,
      body: init.body,
      // a streamed body has no content-length and (per undici) needs duplex
      ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
      headers: { apikey: backend.anonKey, authorization: `Bearer ${backend.anonKey}`, ...init.headers },
    } as RequestInit)
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('declared content-length over maxRequestBodyBytes gets a 413', async () => {
  const entry: LoadedFunction = {
    handler: async (req) => new Response(await req.text()),
    limits: { maxRequestBodyBytes: 8 },
  }
  await withBackend(new Map([['limited', entry]]), async (backend) => {
    // Bun does not auto-set content-length for string bodies; declare it explicitly
    const over = await invoke(backend, '/limited', {
      method: 'POST',
      body: 'x'.repeat(100),
      headers: { 'content-length': '100' },
    })
    expect(over.status).toBe(413)
    expect(await over.json()).toEqual({ error: 'function "limited" request body exceeded 8 bytes' })

    const under = await invoke(backend, '/limited', {
      method: 'POST',
      body: 'ok',
      headers: { 'content-length': '2' },
    })
    expect(under.status).toBe(200)
    expect(await under.text()).toBe('ok')
  })
})

test('lengthless streamed body over maxRequestBodyBytes fails the read (500)', async () => {
  const entry: LoadedFunction = {
    handler: async (req) => new Response(await req.text()),
    limits: { maxRequestBodyBytes: 8 },
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(100)))
      controller.close()
    },
  })
  await withBackend(new Map([['limited', entry]]), async (backend) => {
    const res = await invoke(backend, '/limited', { method: 'POST', body })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('request body exceeded 8 bytes')
  })
})

test('timeoutMs aborts a slow invocation with a 504', async () => {
  const entry: LoadedFunction = {
    handler: async () => {
      await sleep(200)
      return new Response('late')
    },
    limits: { timeoutMs: 50 },
  }
  await withBackend(new Map([['slow', entry]]), async (backend) => {
    const res = await invoke(backend, '/slow')
    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({ error: 'function "slow" timed out after 50ms' })
  })
})

test('outboundHosts allows loopback and rejects undeclared hosts', async () => {
  const server: Server = createServer((_req, res) => res.end('pong'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const capabilities = { outboundHosts: ['api.example.com'] }
    const functions = new Map<string, LoadedFunction>([
      [
        'net-ok',
        {
          capabilities,
          handler: async () => new Response(await (await fetch(`http://127.0.0.1:${port}/`)).text()),
        },
      ],
      [
        'net-denied',
        {
          capabilities,
          // rejected by the policy before any network I/O happens
          handler: async () => new Response(await (await fetch('https://example.com/')).text()),
        },
      ],
    ])
    await withBackend(functions, async (backend) => {
      const ok = await invoke(backend, '/net-ok')
      expect(ok.status).toBe(200)
      expect(await ok.text()).toBe('pong')

      const denied = await invoke(backend, '/net-denied')
      expect(denied.status).toBe(500)
      expect((await denied.json()).error).toContain('outbound host not allowed: example.com')
    })
  } finally {
    server.close()
  }
})

test('secrets allowlist limits Deno.env and ctx.env to the base trio + declared keys', async () => {
  const deno = () => (globalThis as unknown as { Deno: { env: { get(k: string): string | undefined } } }).Deno
  const entry: LoadedFunction = {
    capabilities: { secrets: ['MY_KEY'] },
    handler: (_req, ctx) =>
      Response.json({
        denoMyKey: deno().env.get('MY_KEY'),
        denoOther: deno().env.get('OTHER') ?? null,
        denoSupabaseUrl: deno().env.get('SUPABASE_URL'),
        ctxMyKey: ctx.env.MY_KEY,
        ctxOther: ctx.env.OTHER ?? null,
      }),
  }
  await withBackend(
    new Map([['scoped', entry]]),
    async (backend) => {
      const res = await invoke(backend, '/scoped')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.denoMyKey).toBe('x')
      expect(body.denoOther).toBeNull()
      expect(body.denoSupabaseUrl).toBeTruthy()
      expect(body.ctxMyKey).toBe('x')
      expect(body.ctxOther).toBeNull()
    },
    { functionEnv: { MY_KEY: 'x', OTHER: 'y' } }
  )
})

test('functions without limits/capabilities keep the previous behavior', async () => {
  const deno = () => (globalThis as unknown as { Deno: { env: { get(k: string): string | undefined } } }).Deno
  const plain = async (req: Request) => {
    await sleep(100) // no timeout declared: slow is fine
    return Response.json({ body: await req.text(), other: deno().env.get('OTHER') ?? null })
  }
  await withBackend(
    new Map([['plain', plain]]),
    async (backend) => {
      const res = await invoke(backend, '/plain', { method: 'POST', body: 'x'.repeat(4096) })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ body: 'x'.repeat(4096), other: 'y' })
    },
    { functionEnv: { OTHER: 'y' } }
  )
})

test('loadFunctions maps config.toml limits/capabilities onto LoadedFunction', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-fn-limits-'))
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
framework = "elysia"
timeout_ms = 15000
max_request_body_bytes = 1048576
outbound_hosts = ["api.example.com"]
secrets = ["OPENAI_API_KEY"]
`
    )
    const config = loadProjectConfig(projectDir)
    expect(config.functions.api).toMatchObject({
      framework: 'elysia',
      timeoutMs: 15000,
      maxRequestBodyBytes: 1048576,
      outboundHosts: ['api.example.com'],
      secrets: ['OPENAI_API_KEY'],
    })

    const loaded = await loadFunctions(projectDir, config.functions)
    const fn = loaded.get('api')
    expect(fn).toBeDefined()
    expect(fn!.framework).toBe('elysia')
    expect(fn!.limits).toEqual({ timeoutMs: 15000, maxRequestBodyBytes: 1048576 })
    expect(fn!.capabilities).toEqual({ outboundHosts: ['api.example.com'], secrets: ['OPENAI_API_KEY'] })
    expect(typeof fn!.handler).toBe('function')
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})
