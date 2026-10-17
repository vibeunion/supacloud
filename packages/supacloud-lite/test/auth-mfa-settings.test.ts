import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { DEFAULT_AUTH_SETTINGS, type AuthSettings } from '../src/runtime/auth/settings.js'
import { Database } from '../src/runtime/db/database.js'
import { totpNow } from '../src/runtime/auth/totp.js'
import { signJwt, verifyJwt } from '../src/runtime/jwt.js'

describe('Auth MFA settings', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let userId: string
  let factorId: string
  let challengeId: string
  let accessToken: string
  let settings: AuthSettings
  const secret = 'mfa-settings-test-secret'.repeat(3)
  const totpSecret = 'JBSWY3DPEHPK3PXP'

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    userId = (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ('mfa-settings@example.test', now()) returning id`,
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
    }, secret)
    settings = { ...DEFAULT_AUTH_SETTINGS }
    auth = new AuthHandler(db!, {
      jwtSecret: secret, apiUrl: 'http://lite.local', siteUrl: 'http://app.local',
      jwtExpiry: 3600, mailer: new InboxMailer(), rateLimiter: null,
      settings,
    })
  })

  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  async function invoke(action = 'verify', bearer = accessToken): Promise<Response> {
    const url = new URL(`http://lite.local/auth/v1/factors/${factorId}/${action}`)
    return auth!.handle(new Request(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ challenge_id: challengeId, code: await totpNow(totpSecret) }),
    }), { role: 'anon', claims: null }, url)
  }

  for (const status of ['unverified', 'verified']) {
    test(`rejects an existing challenge for a ${status} factor when verification is disabled`, async () => {
      await db!.query('update auth.mfa_factors set status = $1 where id = $2', [status, factorId])
      settings.totpVerifyEnabled = false
      const response = await invoke()
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ error_code: 'mfa_totp_verify_disabled' })
      expect((await db!.query('select verified_at from auth.mfa_challenges')).rows).toEqual([{ verified_at: null }])
      expect((await db!.query('select status from auth.mfa_factors')).rows).toEqual([{ status }])
      expect((await db!.query('select token from auth.refresh_tokens')).rows).toEqual([])
    })
  }

  test('keeps challenge creation disabled by the same setting', async () => {
    settings.totpVerifyEnabled = false
    const response = await invoke('challenge')
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error_code: 'mfa_totp_verify_disabled' })
    expect((await db!.query('select id from auth.mfa_challenges')).rows).toEqual([{ id: challengeId }])
  })

  test('allows the preserved challenge after verification is re-enabled without restarting', async () => {
    settings.totpVerifyEnabled = false
    expect((await invoke()).status).toBe(422)
    settings.totpVerifyEnabled = true
    const response = await invoke()
    expect(response.status).toBe(200)
    const body: { access_token: string } = await response.json()
    expect(await verifyJwt(body.access_token, secret)).toMatchObject({ sub: userId, aal: 'aal2' })
    expect((await invoke()).status).toBe(422)
    expect((await db!.query('select token from auth.refresh_tokens')).rows).toHaveLength(1)
  })

  test('keeps enrollment and verification settings independent', async () => {
    settings.totpEnrollEnabled = false
    expect((await invoke()).status).toBe(200)
    expect((await db!.query('select status from auth.mfa_factors')).rows).toEqual([{ status: 'verified' }])
  })

  test('retains bearer authorization before reporting a disabled provider', async () => {
    settings.totpVerifyEnabled = false
    const response = await invoke('verify', 'invalid')
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error_code: 'no_authorization' })
  })
})
