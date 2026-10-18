import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database, type Querier } from '../src/runtime/db/database.js'
import { totpNow } from '../src/runtime/auth/totp.js'
import { signJwt, verifyJwt } from '../src/runtime/jwt.js'

describe('Auth MFA verification state binding', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let userId: string
  let factorId: string
  let challengeId: string
  let accessToken: string
  const jwtSecret = 'mfa-verify-state-secret'.repeat(3)
  const originalSecret = 'JBSWY3DPEHPK3PXP'
  const replacementSecret = 'KRUGS4ZANFZSAYJA'

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    userId = (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ('mfa-state@example.test', now()) returning id`,
    )).rows[0].id
    factorId = (await db!.query<{ id: string }>(
      `insert into auth.mfa_factors (user_id, secret) values ($1, $2) returning id`,
      [userId, originalSecret],
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

  async function verify(): Promise<Response> {
    const url = new URL(`http://lite.local/auth/v1/factors/${factorId}/verify`)
    return auth!.handle(new Request(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ challenge_id: challengeId, code: await totpNow(originalSecret) }),
    }), { role: 'anon', claims: null }, url)
  }

  async function snapshot() {
    return {
      factors: (await db!.query('select secret, status from auth.mfa_factors where id = $1', [factorId])).rows,
      challenges: (await db!.query('select verified_at::text from auth.mfa_challenges where id = $1', [challengeId])).rows,
      sessions: (await db!.query('select token from auth.refresh_tokens')).rows,
    }
  }

  test('rechecks the current factor secret before claiming the challenge', async () => {
    const before = await snapshot()
    const original = db!.transaction.bind(db!)
    const changed = spyOn(db!, 'transaction').mockImplementationOnce(
      async <T>(fn: (query: Querier) => Promise<T>): Promise<T> => {
        await db!.query('update auth.mfa_factors set secret = $1 where id = $2', [replacementSecret, factorId])
        return original(fn)
      },
    )
    try {
      const response = await verify()
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ error_code: 'mfa_verification_failed' })
      expect(await snapshot()).toEqual({
        factors: [{ secret: replacementSecret, status: 'unverified' }],
        challenges: before.challenges,
        sessions: before.sessions,
      })
    } finally {
      changed.mockRestore()
    }
  })

  test('issues one AAL2 session for the current factor secret', async () => {
    const response = await verify()
    expect(response.status).toBe(200)
    const body: { access_token: string } = await response.json()
    expect(await verifyJwt(body.access_token, jwtSecret)).toMatchObject({ sub: userId, aal: 'aal2' })
    expect((await db!.query('select status from auth.mfa_factors')).rows).toEqual([{ status: 'verified' }])
    expect((await db!.query('select verified_at from auth.mfa_challenges')).rows[0]?.verified_at).not.toBeNull()
    expect((await db!.query('select token from auth.refresh_tokens')).rows).toHaveLength(1)
  })
})
