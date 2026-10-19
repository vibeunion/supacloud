import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { totpNow } from '../src/runtime/auth/totp.js'
import { Database, type Querier } from '../src/runtime/db/database.js'
import { signJwt, verifyJwt } from '../src/runtime/jwt.js'

describe('Bearer Auth endpoint account eligibility', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let userId: string
  let factorId: string
  let challengeId: string
  let accessToken: string
  const jwtSecret = 'bearer-eligibility-secret'.repeat(3)
  const totpSecret = 'JBSWY3DPEHPK3PXP'
  const operations = ['read-user', 'update-user', 'enroll', 'challenge', 'verify', 'unenroll'] as const
  type Operation = typeof operations[number]

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    userId = (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ('bearer@example.test', now()) returning id`,
    )).rows[0].id
    factorId = (await db!.query<{ id: string }>(
      `insert into auth.mfa_factors (user_id, secret) values ($1, $2) returning id`,
      [userId, totpSecret],
    )).rows[0].id
    challengeId = (await db!.query<{ id: string }>(
      `insert into auth.mfa_challenges (factor_id, expires_at) values ($1, now() + interval '5 minutes') returning id`,
      [factorId],
    )).rows[0].id
    accessToken = await signJwt({
      sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
    }, jwtSecret)
    auth = new AuthHandler(db!, {
      jwtSecret, apiUrl: 'http://lite.local', siteUrl: 'http://app.local',
      jwtExpiry: 3600, mailer: new InboxMailer(), rateLimiter: null,
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  async function invoke(operation: Operation, bearer = accessToken): Promise<Response> {
    const requests: Record<Operation, { path: string; method: string; body?: Record<string, unknown> }> = {
      'read-user': { path: 'user', method: 'GET' },
      'update-user': {
        path: 'user', method: 'PUT',
        body: { email: 'changed@example.test', password: 'new-password-123', data: { changed: true } },
      },
      enroll: { path: 'factors', method: 'POST', body: { factor_type: 'totp', friendly_name: 'new-factor' } },
      challenge: { path: `factors/${factorId}/challenge`, method: 'POST', body: {} },
      verify: { path: `factors/${factorId}/verify`, method: 'POST', body: { challenge_id: challengeId, code: await totpNow(totpSecret) } },
      unenroll: { path: `factors/${factorId}`, method: 'DELETE' },
    }
    const selected = requests[operation]
    const url = new URL(`http://lite.local/auth/v1/${selected.path}`)
    return auth!.handle(new Request(url, {
      method: selected.method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      ...(selected.body ? { body: JSON.stringify(selected.body) } : {}),
    }), { role: 'anon', claims: null }, url)
  }

  async function snapshot() {
    return {
      users: (await db!.query('select email, encrypted_password, raw_user_meta_data, updated_at::text from auth.users')).rows,
      factors: (await db!.query('select id, status, secret, updated_at::text from auth.mfa_factors order by id')).rows,
      challenges: (await db!.query('select id, verified_at::text from auth.mfa_challenges order by id')).rows,
      sessions: (await db!.query('select token from auth.refresh_tokens')).rows,
    }
  }

  for (const state of [
    { name: 'banned', sql: "banned_until = now() + interval '1 hour'" },
    { name: 'indefinitely banned', sql: "banned_until = 'infinity'" },
    { name: 'soft-deleted', sql: 'deleted_at = now()' },
  ]) {
    for (const operation of operations) {
      test(`rejects ${operation} for a ${state.name} account with an existing JWT`, async () => {
        await db!.query(`update auth.users set ${state.sql} where id = $1`, [userId])
        const before = await snapshot()
        const response = await invoke(operation)
        expect(response.status).toBe(401)
        expect(await response.json()).toMatchObject({ error_code: 'no_authorization' })
        expect(await snapshot()).toEqual(before)
      })
    }
  }

  for (const operation of operations) {
    test(`allows ${operation} for an eligible account`, async () => {
      const response = await invoke(operation)
      expect(response.status).toBe(200)
      const body: Record<string, unknown> = await response.json()
      if (operation === 'verify') {
        if (typeof body.access_token !== 'string') throw new Error('Expected MFA session')
        expect(await verifyJwt(body.access_token, jwtSecret)).toMatchObject({ sub: userId, aal: 'aal2' })
        expect((await db!.query('select status from auth.mfa_factors')).rows).toEqual([{ status: 'verified' }])
      } else if (operation === 'update-user') {
        expect(body.email).toBe('changed@example.test')
        expect((await db!.query('select raw_user_meta_data from auth.users')).rows).toEqual([{ raw_user_meta_data: { changed: true } }])
      } else if (operation === 'read-user') {
        expect(body.id).toBe(userId)
      } else if (operation === 'enroll') {
        expect((await db!.query('select id from auth.mfa_factors')).rows).toHaveLength(2)
      } else if (operation === 'challenge') {
        expect((await db!.query('select id from auth.mfa_challenges')).rows).toHaveLength(2)
      } else {
        expect((await db!.query('select id from auth.mfa_factors')).rows).toEqual([])
      }
    })
  }

  test('allows the existing JWT after a ban expires or is cleared', async () => {
    await db!.query(`update auth.users set banned_until = now() - interval '1 hour' where id = $1`, [userId])
    expect((await invoke('read-user')).status).toBe(200)
    await db!.query(`update auth.users set banned_until = now() + interval '1 hour' where id = $1`, [userId])
    expect((await invoke('read-user')).status).toBe(401)
    await db!.query('update auth.users set banned_until = null where id = $1', [userId])
    expect((await invoke('read-user')).status).toBe(200)
  })

  test('keeps invalid JWT rejection', async () => {
    expect((await invoke('read-user', `${accessToken}invalid`)).status).toBe(401)
  })

  for (const update of ["banned_until = now() + interval '1 hour'", 'deleted_at = now()']) {
    test(`rechecks ${update} inside the MFA issuance transaction`, async () => {
      const before = await snapshot()
      const original = db!.transaction.bind(db!)
      const changed = spyOn(db!, 'transaction').mockImplementationOnce(
        async <T>(fn: (query: Querier) => Promise<T>): Promise<T> => {
          await db!.query(`update auth.users set ${update} where id = $1`, [userId])
          return original(fn)
        },
      )
      try {
        const response = await invoke('verify')
        expect(response.status).toBe(422)
        expect(await response.json()).toMatchObject({ error_code: 'mfa_verification_failed' })
        expect(await snapshot()).toEqual(before)
      } finally {
        changed.mockRestore()
      }
    })
  }

  test('keeps MFA challenges single-use', async () => {
    expect((await invoke('verify')).status).toBe(200)
    expect((await invoke('verify')).status).toBe(422)
    expect((await db!.query('select token from auth.refresh_tokens')).rows).toHaveLength(1)
  })

  test('requires an AAL2 token to unenroll a verified factor', async () => {
    await db!.query('update auth.mfa_factors set status = $1 where id = $2', ['verified', factorId])
    const before = await snapshot()
    const rejected = await invoke('unenroll')
    expect(rejected.status).toBe(403)
    expect(await rejected.json()).toMatchObject({ error_code: 'insufficient_aal' })
    expect(await snapshot()).toEqual(before)

    const aal2Token = await signJwt({
      sub: userId, role: 'authenticated', aal: 'aal2',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, jwtSecret)
    expect((await invoke('unenroll', aal2Token)).status).toBe(200)
    expect((await db!.query('select id from auth.mfa_factors')).rows).toEqual([])
  })

  for (const change of [
    "update auth.users set banned_until = now() + interval '1 hour' where id = $1",
    "update auth.users set banned_until = 'infinity' where id = $1",
    'update auth.users set deleted_at = now() where id = $1',
    'delete from auth.users where id = $1',
  ]) {
    test(`rejects a user update when ${change} commits before the write`, async () => {
      const original = db!.transaction.bind(db!)
      let afterChange: Awaited<ReturnType<typeof snapshot>> | undefined
      let identities: unknown[] | undefined
      const changed = spyOn(db!, 'transaction').mockImplementationOnce(
        async <T>(fn: (query: Querier) => Promise<T>): Promise<T> => {
          await db!.query(change, [userId])
          afterChange = await snapshot()
          identities = (await db!.query('select * from auth.identities')).rows
          return original(fn)
        },
      )
      try {
        const response = await invoke('update-user')
        expect(response.status).toBe(401)
        expect(await response.json()).toMatchObject({ error_code: 'no_authorization' })
        if (!afterChange || !identities) throw new Error('Expected account change snapshots before the write')
        expect(await snapshot()).toEqual(afterChange)
        expect((await db!.query('select * from auth.identities')).rows).toEqual(identities)
      } finally {
        changed.mockRestore()
      }
    })
  }

  test('still upgrades an eligible anonymous user and creates its email identity', async () => {
    await db!.query('update auth.users set is_anonymous = true where id = $1', [userId])
    const response = await invoke('update-user')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: userId, is_anonymous: false,
      app_metadata: { provider: 'email', providers: ['email'] },
      identities: [expect.objectContaining({ provider: 'email' })],
    })
  })

  test('does not overwrite provider metadata when an anonymous account became permanent before the write', async () => {
    await db!.query('update auth.users set is_anonymous = true where id = $1', [userId])
    const original = db!.transaction.bind(db!)
    const changed = spyOn(db!, 'transaction').mockImplementationOnce(
      async <T>(fn: (query: Querier) => Promise<T>): Promise<T> => {
        await db!.query(
          `update auth.users set is_anonymous = false,
           raw_app_meta_data = '{"provider":"google","providers":["google","email"]}' where id = $1`,
          [userId],
        )
        return original(fn)
      },
    )
    try {
      const response = await invoke('update-user')
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        is_anonymous: false, app_metadata: { provider: 'google', providers: ['google', 'email'] },
      })
    } finally {
      changed.mockRestore()
    }
  })
})
