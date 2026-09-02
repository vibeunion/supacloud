import { expect, test } from 'bun:test'
import {
  createBackend,
  isFrameworkRouterHandler,
  signJwt,
  toFunctionLocalUrl,
  VERIFIED_JWT_SUBJECT_HEADER,
  type FrameworkObjectHandler,
} from '../src/runtime/index.js'

type Backend = Awaited<ReturnType<typeof createBackend>>

async function withBackend(
  functions: Map<string, Parameters<Backend['functions']['register']>[1]>,
  run: (backend: Backend) => Promise<void>
) {
  const backend = await createBackend({
    startRuntimeServices: false,
    log: () => {},
    functions,
  })
  try {
    await run(backend)
  } finally {
    await backend.close()
  }
}

function invoke(backend: Backend, path: string) {
  return backend.fetch(new Request(`http://localhost/functions/v1${path}`, {
    headers: { apikey: backend.anonKey, authorization: `Bearer ${backend.anonKey}` },
  }))
}

function invokeWithHeaders(backend: Backend, path: string, headers: HeadersInit) {
  return backend.fetch(new Request(`http://localhost/functions/v1${path}`, { headers }))
}

test('toFunctionLocalUrl strips the function prefix', () => {
  expect(toFunctionLocalUrl('http://localhost/functions/v1/api/cases/42?x=1')).toBe(
    'http://localhost/cases/42?x=1'
  )
  expect(toFunctionLocalUrl('http://localhost/functions/v1/api')).toBe('http://localhost/')
  expect(toFunctionLocalUrl('http://localhost/functions/v1/api/')).toBe('http://localhost/')
})

test('isFrameworkRouterHandler detects router objects and markers', () => {
  expect(isFrameworkRouterHandler({ handle: () => new Response() })).toBe(true)
  expect(isFrameworkRouterHandler({ fetch: () => new Response(), routes: [] })).toBe(true)
  expect(isFrameworkRouterHandler({ fetch: () => new Response() })).toBe(false)
  expect(isFrameworkRouterHandler({ __supacloud: { routeAware: true } })).toBe(true)
  expect(isFrameworkRouterHandler(() => new Response())).toBe(false)
  expect(isFrameworkRouterHandler(null)).toBe(false)
})

