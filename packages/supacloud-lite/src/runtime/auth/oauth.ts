/**
 * OAuth 2.0 / OIDC provider support for GoTrue-compatible sign-in.
 *
 * Flow (matches hosted Supabase):
 *   GET /authorize?provider=…  → 302 to the provider, state persisted
 *   provider → GET /callback?code=…&state=…
 *     → exchange code for a provider token, fetch the profile, upsert the
 *       user + identity, then:
 *         - PKCE: redirect to redirect_to?code=<auth_code>  (client calls
 *           exchangeCodeForSession → POST /token?grant_type=pkce)
 *         - implicit: redirect to redirect_to#access_token=…&refresh_token=…
 */
import type { Database, Querier } from '../db/database.js'
import { randomToken } from '../jwt.js'
import { resolveRedirect } from './redirect.js'
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose'

type OAuthRawProfile = Record<string, unknown>

export class OAuthAccountIneligibleError extends Error {
  constructor(public readonly code: 'user_banned' | 'user_not_found') {
    super(code)
  }
}

export class OAuthIdentityLinkError extends Error {
  constructor(public readonly code: 'identity_already_exists') {
    super(code)
  }
}

/** Operator-supplied config for one OAuth provider. Endpoint URLs are optional for presets (google, github). */
export interface OAuthProviderConfig {
  /** OAuth client id issued by the provider */
  clientId: string
  /** OAuth client secret issued by the provider */
  clientSecret: string
  /** Overrides; filled from a preset for known providers (google, github). */
  authorizeUrl?: string
  /** token endpoint; filled from a preset when omitted */
  tokenUrl?: string
  /** userinfo endpoint; filled from a preset when omitted */
  userInfoUrl?: string
  /** space-separated scopes to request; falls back to the preset's */
  scopes?: string
  /** Map the provider's raw userinfo JSON to a normalized profile. */
  profileMap?: (raw: OAuthRawProfile) => OAuthProfile
  /** Exact issuer accepted for OIDC ID tokens. Defaults to a known provider preset. */
  idTokenIssuer?: string
  /** JWKS URL used to verify OIDC ID token signatures. Defaults to a known provider preset. */
  idTokenJwksUrl?: string
  /** Additional audience accepted for OIDC ID tokens. Defaults to the OAuth client id. */
  idTokenAudience?: string | string[]
  /** Email domains that may resolve this provider through POST /sso. */
  ssoDomains?: string[]
}

/** Normalized profile extracted from a provider's userinfo response. */
export interface OAuthProfile {
  /** Provider-local user id (becomes auth.identities.provider_id). */
  id: string
  /** email address the provider returned, if any */
  email?: string
  /** Whether the provider asserts the email is verified; gated for account linking. */
  emailVerified?: boolean
  /** display name the provider returned, if any */
  name?: string
  /** extra provider fields (avatar, username, …) merged into identity_data */
  metadata?: Record<string, unknown>
}

interface ResolvedProvider extends OAuthProviderConfig {
  name: string
  authorizeUrl: string
  tokenUrl: string
  userInfoUrl: string
  scopes: string
  profileMap: (raw: OAuthRawProfile) => OAuthProfile
}

