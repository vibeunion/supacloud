import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { DEFAULT_AUTH_SETTINGS, type AuthSettings } from '../src/runtime/auth/settings.js'
import { Database } from '../src/runtime/db/database.js'
import { signJwt } from '../src/runtime/jwt.js'

describe('Auth MFA mutation account eligibility', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let settings: AuthSettings
  let userId: string
  let factorId: string
  let challengeId: string
  let accessToken: string
  const secret = 'mfa-mutation-eligibility-secret'.repeat(3)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    userId = (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ('mfa-mutation@example.test', now()) returning id`,
    )).rows[0].id
    factorId = (await db!.query<{ id: string }>(
      `insert into auth.mfa_factors (user_id, friendly_name) values ($1, 'existing') returning id`,
      [userId],
    )).rows[0].id
    challengeId = (await db!.query<{ id: string }>(
      `insert into auth.mfa_challenges (factor_id, expires_at) values ($1, now() + interval '5 minutes') returning id`,
      [factorId],
    )).rows[0].id
    accessToken = await signJwt({
      sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
    }, secret)
    settings = { ...DEFAULT_AUTH_SETTINGS }
    auth = new AuthHandler(db!, {
      jwtSecret: secret, apiUrl: 'http://lite.local', siteUrl: 'http://app.local',
      jwtExpiry: 3600, mailer: new InboxMailer(), rateLimiter: null, settings,
    })
  })

  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  async function invoke(operation: 'enroll' | 'challenge' | 'unenroll'): Promise<Response> {
    const path = operation === 'enroll'
      ? 'factors'
      : operation === 'challenge'
        ? `factors/${factorId}/challenge`
        : `factors/${factorId}`
    const url = new URL(`http://lite.local/auth/v1/${path}`)
    return auth!.handle(new Request(url, {
      method: operation === 'unenroll' ? 'DELETE' : 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: operation === 'enroll' ? JSON.stringify({ factor_type: 'totp', friendly_name: 'new-factor' }) : '{}',
    }), { role: 'anon', claims: null }, url)
  }

  async function snapshot() {
    return {
      user: (await db!.query(
        'select banned_until::text, deleted_at::text from auth.users where id = $1',
        [userId],
      )).rows,
      factors: (await db!.query(
        'select id, friendly_name, status from auth.mfa_factors where user_id = $1 order by id',
        [userId],
      )).rows,
      challenges: (await db!.query(
        'select id, verified_at::text from auth.mfa_challenges where factor_id = $1 order by id',
        [factorId],
      )).rows,
    }
  }

  async function invokeAfterAuthorization(
    operation: 'enroll' | 'challenge' | 'unenroll',
    change: string,
  ): Promise<Response> {
    const original = db!.query.bind(db!)
    const changed = spyOn(db!, 'query').mockImplementationOnce(
      async <T>(sql: string, params?: unknown[]) => {
        const result = await original<T>(sql, params)
        await original(change, [userId])
        return result
      },
    )
    try {
      return await invoke(operation)
    } finally {
      changed.mockRestore()
    }
  }

  for (const operation of ['enroll', 'challenge', 'unenroll'] as const) {
    for (const change of [
      "update auth.users set banned_until = now() + interval '1 hour' where id = $1",
      'update auth.users set deleted_at = now() where id = $1',
    ]) {
      test(`rejects ${operation} when ${change} commits after bearer validation`, async () => {
        const before = await snapshot()
        const response = await invokeAfterAuthorization(operation, change)
        expect(response.status).toBe(401)
        expect(await response.json()).toMatchObject({ error_code: 'no_authorization' })
        expect(await snapshot()).toEqual({
          ...before,
          user: [{ banned_until: change.includes('banned') ? expect.any(String) : null, deleted_at: change.includes('deleted') ? expect.any(String) : null }],
        })
      })
    }
  }

  test('enrolls an eligible factor', async () => {
    const response = await invoke('enroll')
    expect(response.status).toBe(200)
    expect((await db!.query('select count(*)::int as count from auth.mfa_factors where user_id = $1', [userId])).rows)
      .toEqual([{ count: 2 }])
  })

  test('creates a challenge for an eligible factor', async () => {
    const response = await invoke('challenge')
    expect(response.status).toBe(200)
    expect((await db!.query('select count(*)::int as count from auth.mfa_challenges where factor_id = $1', [factorId])).rows)
      .toEqual([{ count: 2 }])
  })

  test('unenrolls an eligible factor', async () => {
    const response = await invoke('unenroll')
    expect(response.status).toBe(200)
    expect((await db!.query('select id from auth.mfa_factors where user_id = $1', [userId])).rows).toEqual([])
  })

  test('serializes enrollment against the maximum factor limit', async () => {
    settings.maxEnrolledFactors = 1
    await db!.query('delete from auth.mfa_factors where id = $1', [factorId])
    const responses = await Promise.all([invoke('enroll'), invoke('enroll')])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 422])
    expect((await db!.query('select count(*)::int as count from auth.mfa_factors where user_id = $1', [userId])).rows)
      .toEqual([{ count: 1 }])
  })

  test('keeps a missing factor as a 404 after locking the eligible user', async () => {
    await db!.query('delete from auth.mfa_factors where id = $1', [factorId])
    const response = await invoke('challenge')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error_code: 'mfa_factor_not_found' })
  })
})