test('elysia-style handle() object receives the function-local URL', async () => {
  const seen: string[] = []
  const elysiaLike: FrameworkObjectHandler = {
    handle: (req) => {
      seen.push(new URL(req.url).pathname + new URL(req.url).search)
      if (new URL(req.url).pathname === '/cases/42') return Response.json({ ok: true })
      return Response.json({ error: 'not found' }, { status: 404 })
    },
  }

  await withBackend(new Map([['api', elysiaLike]]), async (backend) => {
    const res = await invoke(backend, '/api/cases/42?debug=1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(seen).toEqual(['/cases/42?debug=1'])

    const missing = await invoke(backend, '/api/nope')
    expect(missing.status).toBe(404)
  })
})

test('elysia-style handle() object sees / for the function root', async () => {
  const seen: string[] = []
  const elysiaLike: FrameworkObjectHandler = {
    handle: (req) => {
      seen.push(new URL(req.url).pathname)
      return Response.json({ ok: true })
    },
  }

  await withBackend(new Map([['api', elysiaLike]]), async (backend) => {
    const res = await invoke(backend, '/api')
    expect(res.status).toBe(200)
    expect(seen).toEqual(['/'])
  })
})

test('plain { fetch } objects keep the legacy unrouted URL (back-compat)', async () => {
  const seen: string[] = []
  const fetchObject: FrameworkObjectHandler = {
    fetch: (req) => {
      seen.push(new URL(req.url).pathname)
      return Response.json({ ok: true })
    },
  }

  await withBackend(new Map([['legacy', fetchObject]]), async (backend) => {
    const res = await invoke(backend, '/legacy/sub/path')
    expect(res.status).toBe(200)
    expect(seen).toEqual(['/functions/v1/legacy/sub/path'])
  })
})

test('plain function handlers keep the legacy URL and FunctionContext', async () => {
  const seen: string[] = []
  await withBackend(
    new Map([
      [
        'plain',
        (req: Request, ctx: { auth: { role: string } }) => {
          seen.push(new URL(req.url).pathname)
          return Response.json({ role: ctx.auth.role })
        },
      ],
    ]),
    async (backend) => {
      const res = await invoke(backend, '/plain/x')
      expect(res.status).toBe(200)
      expect(seen).toEqual(['/functions/v1/plain/x'])
    }
  )
})

test('route-aware marker opts an object handler into function-local URLs', async () => {
  const seen: string[] = []
  const marked: FrameworkObjectHandler = {
    __supacloud: { routeAware: true },
    fetch: (req) => {
      seen.push(new URL(req.url).pathname)
      return Response.json({ ok: true })
    },
  }

  await withBackend(new Map([['marked', marked]]), async (backend) => {
    const res = await invoke(backend, '/marked/things/7')
    expect(res.status).toBe(200)
    expect(seen).toEqual(['/things/7'])
  })
})

test('explicit framework entry rewrites URLs even without router shape', async () => {
  const seen: string[] = []
  const entry = {
    framework: 'elysia' as const,
    handler: (req: Request) => {
      seen.push(new URL(req.url).pathname)
      return Response.json({ ok: true })
    },
  }

  await withBackend(new Map([['declared', entry]]), async (backend) => {
    const res = await invoke(backend, '/declared/cases')
    expect(res.status).toBe(200)
    expect(seen).toEqual(['/cases'])
  })
})

test('forwards only the subject from a verified user JWT', async () => {
  const seen: Array<string | null> = []
  const handlers = new Map<string, Parameters<Backend['functions']['register']>[1]>([
    ['plain', (req: Request) => {
      seen.push(req.headers.get(VERIFIED_JWT_SUBJECT_HEADER))
      return Response.json({ ok: true })
    }],
    ['router', {
      handle: (req: Request) => {
        seen.push(req.headers.get(VERIFIED_JWT_SUBJECT_HEADER))
        return Response.json({ ok: true })
      },
    }],
  ])

  await withBackend(handlers, async (backend) => {
    const token = await signJwt({ role: 'authenticated', sub: 'user-42' }, backend.jwtSecret)
    for (const path of ['/plain', '/router']) {
      const res = await invokeWithHeaders(backend, path, {
        apikey: backend.anonKey,
        authorization: `Bearer ${token}`,
        [VERIFIED_JWT_SUBJECT_HEADER]: 'spoofed-user',
      })
      expect(res.status).toBe(200)
    }
  })

  expect(seen).toEqual(['user-42', 'user-42'])
})

test('removes spoofed verified-subject headers from unverified function requests', async () => {
  const seen: Array<string | null> = []
  const handler = (req: Request) => {
    seen.push(req.headers.get(VERIFIED_JWT_SUBJECT_HEADER))
    return Response.json({ ok: true })
  }
  const backend = await createBackend({
    startRuntimeServices: false,
    log: () => {},
    functions: new Map([
      ['apikey', handler],
      ['public', handler],
    ]),
    functionVerifyJwt: { public: false },
  })
  try {
    const apikeyRes = await invokeWithHeaders(backend, '/apikey', {
      apikey: backend.anonKey,
      authorization: `Bearer ${backend.anonKey}`,
      [VERIFIED_JWT_SUBJECT_HEADER]: 'spoofed-user',
    })
    expect(apikeyRes.status).toBe(200)

    const publicRes = await invokeWithHeaders(backend, '/public', {
      [VERIFIED_JWT_SUBJECT_HEADER]: 'spoofed-user',
    })
    expect(publicRes.status).toBe(200)
  } finally {
    await backend.close()
  }

  expect(seen).toEqual([null, null])
})

test('framework fetch entry does not rewrite URLs', async () => {
  const seen: string[] = []
  const entry = {
    framework: 'fetch' as const,
    handler: (req: Request) => {
      seen.push(new URL(req.url).pathname)
      return Response.json({ ok: true })
    },
  }

  await withBackend(new Map([['plain', entry]]), async (backend) => {
    const res = await invoke(backend, '/plain/x')
    expect(res.status).toBe(200)
    expect(seen).toEqual(['/functions/v1/plain/x'])
  })
})

test('unknown functions still 404 and throwing handlers still 500', async () => {
  await withBackend(
    new Map([
      [
        'boom',
        () => {
          throw new Error('kaboom')
        },
      ],
    ]),
    async (backend) => {
      const missing = await invoke(backend, '/nope')
      expect(missing.status).toBe(404)

      const failure = await invoke(backend, '/boom')
      expect(failure.status).toBe(500)
      expect(await failure.json()).toEqual({ error: 'kaboom' })
    }
  )
})