const PRESETS: Record<string, Partial<OAuthProviderConfig>> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: 'openid email profile',
    idTokenIssuer: 'https://accounts.google.com',
    idTokenJwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    profileMap: (r: OAuthRawProfile) => ({
      id: typeof r['sub'] === 'string' ? r['sub'] : '',
      ...(typeof r['email'] === 'string' ? { email: r['email'] } : {}),
      emailVerified: r['email_verified'] === true,
      ...(typeof r['name'] === 'string' ? { name: r['name'] } : {}),
      metadata: {
        avatar_url: r['picture'],
        full_name: r['name'],
        email_verified: r['email_verified'] === true,
      },
    }),
  },
  apple: {
    authorizeUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    userInfoUrl: 'https://appleid.apple.com/auth/userinfo',
    scopes: 'name email',
    idTokenIssuer: 'https://appleid.apple.com',
    idTokenJwksUrl: 'https://appleid.apple.com/auth/keys',
    profileMap: (r: OAuthRawProfile) => ({
      id: typeof r['sub'] === 'string' ? r['sub'] : '',
      ...(typeof r['email'] === 'string' ? { email: r['email'] } : {}),
      emailVerified: r['email_verified'] === true || r['email_verified'] === 'true',
      ...(typeof r['name'] === 'string' ? { name: r['name'] } : {}),
      metadata: {
        email_verified: r['email_verified'] === true || r['email_verified'] === 'true',
      },
    }),
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    scopes: 'read:user user:email',
    profileMap: (r: OAuthRawProfile) => ({
      id: String(r['id']),
      ...(typeof r['email'] === 'string' ? { email: r['email'] } : {}),
      ...(typeof r['name'] === 'string' || typeof r['login'] === 'string'
        ? { name: typeof r['name'] === 'string' ? r['name'] : r['login'] as string }
        : {}),
      metadata: { avatar_url: r['avatar_url'], user_name: r['login'] },
    }),
  },
}

/**
 * Merge operator config with the built-in preset for `name` into a fully
 * resolved provider.
 *
 * @throws if no endpoint URLs are supplied and no preset exists for `name`.
 */
export function resolveProvider(name: string, cfg: OAuthProviderConfig): ResolvedProvider {
  const preset = PRESETS[name] ?? {}
  const authorizeUrl = cfg.authorizeUrl ?? preset.authorizeUrl
  const tokenUrl = cfg.tokenUrl ?? preset.tokenUrl
  const userInfoUrl = cfg.userInfoUrl ?? preset.userInfoUrl
  if (!authorizeUrl || !tokenUrl || !userInfoUrl) {
    throw new Error(`OAuth provider "${name}" needs authorizeUrl/tokenUrl/userInfoUrl (no preset available)`)
  }
  return {
    name,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    authorizeUrl,
    tokenUrl,
    userInfoUrl,
    scopes: cfg.scopes ?? preset.scopes ?? '',
    profileMap: cfg.profileMap ?? preset.profileMap ?? ((r: OAuthRawProfile) => ({
      id: String(r['id'] ?? r['sub']),
      ...(typeof r['email'] === 'string' ? { email: r['email'] } : {}),
      ...(typeof r['name'] === 'string' ? { name: r['name'] } : {}),
    })),
    idTokenIssuer: cfg.idTokenIssuer ?? preset.idTokenIssuer,
    idTokenJwksUrl: cfg.idTokenJwksUrl ?? preset.idTokenJwksUrl,
    idTokenAudience: cfg.idTokenAudience ?? preset.idTokenAudience,
  }
}

/** Drives the OAuth authorize/callback/PKCE flows against the configured providers. */
export class OAuthService {
  private providers = new Map<string, ResolvedProvider>()
  private idTokenKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

  constructor(
    private db: Database,
    private apiUrl: string,
    private siteUrl: string,
    configs: Record<string, OAuthProviderConfig>,
    private fetchImpl: typeof fetch = fetch,
    private uriAllowList: string[] = [],
    private enforceRedirectAllowList = false
  ) {
    for (const [name, cfg] of Object.entries(configs)) {
      const provider = resolveProvider(name, cfg)
      this.providers.set(name, provider)
      if (provider.idTokenJwksUrl) {
        this.idTokenKeySets.set(name, createRemoteJWKSet(new URL(provider.idTokenJwksUrl), {
          timeoutDuration: 5_000,
          cooldownDuration: 30_000,
          cacheMaxAge: 10 * 60_000,
          [customFetch]: async (url, options) => this.fetchImpl(url, options),
        }))
      }
    }
  }

  /** Whether a provider by this name is configured. */
  has(name: string): boolean {
    return this.providers.has(name)
  }

  /** Verify an OIDC ID token and reuse the normal OAuth identity upsert path. */
  async signInWithIdToken(
    providerName: string,
    token: string,
    accessToken?: string,
    nonce?: string
  ): Promise<string | null> {
    const profile = await this.verifyIdToken(providerName, token, accessToken, nonce)
    if (!profile) return null
    return this.upsertUser(providerName, profile)
  }

