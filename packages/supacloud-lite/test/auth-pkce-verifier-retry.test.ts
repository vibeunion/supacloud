import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { OAuthService } from '../src/runtime/auth/oauth.js'

describe('Auth PKCE verifier failures', () => {
  let db: Database | undefined
  let oauth: OAuthService | undefined
  let userId: string
  const authCode = 'pkce-verifier-retry-code'
  const verifier = 'correct-verifier'

  beforeAll(async () => {
    db = await Database.create()
    userId = (await db.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at)
       values ('pkce-verifier-retry@example.test', now()) returning id`,
    )).rows[0].id
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const challenge = Buffer.from(digest).toString('base64url')
    await db.query(
      `insert into auth.flow_state
         (provider, provider_state, redirect_to, code_challenge, code_challenge_method, auth_code, user_id, expires_at)
       values ('test', 'pkce-verifier-retry-state', 'http://app.local', $1, 's256', $2, $3, now() + interval '5 minutes')`,
      [challenge, authCode, userId],
    )
    oauth = new OAuthService(db, 'http://lite.local', 'http://app.local', {})
  }, 60_000)

  afterAll(async () => { await db?.close() })

  test('keeps the authorization code after an incorrect verifier', async () => {
    expect(await oauth!.exchangePkce(authCode, 'wrong-verifier')).toBeNull()
    expect(await oauth!.exchangePkce(authCode, verifier)).toBe(userId)
    expect(await oauth!.exchangePkce(authCode, verifier)).toBeNull()
  })
})
