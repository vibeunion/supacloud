import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { hashPassword } from '../src/runtime/auth/password.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth unexpected error responses', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const email = 'error-redaction@example.test'
  const password = 'correct-horse-battery-staple'
  const jwtSecret = 'auth-error-redaction-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    await db!.query(
      `insert into auth.users (email, encrypted_password, email_confirmed_at)
       values ($1, $2, now())`,
      [email, await hashPassword(password)],
    )
    auth = new AuthHandler(db!, {
      jwtSecret,
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local',
      jwtExpiry: 3600,
      mailer: new InboxMailer(),
      rateLimiter: null,
    })
    await db!.exec(`
      create function public.reject_auth_session() returns trigger language plpgsql as $$
      begin
        raise exception 'internal database details must stay private';
      end $$;
      create trigger reject_auth_session before insert on auth.refresh_tokens
        for each row execute function public.reject_auth_session();
    `)
  })
  afterEach(async () => {
    await db!.exec('drop trigger reject_auth_session on auth.refresh_tokens; drop function public.reject_auth_session();')
    await auth?.stop()
  })
  afterAll(async () => { await db?.close() })

  test('does not return the internal exception message', async () => {
    const url = new URL('http://lite.local/auth/v1/token?grant_type=password')
    const response = await auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }), { role: 'anon', claims: null }, url)
    const body = await response.json() as { error_code: string; msg: string }

    expect(response.status).toBe(500)
    expect(body.error_code).toBe('unexpected_failure')
    expect(body.msg).toBe('Unable to complete authentication request')
    expect(body.msg).not.toContain('internal database details')
  })
})
