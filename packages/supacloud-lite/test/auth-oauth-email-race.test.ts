import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth OAuth email ownership races', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const email = 'oauth-verified-race@example.test'
  const jwtSecret = 'oauth-email-race-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    auth = new AuthHandler(db!, {
      jwtSecret,
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local',
      jwtExpiry: 3600,
      mailer: new InboxMailer(),
      rateLimiter: null,
      oauthProviders: {
        google: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          authorizeUrl: 'http://provider.local/authorize',
          tokenUrl: 'http://provider.local/token',
          userInfoUrl: 'http://provider.local/userinfo',
          profileMap: (raw) => ({
            id: String(raw.sub),
            email: String(raw.email),
            emailVerified: raw.email_verified === true,
            metadata: { race: raw.race },
          }),
        },
      },
      oauthFetch: (async (input) => {
        const url = new URL(String(input))
        if (url.pathname === '/token') return Response.json({ access_token: 'provider-token' })
        if (url.pathname === '/userinfo') {
          return Response.json({
            sub: 'provider-user',
            email,
            email_verified: true,
            race: 'candidate',
          })
        }
        return new Response('not found', { status: 404 })
      }) as typeof fetch,
    })
    await db!.exec(`
      create function public.seed_oauth_email_owner() returns trigger language plpgsql as $$
      begin
        if new.raw_user_meta_data->>'race' = 'candidate' then
          insert into auth.users (email, email_confirmed_at, raw_user_meta_data)
          values ('${email}', now(), '{"race":"winner"}'::jsonb);
        end if;
        return new;
      end $$;
      create trigger seed_oauth_email_owner before insert on auth.users
        for each row execute function public.seed_oauth_email_owner();
    `)
  })
  afterEach(async () => {
    await db!.exec('drop trigger seed_oauth_email_owner on auth.users; drop function public.seed_oauth_email_owner();')
    await auth?.stop()
  })
  afterAll(async () => { await db?.close() })

  test('uses the account that won the verified email constraint', async () => {
    const authorizeUrl = new URL('http://lite.local/auth/v1/authorize?provider=google&redirect_to=http%3A%2F%2Fapp.local')
    const authorized = await auth!.handle(new Request(authorizeUrl), { role: 'anon', claims: null }, authorizeUrl)
    const state = new URL(authorized.headers.get('location')!).searchParams.get('state')!
    const callbackUrl = new URL(`http://lite.local/auth/v1/callback?code=provider-code&state=${encodeURIComponent(state)}`)
    const callback = await auth!.handle(new Request(callbackUrl), { role: 'anon', claims: null }, callbackUrl)

    expect(callback.status).toBe(303)
    expect((await db!.query(`select id from auth.users where email = $1`, [email])).rows).toHaveLength(1)
    expect((await db!.query(
      `select provider, provider_id from auth.identities`,
    )).rows).toEqual([{ provider: 'google', provider_id: 'provider-user' }])
  })
})