  /** Verify an OIDC ID token and attach its identity to an existing user. */
  async linkIdentityWithIdToken(
    providerName: string,
    token: string,
    userId: string,
    accessToken?: string,
    nonce?: string
  ): Promise<boolean> {
    const profile = await this.verifyIdToken(providerName, token, accessToken, nonce)
    if (!profile) return false
    await this.linkIdentityToUser(providerName, profile, userId)
    return true
  }

  /** Upsert an already verified non-OAuth identity through the shared path. */
  async signInWithProfile(provider: string, profile: OAuthProfile): Promise<string> {
    return this.upsertUser(provider, profile)
  }

  private async verifyIdToken(
    providerName: string,
    token: string,
    accessToken?: string,
    nonce?: string
  ): Promise<OAuthProfile | null> {
    const provider = this.providers.get(providerName)
    const keySet = this.idTokenKeySets.get(providerName)
    if (!provider?.idTokenIssuer || !keySet || !token) return null

    let payload: JWTPayload
    let algorithm: string
    try {
      const verified = await jwtVerify(token, keySet, {
        issuer: provider.idTokenIssuer,
        audience: provider.idTokenAudience ?? provider.clientId,
        algorithms: ['RS256', 'ES256'],
      })
      payload = verified.payload
      algorithm = verified.protectedHeader.alg ?? ''
    } catch {
      return null
    }

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null
    if (payload.nonce !== undefined && (typeof payload.nonce !== 'string' || payload.nonce !== nonce)) return null
    const acceptedAudiences = provider.idTokenAudience ?? provider.clientId
    if (
      Array.isArray(payload.aud)
      && payload.aud.length > 1
      && (typeof payload.azp !== 'string'
        || (Array.isArray(acceptedAudiences) ? !acceptedAudiences.includes(payload.azp) : payload.azp !== acceptedAudiences))
    ) return null
    if (typeof payload.at_hash === 'string') {
      if (!accessToken || (await oidcAtHash(accessToken, algorithm)) !== payload.at_hash) return null
    }

    let profile: OAuthProfile
    try {
      profile = provider.profileMap(payload as OAuthRawProfile)
    } catch {
      return null
    }
    if (!profile.id) return null
    return profile
  }

  private callbackUrl(): string {
    return `${this.apiUrl}/auth/v1/callback`
  }

