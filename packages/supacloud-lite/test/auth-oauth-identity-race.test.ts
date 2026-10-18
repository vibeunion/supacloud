import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth OAuth identity races', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const jwtSecret = 'oauth-identity-race-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    await db!.query(
      `insert into auth.users (email, email_confirmed_at) values ('oauth-competitor@example.test', now())`,
    )
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
        },
      },
      oauthFetch: (async (input) => {
        const url = new URL(String(input))
        if (url.pathname === '/token') return Response.json({ access_token: 'provider-token' })
        if (url.pathname === '/userinfo') {
          return Response.json({ sub: 'provider-user', email: 'oauth-race@example.test', email_verified: false })
        }
        return new Response('not found', { status: 404 })
      }) as typeof fetch,
    })
    await db!.exec(`
      create function public.seed_oauth_identity() returns trigger language plpgsql as $$
      begin
        if new.email is null then
          insert into auth.identities (user_id, provider, provider_id, identity_data)
          select id, 'google', 'provider-user', '{}'::jsonb
          from auth.users where email = 'oauth-competitor@example.test'
          on conflict (provider, provider_id) do nothing;
        end if;
        return new;
      end $$;
      create trigger seed_oauth_identity after insert on auth.users
        for each row execute function public.seed_oauth_identity();
    `)
  })
  afterEach(async () => {
    await db!.exec('drop trigger seed_oauth_identity on auth.users; drop function public.seed_oauth_identity();')
    await auth?.stop()
  })
  afterAll(async () => { await db?.close() })

  test('reuses the winner identity and removes the losing user', async () => {
    const authorizeUrl = new URL('http://lite.local/auth/v1/authorize?provider=google&redirect_to=http%3A%2F%2Fapp.local')
    const authorized = await auth!.handle(new Request(authorizeUrl), { role: 'anon', claims: null }, authorizeUrl)
    const state = new URL(authorized.headers.get('location')!).searchParams.get('state')!
    const callbackUrl = new URL(`http://lite.local/auth/v1/callback?code=provider-code&state=${encodeURIComponent(state)}`)
    const callback = await auth!.handle(new Request(callbackUrl), { role: 'anon', claims: null }, callbackUrl)

    expect(callback.status).toBe(303)
    expect((await db!.query('select id from auth.users')).rows).toHaveLength(1)
    expect((await db!.query(
      `select provider, provider_id from auth.identities`,
    )).rows).toEqual([{ provider: 'google', provider_id: 'provider-user' }])
  })
})
