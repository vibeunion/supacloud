import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'
import { signJwt } from '../src/runtime/jwt.js'

describe('Auth email update duplicate handling', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let firstUserId: string
  let firstToken: string
  const jwtSecret = 'email-update-race-secret'.repeat(3)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    firstUserId = (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ('first@example.test', now()) returning id`,
    )).rows[0].id
    await db!.query(
      `insert into auth.users (email, email_confirmed_at) values ('second@example.test', now())`,
    )
    firstToken = await signJwt({ sub: firstUserId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }, jwtSecret)
    auth = new AuthHandler(db!, {
      jwtSecret,
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local',
      jwtExpiry: 3600,
      mailer: new InboxMailer(),
      rateLimiter: null,
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('returns email_exists when a duplicate commits after the conflict check', async () => {
    const url = new URL('http://lite.local/auth/v1/user')
    await db!.exec(`
      create function public.reject_concurrent_email() returns trigger language plpgsql as $$
      begin
        if new.email = 'shared@example.test' then
          raise unique_violation using message = 'simulated concurrent email conflict';
        end if;
        return new;
      end $$;
      create trigger reject_concurrent_email before update of email on auth.users
        for each row execute function public.reject_concurrent_email();
    `)
    try {
      const response = await auth!.handle(new Request(url, {
        method: 'PUT',
        headers: { authorization: `Bearer ${firstToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'shared@example.test' }),
      }), { role: 'anon', claims: null }, url)
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ error_code: 'email_exists' })
    } finally {
      await db!.exec('drop trigger reject_concurrent_email on auth.users; drop function public.reject_concurrent_email();')
    }
  })
})