  /** GET /authorize - persist state, redirect to the provider. */
  async authorize(url: URL, linkUserId?: string): Promise<Response> {
    const providerName = url.searchParams.get('provider') ?? ''
    const provider = this.providers.get(providerName)
    if (!provider) {
      return redirectWithFragment(this.siteUrl, {
        error: 'provider_not_enabled',
        error_description: `provider ${providerName} is not configured`,
      })
    }
    const providerState = randomToken(16)
    const scopes = url.searchParams.get('scopes') || provider.scopes
    // Validate the redirect target up front so the callback can trust the stored
    // value - an unallowed target falls back to the site URL.
    const redirectTo = resolveRedirect(url.searchParams.get('redirect_to'), this.siteUrl, this.uriAllowList, this.enforceRedirectAllowList)
    await this.db.query(
      `insert into auth.flow_state (provider, provider_state, redirect_to, code_challenge, code_challenge_method, link_user_id, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')`,
      [
        providerName,
        providerState,
        redirectTo,
        url.searchParams.get('code_challenge'),
        url.searchParams.get('code_challenge_method'),
        linkUserId ?? null,
      ]
    )
    const p = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: this.callbackUrl(),
      response_type: 'code',
      scope: scopes,
      state: providerState,
    })
    const reserved = new Set([
      'provider',
      'redirect_to',
      'scopes',
      'code_challenge',
      'code_challenge_method',
      'skip_http_redirect',
      'client_id',
      'redirect_uri',
      'response_type',
      'scope',
      'state',
    ])
    for (const [key, value] of url.searchParams) {
      if (!reserved.has(key)) p.append(key, value)
    }
    const providerUrl = `${provider.authorizeUrl}?${p}`
    if (url.searchParams.get('skip_http_redirect') === 'true') {
      return Response.json({ url: providerUrl })
    }
    return redirect(providerUrl)
  }

  /** GET /callback - exchange code, upsert user+identity, redirect back. */
  async callback(url: URL, createSession: (userId: string) => Promise<OAuthSession>): Promise<Response> {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) return redirectWithFragment(this.siteUrl, { error: 'invalid_request' })

    const res = await this.db.query<FlowRow>(
      `delete from auth.flow_state where provider_state = $1 and expires_at > now() returning *`,
      [state]
    )
    const flow = res.rows[0]
    if (!flow) return redirectWithFragment(this.siteUrl, { error: 'invalid_state' })
    const provider = this.providers.get(flow.provider)
    if (!provider) return redirectWithFragment(flow.redirect_to, { error: 'provider_not_enabled' })

    let profile: OAuthProfile
    try {
      const token = await this.exchangeCode(provider, code)
      profile = await this.fetchProfile(provider, token)
    } catch {
      return redirectWithFragment(flow.redirect_to, {
        error: 'server_error',
        error_description: 'OAuth provider request failed',
      })
    }

    let userId: string
    try {
      if (flow.link_user_id) {
        await this.linkIdentityToUser(provider.name, profile, flow.link_user_id)
        userId = flow.link_user_id
      } else {
        userId = await this.upsertUser(provider.name, profile)
      }
    } catch (e) {
      if (e instanceof OAuthAccountIneligibleError) {
        return redirectWithFragment(flow.redirect_to, { error: 'access_denied', error_code: e.code })
      }
      if (e instanceof OAuthIdentityLinkError) {
        return redirectWithFragment(flow.redirect_to, { error: 'access_denied', error_code: e.code })
      }
      return redirectWithFragment(flow.redirect_to, {
        error: 'server_error',
        error_description: 'OAuth callback failed',
      })
    }

    // PKCE: hand back an auth code the client exchanges for a session.
    if (flow.code_challenge) {
      const authCode = randomToken(24)
      await this.db.query(
        `insert into auth.flow_state (provider, provider_state, redirect_to, code_challenge, code_challenge_method, auth_code, user_id, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, now() + interval '5 minutes')`,
        [flow.provider, randomToken(16), flow.redirect_to, flow.code_challenge, flow.code_challenge_method, authCode, userId]
      )
      return redirectWithQuery(flow.redirect_to, { code: authCode })
    }

    // implicit: tokens in the URL fragment
    let session: OAuthSession
    try {
      session = await createSession(userId)
    } catch (e) {
      if (e instanceof OAuthAccountIneligibleError) {
        return redirectWithFragment(flow.redirect_to, { error: 'access_denied', error_code: e.code })
      }
      return redirectWithFragment(flow.redirect_to, {
        error: 'server_error',
        error_description: 'OAuth callback failed',
      })
    }
    return redirectWithFragment(flow.redirect_to, {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: String(session.expires_in),
      token_type: 'bearer',
      provider_token: '',
    })
  }

  /** POST /token?grant_type=pkce - exchange an auth code + verifier for a session. */
  async exchangePkce(authCode: string, verifier: string): Promise<string | null> {
    const res = await this.db.query<FlowRow>(
      `select * from auth.flow_state where auth_code = $1 and expires_at > now()`,
      [authCode]
    )
    const flow = res.rows[0]
    if (!flow || !flow.user_id) return null
    if (flow.code_challenge_method === 's256' || flow.code_challenge_method === 'S256') {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
      const challenge = base64url(new Uint8Array(digest))
      if (challenge !== flow.code_challenge) return null
    } else if (flow.code_challenge && flow.code_challenge !== verifier) {
      return null // plain method
    }
    const claimed = await this.db.transaction(async (query) => {
      const consumed = await query<FlowRow>(
        `delete from auth.flow_state where auth_code = $1 and expires_at > now() returning *`,
        [authCode]
      )
      return consumed.rows[0] ?? null
    })
    return claimed?.user_id ?? null
  }

  private async exchangeCode(provider: ResolvedProvider, code: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: this.callbackUrl(),
      grant_type: 'authorization_code',
    })
    const res = await this.fetchImpl(provider.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    })
    if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`)
    const json = (await res.json()) as { access_token?: string }
    if (!json.access_token) throw new Error('no access_token from provider')
    return json.access_token
  }

  private async fetchProfile(provider: ResolvedProvider, token: string): Promise<OAuthProfile> {
    const res = await this.fetchImpl(provider.userInfoUrl, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'supacloud-lite' },
    })
    if (!res.ok) throw new Error(`userinfo failed: HTTP ${res.status}`)
    const profile = provider.profileMap(await res.json())
    if (!profile.id) throw new Error('provider profile missing id')
    return profile
  }

  private async upsertUser(provider: string, profile: OAuthProfile): Promise<string> {
    return this.db.transaction((query) => this.upsertUserInTransaction(query, provider, profile))
  }

  private async linkIdentityToUser(provider: string, profile: OAuthProfile, userId: string): Promise<void> {
    await this.db.transaction(async (query) => {
      await this.assertUserEligible(query, userId)
      const identityData = JSON.stringify({ sub: profile.id, email: profile.email, ...profile.metadata })
      const inserted = await query<{ user_id: string }>(
        `insert into auth.identities (user_id, provider, provider_id, identity_data)
         values ($1, $2, $3, $4::jsonb)
         on conflict (provider, provider_id) do nothing
         returning user_id`,
        [userId, provider, profile.id, identityData],
      )
      if (inserted.rows.length === 0) {
        throw new OAuthIdentityLinkError('identity_already_exists')
      }
      await this.syncUserProviders(query, userId)
    })
  }

  private async upsertUserInTransaction(query: Querier, provider: string, profile: OAuthProfile): Promise<string> {
    // existing identity?
    const existing = await query<{ user_id: string }>(
      `select user_id from auth.identities where provider = $1 and provider_id = $2`,
      [provider, profile.id]
    )
    if (existing.rows[0]) {
      await this.assertUserEligible(query, existing.rows[0].user_id)
      await query(`update auth.identities set last_sign_in_at = now(), identity_data = $3 where provider = $1 and provider_id = $2`, [
        provider,
        profile.id,
        JSON.stringify({ sub: profile.id, email: profile.email, ...profile.metadata }),
      ])
      await query(`update auth.users set last_sign_in_at = now() where id = $1`, [existing.rows[0].user_id])
      await this.syncUserProviders(query, existing.rows[0].user_id)
      return existing.rows[0].user_id
    }

    // Link to an existing user with the same email ONLY when the provider
    // asserts the email is verified - otherwise an attacker could register a
    // provider account with a victim's unverified email and take over their
    // account. Unverified → fall through and create a separate user.
    let userId: string | undefined
    const email = typeof profile.email === 'string' ? profile.email.toLowerCase().trim() || null : null
    const verified = email !== null && profile.emailVerified === true
    if (email && verified) {
      const byEmail = await query<{ id: string }>(`select id from auth.users where lower(email) = $1`, [email])
      userId = byEmail.rows[0]?.id
      if (userId) await this.assertUserEligible(query, userId)
    }
    let createdUserId: string | undefined
    if (!userId) {
      // Only claim the email on the new user when the provider verified it AND
      // it isn't already owned by another account. An unverified or taken email
      // is left null so it can't collide with (or hijack) an existing user.
      let userEmail: string | null = verified ? email : null
      if (userEmail) {
        const taken = await query(`select 1 from auth.users where lower(email) = $1`, [userEmail])
        if (taken.rows.length > 0) userEmail = null
      }
      const created = await query<{ id: string }>(
        `insert into auth.users (aud, role, email, email_confirmed_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data)
         values ('authenticated','authenticated',$1, $2, now(),
                 $3::jsonb, $4::jsonb)
         on conflict (email) do nothing
         returning id`,
        [
          userEmail,
          userEmail ? new Date().toISOString() : null,
          JSON.stringify({ provider, providers: [provider] }),
          JSON.stringify({ sub: profile.id, email: profile.email, full_name: profile.name, ...profile.metadata }),
        ]
      )
      const user = created.rows[0]
      if (user) {
        userId = user.id
        createdUserId = user.id
      } else if (userEmail) {
        const existingEmail = await query<{ id: string }>(
          `select id from auth.users where lower(email) = $1 for update`,
          [userEmail],
        )
        userId = existingEmail.rows[0]?.id
        if (!userId) throw new Error('OAuth email conflict has no winner')
        await this.assertUserEligible(query, userId)
      } else {
        throw new Error('OAuth user creation returned no row')
      }
    }
    const identityData = JSON.stringify({ sub: profile.id, email: profile.email, ...profile.metadata })
    const linked = await query<{ user_id: string }>(
      `insert into auth.identities (user_id, provider, provider_id, identity_data)
       values ($1, $2, $3, $4::jsonb)
       on conflict (provider, provider_id) do nothing
       returning user_id`,
      [userId, provider, profile.id, identityData]
    )
    if (linked.rows[0]) {
      await this.syncUserProviders(query, linked.rows[0].user_id)
      return linked.rows[0].user_id
    }

    const raced = await query<{ user_id: string }>(
      `select user_id from auth.identities where provider = $1 and provider_id = $2`,
      [provider, profile.id]
    )
    const racedUserId = raced.rows[0]?.user_id
    if (!racedUserId) throw new Error('OAuth identity conflict has no winner')
    if (createdUserId && createdUserId !== racedUserId) {
      await query(`delete from auth.users where id = $1`, [createdUserId])
    }
    await this.assertUserEligible(query, racedUserId)
    await query(
      `update auth.identities set last_sign_in_at = now(), identity_data = $3
       where provider = $1 and provider_id = $2`,
      [provider, profile.id, identityData]
    )
    await query(`update auth.users set last_sign_in_at = now() where id = $1`, [racedUserId])
    await this.syncUserProviders(query, racedUserId)
    return racedUserId
  }

  private async syncUserProviders(query: Querier, userId: string): Promise<void> {
    await query(
      `update auth.users
       set raw_app_meta_data = jsonb_set(
         coalesce(raw_app_meta_data, '{}'::jsonb),
         '{providers}',
         (
           select jsonb_agg(provider order by provider)
           from (
             select distinct provider
             from auth.identities
             where user_id = $1
           ) as providers
         ),
         true
       ),
       updated_at = now()
       where id = $1`,
      [userId],
    )
  }

  private async assertUserEligible(query: Querier, userId: string): Promise<void> {
    const users = await query<{ is_deleted: boolean; is_banned: boolean }>(
      `select deleted_at is not null as is_deleted,
              coalesce(banned_until > now(), false) as is_banned
       from auth.users where id = $1 for update`,
      [userId],
    )
    const user = users.rows[0]
    if (!user || user.is_deleted) throw new OAuthAccountIneligibleError('user_not_found')
    if (user.is_banned) throw new OAuthAccountIneligibleError('user_banned')
  }
}

async function oidcAtHash(accessToken: string, algorithm: string): Promise<string | null> {
  const hash = algorithm === 'RS256' || algorithm === 'ES256' ? 'SHA-256' : null
  if (!hash) return null
  const digest = new Uint8Array(await crypto.subtle.digest(hash, new TextEncoder().encode(accessToken)))
  return base64url(digest.subarray(0, digest.length / 2))
}

/** The minimal session the callback puts in the redirect fragment for the implicit flow. */
export interface OAuthSession {
  /** signed access token (JWT) */
  access_token: string
  /** opaque refresh token */
  refresh_token: string
  /** access-token lifetime in seconds */
  expires_in: number
}

interface FlowRow {
  provider: string
  redirect_to: string
  code_challenge: string | null
  code_challenge_method: string | null
  auth_code: string | null
  user_id: string | null
  link_user_id: string | null
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } })
}

function redirectWithQuery(location: string, params: Record<string, string>): Response {
  const target = new URL(location)
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
  return redirect(target.toString())
}

function redirectWithFragment(location: string, params: Record<string, string>): Response {
  const target = new URL(location)
  target.hash = new URLSearchParams(params).toString()
  return redirect(target.toString())
}

function base64url(bytes: Uint8Array): string {
  let bin: string = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
