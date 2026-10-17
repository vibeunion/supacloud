import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { DEFAULT_AUTH_SETTINGS } from '../src/runtime/auth/settings.js'
import { SmsInbox } from '../src/runtime/auth/sms-inbox.js'
import { Database } from '../src/runtime/db/database.js'
import { verifyJwt } from '../src/runtime/jwt.js'

describe('SMS OTP current phone binding', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let inbox: SmsInbox
  let userId: string
  let code: string
  const phone = '+8613800138000'
  const replacement = '+8613900139000'
  const secret = 'phone-binding-test-secret'.repeat(3)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users; delete from auth.phone_otp_cooldowns;')
    userId = (await db!.query<{ id: string }>(
      `insert into auth.users (phone, last_sign_in_at) values ($1, '2000-01-01') returning id`,
      [phone],
    )).rows[0].id
    inbox = new SmsInbox()
    auth = new AuthHandler(db!, {
      jwtSecret: secret, apiUrl: 'http://lite.local', siteUrl: 'http://app.local',
      jwtExpiry: 3600, mailer: new InboxMailer(), smsSender: inbox, rateLimiter: null,
      settings: { ...DEFAULT_AUTH_SETTINGS, smsOtpCooldownSeconds: 0 },
    })
    code = await issue(phone)
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  function request(path: string, body: Record<string, unknown>): Promise<Response> {
    const url = new URL(`http://lite.local/auth/v1/${path}`)
    return auth!.handle(new Request(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { role: 'anon', claims: null }, url)
  }

  async function issue(recipient: string): Promise<string> {
    expect((await request('otp', { phone: recipient })).status).toBe(200)
    const issued = inbox.list()[0]?.code
    if (!issued) throw new Error('Expected a captured SMS OTP')
    return issued
  }

  function verify(token = code, recipient = phone): Promise<Response> {
    return request('verify', { phone: recipient, token, type: 'sms' })
  }

  async function rejected(response: Response): Promise<void> {
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error_code: 'otp_expired' })
  }

  async function snapshot() {
    return {
      users: (await db!.query(
        'select id, phone, phone_confirmed_at::text, last_sign_in_at::text from auth.users order by id',
      )).rows,
      identities: (await db!.query('select id, user_id, identity_data from auth.identities order by id')).rows,
      tokens: (await db!.query('select id, token, attempts from auth.one_time_tokens order by id')).rows,
      sessions: (await db!.query('select token from auth.refresh_tokens')).rows,
    }
  }

  for (const newPhone of [replacement, null]) {
    test(`rejects the old SMS OTP after changing the phone to ${newPhone}`, async () => {
      await db!.query('update auth.users set phone = $1 where id = $2', [newPhone, userId])
      const before = await snapshot()
      await rejected(await verify())
      expect(await snapshot()).toEqual(before)
    })
  }

  test('does not let a reassigned phone authenticate either account with the old OTP', async () => {
    await db!.query('update auth.users set phone = $1 where id = $2', [replacement, userId])
    await db!.query('insert into auth.users (phone) values ($1)', [phone])
    const before = await snapshot()
    await rejected(await verify())
    expect(await snapshot()).toEqual(before)
  })

  test('allows a new OTP for the current phone on the same account', async () => {
    await db!.query('update auth.users set phone = $1 where id = $2', [replacement, userId])
    await rejected(await verify())
    const newCode = await issue(replacement)
    const response = await verify(newCode, replacement)
    expect(response.status).toBe(200)
    const body: { access_token: string; user: { phone: string } } = await response.json()
    expect(await verifyJwt(body.access_token, secret)).toMatchObject({ sub: userId, phone: replacement })
    expect(body.user.phone).toBe(replacement)
    await rejected(await verify())
    expect((await db!.query('select user_id from auth.refresh_tokens')).rows).toEqual([{ user_id: userId }])
  })

  test('allows the current phone OTP once and rejects replay', async () => {
    const response = await verify()
    expect(response.status).toBe(200)
    const body: { access_token: string } = await response.json()
    expect(await verifyJwt(body.access_token, secret)).toMatchObject({ sub: userId, phone })
    await rejected(await verify())
    expect((await db!.query('select token from auth.refresh_tokens')).rows).toHaveLength(1)
  })

  test('preserves the five-wrong-attempt limit', async () => {
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0')
    for (let i = 0; i < 5; i++) await rejected(await verify(wrong))
    expect((await db!.query('select token from auth.one_time_tokens')).rows).toEqual([])
    await rejected(await verify())
  })

  test('preserves expiry rejection', async () => {
    await db!.query("update auth.one_time_tokens set expires_at = now() - interval '1 minute'")
    await rejected(await verify())
    expect((await db!.query('select token from auth.refresh_tokens')).rows).toEqual([])
  })

  for (const state of ["banned_until = now() + interval '1 hour'", 'deleted_at = now()']) {
    test(`keeps existing rejection and token consumption for ${state}`, async () => {
      await db!.query(`update auth.users set ${state} where id = $1`, [userId])
      await rejected(await verify())
      expect((await db!.query('select token from auth.refresh_tokens')).rows).toEqual([])
      expect((await db!.query('select token from auth.one_time_tokens')).rows).toEqual([])
      expect((await db!.query('select phone_confirmed_at from auth.users')).rows).toEqual([{ phone_confirmed_at: null }])
    })
  }

  test('rolls back token and confirmation changes if session insertion fails', async () => {
    const before = await snapshot()
    await db!.exec(`
      create function public.reject_phone_session() returns trigger language plpgsql as $$
        begin raise exception 'Simulated SMS session failure'; end $$;
      create trigger reject_phone_session before insert on auth.refresh_tokens
        for each row execute function public.reject_phone_session();
    `)
    try {
      expect((await verify()).status).toBe(500)
      expect(await snapshot()).toEqual(before)
    } finally {
      await db!.exec('drop trigger reject_phone_session on auth.refresh_tokens; drop function public.reject_phone_session();')
    }
    expect((await verify()).status).toBe(200)
  })

  test('allows only one concurrent redemption on PGlite', async () => {
    const responses = await Promise.all([verify(), verify()])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
    expect((await db!.query('select token from auth.refresh_tokens')).rows).toHaveLength(1)
  })
})
