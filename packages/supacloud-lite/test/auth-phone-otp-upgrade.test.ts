import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'
import { createPgliteEngine } from '../src/runtime/db/pglite-engine.js'

test('upgrades and reopens a 0.5.9 one_time_tokens table without changing email tokens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'supacloud-lite-phone-upgrade-'))
  const dataDir = join(root, 'db')
  try {
    const legacy = await createPgliteEngine(dataDir)
    await legacy.exec(`
      create schema auth;
      create table auth.one_time_tokens (
        id uuid primary key default gen_random_uuid(),
        user_id uuid,
        email text not null,
        token_type text not null,
        token text not null,
        attempts int not null default 0,
        created_at timestamptz default now(),
        expires_at timestamptz not null
      );
      insert into auth.one_time_tokens (id, email, token_type, token, expires_at)
      values ('00000000-0000-4000-8000-000000000001', 'legacy@example.com', 'otp', '123456', now() + interval '1 hour');
    `)
    await legacy.close()

    const first = await createLiteBackend({
      dataDir, jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), startRuntimeServices: false, log: () => {},
    })
    const columns = await first.db.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_schema = 'auth' and table_name = 'one_time_tokens' and column_name in ('email', 'phone')
       order by column_name`
    )
    expect(columns.rows).toEqual([
      { column_name: 'email', is_nullable: 'YES' },
      { column_name: 'phone', is_nullable: 'YES' },
    ])
    expect((await first.db.query(`select email, phone, token from auth.one_time_tokens`)).rows).toEqual([
      { email: 'legacy@example.com', phone: null, token: '123456' },
    ])
    const emailClient = createClient('http://local', first.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: first.fetch },
    })
    expect((await emailClient.auth.signInWithOtp({ email: 'upgraded-email@example.com' })).error).toBeNull()
    const emailCode = first.inbox?.list()[0]?.code
    expect(emailCode).toMatch(/^\d{6}$/)
    expect((await emailClient.auth.verifyOtp({ email: 'upgraded-email@example.com', token: emailCode!, type: 'email' })).error).toBeNull()
    await first.db.query(
      `insert into auth.one_time_tokens (id, phone, token_type, token, expires_at)
       values ('00000000-0000-4000-8000-000000000002', '+8613800138000', 'sms', 'hmac-sha256:v1:test', now() + interval '1 hour')`
    )
    await first.close()

    const reopened = await createLiteBackend({
      dataDir, jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), startRuntimeServices: false, log: () => {},
    })
    expect((await reopened.db.query(`select count(*)::int as count from auth.one_time_tokens`)).rows).toEqual([{ count: 2 }])
    await reopened.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('upgrades the legacy one_time_tokens schema on the minimal-bootstrap path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'supacloud-lite-phone-minimal-upgrade-'))
  const dataDir = join(root, 'db')
  try {
    const engine = await createPgliteEngine(dataDir)
    await engine.exec(`
      create schema auth;
      create table auth.one_time_tokens (
        id uuid primary key default gen_random_uuid(), user_id uuid, email text not null, token_type text not null,
        token text not null, attempts int not null default 0, created_at timestamptz default now(),
        expires_at timestamptz not null
      );
      insert into auth.one_time_tokens (id, email, token_type, token, expires_at)
      values ('00000000-0000-4000-8000-000000000003', 'minimal@example.com', 'otp', '654321', now() + interval '1 hour');
    `)
    engine.minimalBootstrap = true
    const backend = await createLiteBackend({
      engine, jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64),
      authSettings: { smsOtpCooldownSeconds: 0 }, startRuntimeServices: false, log: () => {},
    })
    const columns = await backend.db.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_schema = 'auth' and table_name = 'one_time_tokens' and column_name in ('email', 'phone')
       order by column_name`
    )
    expect(columns.rows).toEqual([
      { column_name: 'email', is_nullable: 'YES' },
      { column_name: 'phone', is_nullable: 'YES' },
    ])
    expect((await clientForMinimal(backend).auth.signInWithOtp({ phone: '+8613000530000' })).error).toBeNull()
    await backend.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps the phone send cooldown across backend restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'supacloud-lite-phone-cooldown-'))
  const dataDir = join(root, 'db')
  try {
    const first = await createLiteBackend({
      dataDir, jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64),
      authSettings: { smsOtpCooldownSeconds: 60 }, startRuntimeServices: false, log: () => {},
    })
    const firstClient = createClient('http://local', first.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: first.fetch },
    })
    expect((await firstClient.auth.signInWithOtp({ phone: '+8613000430000' })).error).toBeNull()
    await first.close()

    const reopened = await createLiteBackend({
      dataDir, jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64),
      authSettings: { smsOtpCooldownSeconds: 60 }, startRuntimeServices: false, log: () => {},
    })
    const reopenedClient = createClient('http://local', reopened.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: reopened.fetch },
    })
    expect((await reopenedClient.auth.signInWithOtp({ phone: '+8613000430000' })).error?.code).toBe('over_sms_send_rate_limit')
    await reopened.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function clientForMinimal(backend: Awaited<ReturnType<typeof createLiteBackend>>) {
  return createClient('http://local', backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: backend.fetch },
  })
}
