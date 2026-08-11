import { afterEach, describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend, type SmsSender, type SupaCloudLiteBackend } from '../src/index.js'

const backends: SupaCloudLiteBackend[] = []

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()))
})

function clientFor(backend: SupaCloudLiteBackend) {
  return createClient('http://local', backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: backend.fetch },
  })
}

function smsCode(backend: SupaCloudLiteBackend): string {
  const smsInbox = (backend as SupaCloudLiteBackend & {
    smsInbox: { list(): Array<{ code: string | null }> } | null
  }).smsInbox
  const code = smsInbox?.list()[0]?.code
  expect(code).toMatch(/^\d{6}$/)
  return code!
}

function differentOtp(code: string, offset = 1): string {
  const modulus = 10 ** code.length
  return String((Number(code) + offset) % modulus).padStart(code.length, '0')
}

describe('phone OTP compatibility', () => {
  test('signs a new phone user in through the official auth-js contract', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      authSettings: { smsOtpCooldownSeconds: 0 },
      log: () => {},
    } as Parameters<typeof createLiteBackend>[0])
    backends.push(backend)
    const client = clientFor(backend)

    const settings = await backend.fetch('http://local/auth/v1/settings', {
      headers: { apikey: backend.anonKey },
    })
    expect((await settings.json()) as { external: { phone: boolean } }).toMatchObject({
      external: { phone: true },
    })

    const sent = await client.auth.signInWithOtp({ phone: '+8613800138000' })
    expect(sent.error).toBeNull()
    expect(sent.data).toEqual({ user: null, session: null, messageId: undefined })

    const verified = await client.auth.verifyOtp({
      phone: '+8613800138000',
      token: smsCode(backend),
      type: 'sms',
    })
    expect(verified.error).toBeNull()
    expect(verified.data.user?.phone).toBe('+8613800138000')
    expect(verified.data.user?.phone_confirmed_at).toBeString()
    expect(verified.data.session?.refresh_token).toBeString()
  })

  test('stores a keyed digest instead of the raw SMS code or phone number in logs', async () => {
    const logs: string[] = []
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      authSettings: { smsOtpCooldownSeconds: 0 },
      log: (message) => logs.push(message),
    } as Parameters<typeof createLiteBackend>[0])
    backends.push(backend)

    const sent = await clientFor(backend).auth.signInWithOtp({ phone: '+8613900139000' })
    expect(sent.error).toBeNull()
    const code = smsCode(backend)
    const rows = await backend.db.query<{ token: string; phone: string }>(
      `select token, phone from auth.one_time_tokens where phone is not null`
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.token).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/)
    expect(rows.rows[0]?.token).not.toContain(code)
    expect(logs.join('\n')).not.toContain(code)
    expect(logs.join('\n')).not.toContain('+8613900139000')
  })

  test('rejects malformed E.164 numbers and unsupported WhatsApp delivery', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      authSettings: { smsOtpCooldownSeconds: 0 },
      log: () => {},
    } as Parameters<typeof createLiteBackend>[0])
    backends.push(backend)
    const client = clientFor(backend)

    const malformed = await client.auth.signInWithOtp({ phone: '13800138000' })
    expect(malformed.error?.code).toBe('validation_failed')

    const whatsapp = await client.auth.signInWithOtp({
      phone: '+8613800138000',
      options: { channel: 'whatsapp' },
    })
    expect(whatsapp.error?.code).toBe('unsupported_channel')
  })

  test('keeps an existing phone user stable and does not overwrite authenticated metadata', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 0 }, log: () => {},
    })
    backends.push(backend)
    const firstClient = clientFor(backend)
    expect((await firstClient.auth.signInWithOtp({
      phone: '+8613700137000', options: { data: { display_name: 'first' } },
    })).error).toBeNull()
    const first = await firstClient.auth.verifyOtp({ phone: '+8613700137000', token: smsCode(backend), type: 'sms' })
    expect(first.error).toBeNull()

    const secondClient = clientFor(backend)
    expect((await secondClient.auth.signInWithOtp({
      phone: '+8613700137000', options: { data: { display_name: 'attacker' } },
    })).error).toBeNull()
    const second = await secondClient.auth.verifyOtp({ phone: '+8613700137000', token: smsCode(backend), type: 'sms' })
    expect(second.error).toBeNull()
    expect(second.data.user?.id).toBe(first.data.user?.id)
    expect(second.data.user?.user_metadata).toEqual({ display_name: 'first' })
  })

  test.each([
    ['banned', '+8613700237000', `banned_until = now() + interval '1 hour'`],
    ['soft-deleted', '+8613700337000', 'deleted_at = now()'],
  ] as const)('does not issue or redeem challenges for a %s phone user', async (_state, phone, ineligibleUpdate) => {
    const messages: string[] = []
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 0 },
      smsSender: { async send(message) { messages.push(message.body) } }, log: () => {},
    })
    backends.push(backend)
    const client = clientFor(backend)

    expect((await client.auth.signInWithOtp({ phone })).error).toBeNull()
    const code = messages[0]?.match(/\b\d{6,10}\b/)?.[0]
    expect(code).toBeString()
    await backend.db.query(`update auth.users set ${ineligibleUpdate} where phone = $1`, [phone])

    const verified = await client.auth.verifyOtp({ phone, token: code!, type: 'sms' })
    expect(verified.error?.code).toBe('otp_expired')
    expect(verified.data.session).toBeNull()
    expect((await backend.db.query(
      `select 1 from auth.refresh_tokens rt join auth.users u on u.id = rt.user_id where u.phone = $1`,
      [phone]
    )).rows).toHaveLength(0)

    expect((await client.auth.signInWithOtp({ phone })).error).toBeNull()
    expect(messages).toHaveLength(1)
    expect((await backend.db.query(`select 1 from auth.one_time_tokens where phone = $1`, [phone])).rows).toHaveLength(0)
  })

  test('keeps unknown create_user=false requests enumeration-safe without creating or sending', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 0 }, log: () => {},
    })
    backends.push(backend)
    const result = await clientFor(backend).auth.signInWithOtp({
      phone: '+8613600136000', options: { shouldCreateUser: false },
    })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ user: null, session: null, messageId: undefined })
    expect((await backend.db.query(`select 1 from auth.users where phone = '+8613600136000'`)).rows).toHaveLength(0)
    expect((await backend.db.query(`select 1 from auth.one_time_tokens where phone = '+8613600136000'`)).rows).toHaveLength(0)
    expect(backend.smsInbox?.list()).toHaveLength(0)
  })

  test('returns the same public response for known and unknown create_user=false phones', async () => {
    const messages: string[] = []
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 0 },
      smsSender: { async send(message) { messages.push(message.body); return { messageId: 'provider-visible-id' } } },
      log: () => {},
    })
    backends.push(backend)
    const bootstrap = clientFor(backend)
    expect((await bootstrap.auth.signInWithOtp({ phone: '+8613600236000' })).error).toBeNull()
    const initialCode = messages[0]?.match(/\b\d{6,10}\b/)?.[0]
    expect(initialCode).toBeString()
    expect((await bootstrap.auth.verifyOtp({ phone: '+8613600236000', token: initialCode!, type: 'sms' })).error).toBeNull()
    messages.length = 0

    const known = await clientFor(backend).auth.signInWithOtp({
      phone: '+8613600236000', options: { shouldCreateUser: false },
    })
    const unknown = await clientFor(backend).auth.signInWithOtp({
      phone: '+8613600336000', options: { shouldCreateUser: false },
    })
    expect(known.error).toBeNull()
    expect(unknown.error).toBeNull()
    expect(known.data).toEqual(unknown.data)
    expect(known.data).toEqual({ user: null, session: null, messageId: undefined })
  })

  test('responds before running a masked provider synchronous prefix', async () => {
    let providerStarted = false
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 0 },
      smsSender: {
        async send() {
          providerStarted = true
          return { messageId: 'masked-provider-message' }
        },
      },
      log: () => {},
    })
    backends.push(backend)
    await backend.db.query(
      `insert into auth.users (aud, role, phone, raw_app_meta_data, raw_user_meta_data)
       values ('authenticated', 'authenticated', '+8613600436000', '{"provider":"phone","providers":["phone"]}', '{}')`
    )

    const result = await clientFor(backend).auth.signInWithOtp({
      phone: '+8613600436000', options: { shouldCreateUser: false },
    })
    expect(result.error).toBeNull()
    expect(providerStarted).toBeFalse()
    for (let attempt = 0; attempt < 100 && !providerStarted; attempt += 1) await Bun.sleep(1)
    expect(providerStarted).toBeTrue()
  })

  test('drains a settling masked delivery before closing', async () => {
    let markProviderStarted!: () => void
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve })
    let releaseProvider!: () => void
    const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve })
    let deliveryFinished = false
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 0 },
      smsSender: {
        async send() {
          markProviderStarted()
          await providerRelease
          deliveryFinished = true
        },
      },
      log: () => {},
    })
    backends.push(backend)
    await backend.db.query(
      `insert into auth.users (aud, role, phone, raw_app_meta_data, raw_user_meta_data)
       values ('authenticated', 'authenticated', '+8613600736000', '{"provider":"phone","providers":["phone"]}', '{}')`
    )

    expect((await clientFor(backend).auth.signInWithOtp({
      phone: '+8613600736000', options: { shouldCreateUser: false },
    })).error).toBeNull()
    await providerStarted
    let closeFinished = false
    const closing = backend.close().then(() => { closeFinished = true })
    await Bun.sleep(10)
    expect(closeFinished).toBeFalse()
    releaseProvider()
    await closing
    expect(deliveryFinished).toBeTrue()
  })

  test('bounds close when a masked provider never settles', async () => {
    let markProviderStarted!: () => void
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve })
    let deliverySignal: AbortSignal | undefined
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 0 },
      smsSender: {
        async send(_message, options) {
          deliverySignal = options?.signal
          markProviderStarted()
          await new Promise<never>(() => {})
        },
      },
      log: () => {},
    })
    backends.push(backend)
    await backend.db.query(
      `insert into auth.users (aud, role, phone, raw_app_meta_data, raw_user_meta_data)
       values ('authenticated', 'authenticated', '+8613600836000', '{"provider":"phone","providers":["phone"]}', '{}')`
    )

    expect((await clientFor(backend).auth.signInWithOtp({
      phone: '+8613600836000', options: { shouldCreateUser: false },
    })).error).toBeNull()
    await providerStarted
    const closedWithinDeadline = await Promise.race([
      backend.close().then(() => true),
      Bun.sleep(1_000).then(() => false),
    ])
    expect(closedWithinDeadline).toBeTrue()
    expect(deliverySignal?.aborted).toBeTrue()
  })

  test('aborts an awaited provider delivery while closing', async () => {
    let markProviderStarted!: () => void
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve })
    let deliverySignal: AbortSignal | undefined
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 0 },
      smsSender: {
        async send(_message, options) {
          deliverySignal = options?.signal
          markProviderStarted()
          await new Promise<never>(() => {})
        },
      },
      log: () => {},
    })
    backends.push(backend)

    const sending = clientFor(backend).auth.signInWithOtp({ phone: '+8613600936000' })
    await providerStarted
    const closedWithinDeadline = await Promise.race([
      backend.close().then(() => true),
      Bun.sleep(1_000).then(() => false),
    ])
    expect(closedWithinDeadline).toBeTrue()
    expect(deliverySignal?.aborted).toBeTrue()
    expect((await sending).error?.message).toBe('Unable to send the verification code')
  })

  test('keeps masked provider failures indistinguishable on cooldown retry', async () => {
    let failures = 0
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 60 },
      smsSender: {
        async send() {
          failures += 1
          throw new Error('provider unavailable')
        },
      },
      log: () => {},
    })
    backends.push(backend)
    await backend.db.query(
      `insert into auth.users (aud, role, phone, raw_app_meta_data, raw_user_meta_data)
       values ('authenticated', 'authenticated', '+8613600536000', '{"provider":"phone","providers":["phone"]}', '{}')`
    )
    const knownRequest = () => clientFor(backend).auth.signInWithOtp({
      phone: '+8613600536000', options: { shouldCreateUser: false },
    })
    const unknownRequest = () => clientFor(backend).auth.signInWithOtp({
      phone: '+8613600636000', options: { shouldCreateUser: false },
    })

    expect((await knownRequest()).error).toBeNull()
    expect((await unknownRequest()).error).toBeNull()
    for (let attempt = 0; attempt < 100 && failures === 0; attempt += 1) await Bun.sleep(1)
    expect(failures).toBe(1)
    expect((await knownRequest()).error?.code).toBe('over_sms_send_rate_limit')
    expect((await unknownRequest()).error?.code).toBe('over_sms_send_rate_limit')
  })

  test('honors disabled signups for unknown phone users', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64),
      authSettings: { smsOtpCooldownSeconds: 0, disableSignup: true }, log: () => {},
    })
    backends.push(backend)
    const result = await clientFor(backend).auth.signInWithOtp({ phone: '+8613500135000' })
    expect(result.error?.code).toBe('signup_disabled')
    expect(backend.smsInbox?.list()).toHaveLength(0)
  })

  test('applies the phone-specific signup switch without blocking existing users', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64),
      authSettings: { smsOtpCooldownSeconds: 0, smsSignupEnabled: false }, log: () => {},
    })
    backends.push(backend)
    await backend.db.query(
      `insert into auth.users (aud, role, phone, raw_app_meta_data, raw_user_meta_data)
       values ('authenticated', 'authenticated', '+8613500235000', '{"provider":"phone","providers":["phone"]}', '{}')`
    )
    const client = clientFor(backend)
    expect((await client.auth.signInWithOtp({ phone: '+8613500335000' })).error?.code).toBe('signup_disabled')
    expect((await client.auth.signInWithOtp({ phone: '+8613500235000' })).error).toBeNull()
    expect((await client.auth.verifyOtp({
      phone: '+8613500235000', token: smsCode(backend), type: 'sms',
    })).error).toBeNull()
  })

  test('invalidates the old code on resend and rejects a replay after success', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 0 }, log: () => {},
    })
    backends.push(backend)
    const client = clientFor(backend)
    expect((await client.auth.signInWithOtp({ phone: '+8613400134000' })).error).toBeNull()
    const oldCode = smsCode(backend)
    let newCode = oldCode
    for (let attempt = 0; attempt < 3 && newCode === oldCode; attempt += 1) {
      expect((await client.auth.signInWithOtp({ phone: '+8613400134000' })).error).toBeNull()
      newCode = smsCode(backend)
    }
    expect(newCode).not.toBe(oldCode)
    expect((await client.auth.verifyOtp({ phone: '+8613400134000', token: oldCode, type: 'sms' })).error?.code).toBe('otp_expired')
    expect((await client.auth.verifyOtp({ phone: '+8613400134000', token: newCode, type: 'sms' })).error).toBeNull()
    expect((await client.auth.verifyOtp({ phone: '+8613400134000', token: newCode, type: 'sms' })).error?.code).toBe('otp_expired')
  })

  test('burns the challenge after five wrong attempts', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 0 }, log: () => {},
    })
    backends.push(backend)
    const client = clientFor(backend)
    expect((await client.auth.signInWithOtp({ phone: '+8613300133000' })).error).toBeNull()
    const correct = smsCode(backend)
    for (const offset of [1, 2, 3, 4, 5]) {
      const wrong = differentOtp(correct, offset)
      expect((await client.auth.verifyOtp({ phone: '+8613300133000', token: wrong, type: 'sms' })).error?.code).toBe('otp_expired')
    }
    expect((await backend.db.query(`select 1 from auth.one_time_tokens where phone = '+8613300133000'`)).rows).toHaveLength(0)
    expect((await client.auth.verifyOtp({ phone: '+8613300133000', token: correct, type: 'sms' })).error?.code).toBe('otp_expired')
  })

  test('allows exactly one concurrent redemption and creates one refresh session', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 0 }, log: () => {},
    })
    backends.push(backend)
    const sender = clientFor(backend)
    expect((await sender.auth.signInWithOtp({ phone: '+8613200132000' })).error).toBeNull()
    const code = smsCode(backend)
    const results = await Promise.all([
      clientFor(backend).auth.verifyOtp({ phone: '+8613200132000', token: code, type: 'sms' }),
      clientFor(backend).auth.verifyOtp({ phone: '+8613200132000', token: code, type: 'sms' }),
    ])
    expect(results.filter((result) => result.error === null)).toHaveLength(1)
    expect(results.filter((result) => result.error?.code === 'otp_expired')).toHaveLength(1)
    const refresh = await backend.db.query(
      `select 1 from auth.refresh_tokens rt join auth.users u on u.id = rt.user_id where u.phone = '+8613200132000'`
    )
    expect(refresh.rows).toHaveLength(1)
  })

  test('enforces a persistent phone cooldown without sending another SMS', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 60 }, log: () => {},
    })
    backends.push(backend)
    const client = clientFor(backend)
    expect((await client.auth.signInWithOtp({ phone: '+8613100131000' })).error).toBeNull()
    const repeated = await client.auth.signInWithOtp({ phone: '+8613100131000' })
    expect(repeated.error?.code).toBe('over_sms_send_rate_limit')
    expect(backend.smsInbox?.list()).toHaveLength(1)
  })

  test('releases only its own cooldown when the SMS provider rejects a send', async () => {
    let attempts = 0
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 60 },
      smsSender: {
        async send() {
          attempts += 1
          if (attempts === 1) throw new Error('provider unavailable')
          return { messageId: 'retry-ok' }
        },
      },
      log: () => {},
    })
    backends.push(backend)
    expect((await clientFor(backend).auth.signInWithOtp({ phone: '+8613100231000' })).error?.message)
      .toBe('Unable to send the verification code')
    expect((await clientFor(backend).auth.signInWithOtp({ phone: '+8613100231000' })).error).toBeNull()
    expect(attempts).toBe(2)
  })

  test('keeps provider and compensation failures redacted', async () => {
    const phone = '+8613100331000'
    const logs: string[] = []
    let backend!: SupaCloudLiteBackend
    let restoreTransaction: (() => void) | undefined
    backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 60 },
      smsSender: {
        async send() {
          const database = backend.db as SupaCloudLiteBackend['db'] & {
            transaction: SupaCloudLiteBackend['db']['transaction']
          }
          const original = database.transaction.bind(database)
          database.transaction = async () => {
            throw Object.assign(new Error(`db detail includes ${phone}`), { code: 'XX000' })
          }
          restoreTransaction = () => { database.transaction = original }
          throw Object.assign(new Error(`provider detail includes ${phone}`), { code: phone.slice(1) })
        },
      },
      log: (message) => logs.push(message),
    })
    backends.push(backend)
    const result = await clientFor(backend).auth.signInWithOtp({ phone })
    restoreTransaction?.()

    expect(result.error?.status).toBe(502)
    expect(result.error?.message).toBe('Unable to send the verification code')
    expect(logs).toContain('[auth] phone_otp_deliver failed code=provider_error')
    expect(logs).toContain('[auth] phone_otp_cleanup failed code=XX000')
    expect(logs.join('\n')).not.toContain(phone)
    expect(logs.join('\n')).not.toContain('provider detail')
    expect(logs.join('\n')).not.toContain('db detail')
  })

  test('does not let an older provider failure delete a newer challenge', async () => {
    const bodies: string[] = []
    let rejectFirst: ((reason: Error) => void) | undefined
    let calls = 0
    const smsSender: SmsSender = {
      async send(message) {
        bodies.push(message.body)
        calls += 1
        if (calls === 1) {
          await new Promise<never>((_resolve, reject) => { rejectFirst = reject })
        }
        return { messageId: `message-${calls}` }
      },
    }
    const logs: string[] = []
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 0 },
      smsSender, log: (message) => logs.push(message),
    })
    backends.push(backend)
    const first = clientFor(backend).auth.signInWithOtp({ phone: '+8613000130000' })
    while (!rejectFirst) await Bun.sleep(1)
    const second = await clientFor(backend).auth.signInWithOtp({ phone: '+8613000130000' })
    expect(second.error).toBeNull()
    rejectFirst(new Error('provider secret response +8613000130000'))
    expect((await first).error?.message).toBe('Unable to send the verification code')
    const newestCode = bodies[1]?.match(/\b\d{6,10}\b/)?.[0]
    expect(newestCode).toBeString()
    expect((await clientFor(backend).auth.verifyOtp({ phone: '+8613000130000', token: newestCode!, type: 'sms' })).error).toBeNull()
    expect(logs.join('\n')).not.toContain('provider secret response')
    expect(logs.join('\n')).not.toContain('+8613000130000')
  })

  test('mounts the independent SMS inbox only on loopback and regardless of a custom mailer', async () => {
    const local = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64),
      mailer: { async send() {} }, log: () => {},
    })
    backends.push(local)
    expect(local.inbox).toBeNull()
    expect(local.smsInbox).not.toBeNull()
    expect((await local.fetch('http://local/sms-inbox')).status).toBe(200)

    const exposed = await createLiteBackend({
      host: '0.0.0.0', jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), log: () => {},
    })
    backends.push(exposed)
    expect(exposed.smsInbox).toBeNull()
    const settings = await exposed.fetch('http://local/auth/v1/settings', { headers: { apikey: exposed.anonKey } })
    expect((await settings.json()) as { external: { phone: boolean } }).toMatchObject({ external: { phone: false } })

    const networkSender = await createLiteBackend({
      host: '0.0.0.0', jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64),
      smsSender: { async send() { return { messageId: 'provider-message' } } }, log: () => {},
    })
    backends.push(networkSender)
    expect(networkSender.smsInbox).toBeNull()
    const enabled = await networkSender.fetch('http://local/auth/v1/settings', { headers: { apikey: networkSender.anonKey } })
    expect((await enabled.json()) as { external: { phone: boolean } }).toMatchObject({ external: { phone: true } })
  })

  test('keeps the existing email OTP flow working beside phone challenges', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), log: () => {},
    })
    backends.push(backend)
    const client = clientFor(backend)
    expect((await client.auth.signInWithOtp({ email: 'email-otp@example.com' })).error).toBeNull()
    const code = backend.inbox?.list()[0]?.code
    expect(code).toMatch(/^\d{6}$/)
    const verified = await client.auth.verifyOtp({ email: 'email-otp@example.com', token: code!, type: 'email' })
    expect(verified.error).toBeNull()
    expect(verified.data.user?.email).toBe('email-otp@example.com')
  })

  test('counts an email resend alias once against its send quota', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64),
      authRateLimits: { otp: { limit: 1, windowMs: 60_000 } }, log: () => {},
    })
    backends.push(backend)
    const request = () => backend.fetch('http://local/auth/v1/resend', {
      method: 'POST',
      headers: { apikey: backend.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'resend@example.com' }),
    })

    expect((await request()).status).toBe(200)
    expect((await request()).status).toBe(429)
    expect(backend.inbox?.list()).toHaveLength(1)
  })

  test('applies configured token verification rate limits', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), authSettings: { smsOtpCooldownSeconds: 0 },
      authRateLimits: { verify: { limit: 1, windowMs: 60_000 } }, log: () => {},
    })
    backends.push(backend)
    const client = clientFor(backend)
    expect((await client.auth.signInWithOtp({ phone: '+8613000230000' })).error).toBeNull()
    const code = smsCode(backend)
    expect((await client.auth.verifyOtp({ phone: '+8613000230000', token: differentOtp(code), type: 'sms' })).error?.code).toBe('otp_expired')
    expect((await client.auth.verifyOtp({ phone: '+8613000230000', token: code, type: 'sms' })).error?.code).toBe('over_request_rate_limit')
  })

  test('rejects an expired phone challenge', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64),
      authSettings: { smsOtpCooldownSeconds: 0, otpExpirySeconds: 1 }, log: () => {},
    })
    backends.push(backend)
    const client = clientFor(backend)
    expect((await client.auth.signInWithOtp({ phone: '+8613000330000' })).error).toBeNull()
    const code = smsCode(backend)
    await Bun.sleep(1_100)
    expect((await client.auth.verifyOtp({ phone: '+8613000330000', token: code, type: 'sms' })).error?.code).toBe('otp_expired')
  })
})
