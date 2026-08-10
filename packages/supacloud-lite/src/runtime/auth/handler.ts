/**
 * GoTrue-compatible auth endpoints (/auth/v1/*) - the subset supabase-js
 * uses for email/password auth, sessions, and admin user management.
 */
import type { Database, Querier } from '../db/database.js'
import { randomToken, signJwt, verifyJwt, type JwtClaims } from '../jwt.js'
import type { Mailer, RequestContext, SmsSender } from '../types.js'
import { SUPACLOUD_LITE_VERSION } from '../../version.js'
import { OAuthService, type OAuthProviderConfig } from './oauth.js'
import { hashPassword, verifyPassword } from './password.js'
import { qrSvgDataUri } from './qr.js'
import { DEFAULT_AUTH_SETTINGS, type AuthSettings } from './settings.js'
import { resolveRedirect } from './redirect.js'
import { RateLimiter } from './rate-limit.js'
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js'

/** Construction-time config for {@link AuthHandler}. */
export interface AuthConfig {
  /** HS256 secret used to sign and verify access tokens */
  jwtSecret: string
  /** public API URL of this instance; used as issuer, OAuth callback, and email-link base */
  apiUrl: string
  /** frontend URL used as the default redirect target */
  siteUrl: string
  /** Access-token lifetime in seconds. */
  jwtExpiry: number
  /** Force sign-out after this many seconds (config.toml auth.sessions.timebox). Caps session lifetime. */
  sessionTimeboxSeconds?: number
  /** Reject refresh after this many seconds without refresh activity. */
  sessionInactivitySeconds?: number
  /** sends outgoing auth email (magic links, OTP codes, recovery) */
  mailer: Mailer
  /** sends phone OTP messages; null keeps phone auth disabled */
  smsSender?: SmsSender | null
  /** receives redacted operational diagnostics; never receives phone or OTP values */
  log?: (message: string) => void
  /** OAuth providers to enable, keyed by provider name (google, github, …) */
  oauthProviders?: Record<string, OAuthProviderConfig>
  /** injectable fetch for the OAuth provider calls (tests use a mock provider) */
  oauthFetch?: typeof fetch
  /**
   * Additional redirect targets allowed beyond the site URL's own origin
   * (GoTrue's URI_ALLOW_LIST). Entries may use `*`/`**` globs. A `redirect_to`
   * that matches neither the site origin nor an entry falls back to the site URL.
   */
  uriAllowList?: string[]
  /**
   * Enforce the redirect allowlist strictly. Off for local dev (any well-formed
   * URL is honored, like `supabase start`); the backend turns it on when
   * network-exposed so redirects can't leave the allowed origins.
   */
  enforceRedirectAllowList?: boolean
  /**
   * Runtime-mutable toggles (signups, anonymous users, autoconfirm…). The
   * admin API mutates this same object in place, so changes apply instantly.
   */
  settings?: AuthSettings
  /**
   * Rate limiter for login/signup/OTP/recovery. Defaults to a fresh in-memory
   * limiter with GoTrue-shaped windows; pass `null` to disable (e.g. tests).
   */
  rateLimiter?: RateLimiter | null
}

interface UserRow {
  id: string
  aud: string | null
  role: string | null
  email: string | null
  encrypted_password: string | null
  email_confirmed_at: Date | string | null
  last_sign_in_at: Date | string | null
  raw_app_meta_data: Record<string, unknown> | null
  raw_user_meta_data: Record<string, unknown> | null
  created_at: Date | string | null
  updated_at: Date | string | null
  phone: string | null
  phone_confirmed_at: Date | string | null
  is_anonymous: boolean | null
}

interface RefreshTokenRow {
  user_id: string
  session_id: string | null
  created_at: Date | string | null
}

interface PhoneOtpIssueRequest {
  phone: string
  createUser: boolean
  metadata: Record<string, unknown>
  fingerprint: string
  tokenDigest: string
  issuanceId: string
  eligibleBefore: string
  expiry: string
}

type PhoneOtpPreparation =
  | { state: 'cooldown' }
  | { state: 'unknown' }
  | { state: 'signup_disabled' }
  | { state: 'issued'; id: string; fingerprint: string; tokenDigest: string }

function authError(status: number, errorCode: string, msg: string): Response {
  return json(status, { code: status, error_code: errorCode, msg })
}

/** A cryptographically-random numeric OTP of `length` digits (6-10). */
function randomOtp(length: number): string {
  const n = Math.max(6, Math.min(10, Math.floor(length)))
  let code = ''
  // 250 is the largest multiple of 10 below 256. Rejecting bytes >=250 avoids
  // modulo bias while keeping the code cryptographically random.
  while (code.length < n) {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.max(16, n - code.length)))
    for (const byte of bytes) {
      if (byte >= 250) continue
      code += String(byte % 10)
      if (code.length === n) break
    }
  }
  return code
}

function normalizePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const phone = value.trim()
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function databaseDiagnosticCode(error: unknown): string {
  const candidate = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  return typeof candidate === 'string' && /^[0-9A-Z]{5}$/.test(candidate) ? candidate : 'database_error'
}

async function keyedDigest(secret: string, domain: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${domain}\0${value}`))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function iso(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}

function timestampMs(value: Date | string | null): number | null {
  if (value === null || value === undefined) return null
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

/** Routes and services the GoTrue-compatible `/auth/v1/*` endpoints. */
export class AuthHandler {
  private oauth: OAuthService
  /** Shared, runtime-mutable settings - read on every request, never copied. */
  private settings: AuthSettings
  private rateLimiter: RateLimiter | null
  private phoneDeliveries = new Set<Promise<void>>()

  constructor(
    private db: Database,
    private config: AuthConfig
  ) {
    this.oauth = new OAuthService(
      db,
      config.apiUrl,
      config.siteUrl,
      config.oauthProviders ?? {},
      config.oauthFetch ?? fetch,
      config.uriAllowList,
      config.enforceRedirectAllowList
    )
    this.settings = config.settings ?? { ...DEFAULT_AUTH_SETTINGS }
    this.rateLimiter = config.rateLimiter === undefined ? new RateLimiter() : config.rateLimiter
  }

  /**
   * Enforce the rate limit for `action`, keyed by client address. Returns a 429
   * (GoTrue's `over_request_rate_limit`) when exceeded, else null to proceed.
   */
  private limit(action: string, req: Request): Response | null {
    const client = req.headers.get('x-supacloud-lite-remote-addr') ?? 'local'
    return this.limitKey(action, `ip:${client}`)
  }

  private limitKey(action: string, key: string): Response | null {
    if (!this.rateLimiter) return null
    const retryAfter = this.rateLimiter.check(action, key)
    if (retryAfter === null) return null
    return new Response(
      JSON.stringify({ code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }),
      { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(retryAfter) } }
    )
  }

  /** Stop background timers (rate-limiter sweep). Called on backend close. */
  async stop(): Promise<void> {
    this.rateLimiter?.stop()
    await Promise.all(this.phoneDeliveries)
  }

  /** Dispatch one `/auth/v1/*` request. Any thrown error becomes a 500 `unexpected_failure`. */
  async handle(req: Request, ctx: RequestContext, url: URL): Promise<Response> {
    const path = url.pathname.replace(/^\/auth\/v1\/?/, '').replace(/\/+$/, '')
    const method = req.method.toUpperCase()

    try {
      if (path === 'health') return json(200, { name: 'supacloud-lite-auth', version: SUPACLOUD_LITE_VERSION, description: 'GoTrue-compatible auth' })
      if (path === 'settings') {
        const providers = Object.keys(this.config.oauthProviders ?? {})
        return json(200, {
          external: {
            email: true,
            phone: this.settings.smsEnabled && this.config.smsSender != null,
            anonymous_users: this.settings.anonymousUsers,
            ...Object.fromEntries(providers.map((p) => [p, !this.settings.disabledProviders.includes(p)])),
          },
          disable_signup: this.settings.disableSignup,
          autoconfirm: this.settings.autoconfirm,
          mailer_autoconfirm: this.settings.autoconfirm,
          minimum_password_length: this.settings.minPasswordLength,
        })
      }
      if (path === 'signup' && method === 'POST') return this.limit('signup', req) ?? (await this.signup(req))
      if (path === 'token' && method === 'POST') return this.limit('token', req) ?? (await this.token(req, url))
      if (path === 'user' && method === 'GET') return await this.getUser(req)
      if (path === 'user' && method === 'PUT') return await this.updateUser(req)
      if (path === 'logout' && method === 'POST') return await this.logout(req, url)
      if (path === 'otp' && method === 'POST') return await this.sendOtp(req)
      if (path === 'recover' && method === 'POST') return this.limit('recover', req) ?? (await this.sendRecovery(req))
      if (['magiclink', 'resend'].includes(path) && method === 'POST')
        return await this.sendOtp(req)
      if (path === 'verify' && method === 'POST') return this.limit('verify', req) ?? (await this.verifyToken(req))
      if (path === 'verify' && method === 'GET') return await this.verifyLink(url)
      if (path === 'factors' && method === 'POST') return await this.enrollFactor(req)
      if (/^factors\/[^/]+\/challenge$/.test(path) && method === 'POST')
        return await this.challengeFactor(req, path.split('/')[1])
      if (/^factors\/[^/]+\/verify$/.test(path) && method === 'POST')
        return await this.verifyFactor(req, path.split('/')[1])
      if (/^factors\/[^/]+$/.test(path) && method === 'DELETE')
        return await this.unenrollFactor(req, path.split('/')[1])
      if (path === 'authorize' && method === 'GET') {
        const provider = url.searchParams.get('provider') ?? ''
        if (provider && this.settings.disabledProviders.includes(provider)) {
          return authError(422, 'provider_disabled', `Sign-ins with ${provider} are disabled`)
        }
        return await this.oauth.authorize(url)
      }
      if (path === 'callback' && (method === 'GET' || method === 'POST')) {
        return await this.oauth.callback(url, (userId) => this.sessionTokensFor(userId))
      }
      if (path.startsWith('admin/')) return await this.admin(req, ctx, path, method)
      return authError(404, 'not_found', `unknown auth endpoint: ${path}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return authError(500, 'unexpected_failure', msg)
    }
  }

  // ── flows ─────────────────────────────────────────────────────────────

  private async signup(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      password?: string
      data?: Record<string, unknown>
    }

    if (!body.email && !body.password) {
      // supabase.auth.signInAnonymously()
      if (!this.settings.anonymousUsers) {
        return authError(422, 'anonymous_provider_disabled', 'Anonymous sign-ins are disabled')
      }
      const res = await this.db.query(
        `insert into auth.users (aud, role, raw_app_meta_data, raw_user_meta_data, is_anonymous, last_sign_in_at)
         values ('authenticated', 'authenticated', '{}', $1, true, now())
         returning *`,
        [JSON.stringify(body.data ?? {})]
      )
      return json(200, await this.sessionFor(res.rows[0] as UserRow))
    }

    if (this.settings.disableSignup) {
      return authError(422, 'signup_disabled', 'Signups not allowed for this instance')
    }
    if (!body.email || !body.password) {
      return authError(400, 'validation_failed', 'Signup requires a valid email and password')
    }
    if (body.password.length < this.settings.minPasswordLength) {
      return authError(422, 'weak_password', `Password should be at least ${this.settings.minPasswordLength} characters.`)
    }
    const email = body.email.toLowerCase().trim()
    const existing = await this.db.query(`select id from auth.users where email = $1`, [email])
    if (existing.rows.length > 0) {
      return authError(422, 'user_already_exists', 'User already registered')
    }
    const hashed = await hashPassword(body.password)
    const autoconfirm = this.settings.autoconfirm
    const res = await this.db.query(
      `insert into auth.users
         (aud, role, email, encrypted_password, email_confirmed_at, last_sign_in_at,
          raw_app_meta_data, raw_user_meta_data)
       values ('authenticated', 'authenticated', $1, $2, case when $4 then now() else null end, now(),
               '{"provider":"email","providers":["email"]}', $3)
       returning *`,
      [email, hashed, JSON.stringify(body.data ?? {}), autoconfirm]
    )
    const newUser = res.rows[0] as UserRow
    // GoTrue records an `email` identity at signup, so user.identities reflects
    // the email provider (getUser returned [] before this). Mirrors the shape
    // written on anonymous-to-email upgrade.
    await this.db.query(
      `insert into auth.identities (user_id, provider, provider_id, identity_data)
       values ($1, 'email', $2, $3)
       on conflict (provider, provider_id) do nothing`,
      [newUser.id, newUser.id, JSON.stringify({ sub: newUser.id, email: newUser.email })]
    )
    await this.audit('user_signedup', { actorId: newUser.id, actorEmail: email })
    if (!autoconfirm) {
      // confirmation required: email a verification link/code; no session yet
      await this.issueToken(email, 'otp', false, 'confirm')
      return json(200, this.userJson(newUser))
    }
    return json(200, await this.sessionFor(newUser))
  }

  private async token(req: Request, url: URL): Promise<Response> {
    const grantType = url.searchParams.get('grant_type')
    const body = (await req.json().catch(() => ({}))) as Record<string, string>

    if (grantType === 'password') {
      const email = (body.email ?? '').toLowerCase().trim()
      const res = await this.db.query(`select * from auth.users where email = $1`, [email])
      const user = res.rows[0] as UserRow | undefined
      if (!user || !user.encrypted_password || !(await verifyPassword(body.password ?? '', user.encrypted_password))) {
        await this.audit('login_failed', { actorEmail: email, traits: { grant_type: 'password' } })
        return authError(400, 'invalid_credentials', 'Invalid login credentials')
      }
      // when confirmation is required, unverified accounts cannot sign in yet
      if (!this.settings.autoconfirm && !user.email_confirmed_at) {
        return authError(400, 'email_not_confirmed', 'Email not confirmed')
      }
      await this.db.query(`update auth.users set last_sign_in_at = now() where id = $1`, [user.id])
      await this.audit('login', { actorId: user.id, actorEmail: user.email, traits: { grant_type: 'password' } })
      return json(200, await this.sessionFor(user))
    }

    if (grantType === 'refresh_token') {
      const token = body.refresh_token
      if (!token) return authError(400, 'validation_failed', 'refresh_token required')
      return this.rotateRefreshToken(token)
    }

    if (grantType === 'pkce') {
      const authCode = body.auth_code
      const verifier = body.code_verifier
      if (!authCode || !verifier) return authError(400, 'validation_failed', 'auth_code and code_verifier required')
      const userId = await this.oauth.exchangePkce(authCode, verifier)
      if (!userId) return authError(403, 'flow_state_not_found', 'invalid or expired auth code')
      const ures = await this.db.query(`select * from auth.users where id = $1`, [userId])
      return json(200, await this.sessionFor(ures.rows[0] as UserRow))
    }

    return authError(400, 'invalid_grant', `unsupported grant_type: ${grantType}`)
  }

  private async getUser(req: Request): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (!user) return authError(401, 'no_authorization', 'Invalid or expired token')
    return json(200, this.userJson(user, await this.getUserFactors(user.id), await this.getUserIdentities(user.id)))
  }

  private async updateUser(req: Request): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (!user) return authError(401, 'no_authorization', 'Invalid or expired token')
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      password?: string
      data?: Record<string, unknown>
    }
    const sets: string[] = []
    const params: unknown[] = []
    if (body.email && !this.settings.autoconfirm) {
      return authError(
        501,
        'email_change_confirmation_not_supported',
        'Email changes that require confirmation are not supported by SupaCloud Lite V1'
      )
    }
    // Upgrading an anonymous user to a permanent one: adding an email (and
    // usually a password) keeps the same id + data, flips is_anonymous off, and
    // records an email identity - matching supabase.auth.updateUser({ email }).
    const upgradingAnon = (user.is_anonymous ?? false) && !!body.email
    if (body.email) {
      const email = body.email.toLowerCase().trim()
      const clash = await this.db.query(`select id from auth.users where email = $1 and id <> $2`, [email, user.id])
      if (clash.rows.length > 0) {
        return authError(422, 'email_exists', 'A user with this email address has already been registered')
      }
      params.push(email)
      sets.push(`email = $${params.length}, email_confirmed_at = now()`)
    }
    if (body.password) {
      if (body.password.length < this.settings.minPasswordLength) {
        return authError(422, 'weak_password', `Password should be at least ${this.settings.minPasswordLength} characters.`)
      }
      params.push(await hashPassword(body.password))
      sets.push(`encrypted_password = $${params.length}`)
    }
    if (body.data) {
      params.push(JSON.stringify(body.data))
      sets.push(`raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || $${params.length}::jsonb`)
    }
    if (upgradingAnon) {
      sets.push(`is_anonymous = false`)
      sets.push(`raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"provider":"email","providers":["email"]}'::jsonb`)
    }
    if (sets.length === 0) return json(200, this.userJson(user))
    params.push(user.id)
    const res = await this.db.query(
      `update auth.users set ${sets.join(', ')}, updated_at = now() where id = $${params.length} returning *`,
      params
    )
    const updated = res.rows[0] as UserRow
    if (upgradingAnon) {
      // record the email identity, unless one somehow already exists
      await this.db.query(
        `insert into auth.identities (user_id, provider, provider_id, identity_data)
         values ($1, 'email', $2, $3)
         on conflict (provider, provider_id) do nothing`,
        [updated.id, updated.id, JSON.stringify({ sub: updated.id, email: updated.email })]
      )
    }
    return json(200, this.userJson(updated))
  }

  private async logout(req: Request, url: URL): Promise<Response> {
    const claims = await this.claimsFromBearer(req)
    if (claims?.sub) {
      const scope = url.searchParams.get('scope') ?? 'global'
      const sessionId = typeof claims.session_id === 'string' ? claims.session_id : null
      if (scope === 'local' && sessionId) {
        await this.db.query(`update auth.refresh_tokens set revoked = true where session_id = $1`, [sessionId])
      } else if (scope === 'others' && sessionId) {
        await this.db.query(`update auth.refresh_tokens set revoked = true where user_id = $1 and session_id <> $2`, [
          claims.sub,
          sessionId,
        ])
      } else {
        await this.db.query(`update auth.refresh_tokens set revoked = true where user_id = $1`, [claims.sub])
      }
      const result = await this.db.query<UserRow>(`select * from auth.users where id = $1`, [claims.sub])
      const user = result.rows[0]
      if (user) await this.audit('logout', { actorId: user.id, actorEmail: user.email })
    }
    return new Response(null, { status: 204 })
  }

  // ── OTP / magic links / recovery ──────────────────────────────────────

  private async issueToken(
    email: string,
    tokenType: 'otp' | 'recovery',
    createUser: boolean,
    flavor: 'login' | 'confirm' = 'login'
  ): Promise<Response> {
    const normalized = email.toLowerCase().trim()
    let res = await this.db.query(`select * from auth.users where email = $1`, [normalized])
    let user = res.rows[0] as UserRow | undefined
    if (!user) {
      if (!createUser) return authError(422, 'otp_disabled', 'Signups not allowed for otp')
      if (this.settings.disableSignup) return authError(422, 'signup_disabled', 'Signups not allowed for this instance')
      res = await this.db.query(
        `insert into auth.users (aud, role, email, raw_app_meta_data, raw_user_meta_data)
         values ('authenticated', 'authenticated', $1, '{"provider":"email","providers":["email"]}', '{}')
         returning *`,
        [normalized]
      )
      user = res.rows[0] as UserRow
    }
    const code = randomOtp(this.settings.otpLength)
    const linkToken = randomToken(24)
    const expiry = `${this.settings.otpExpirySeconds} seconds`
    await this.db.query(`delete from auth.one_time_tokens where email = $1 and token_type = $2`, [normalized, tokenType])
    await this.db.query(
      `insert into auth.one_time_tokens (user_id, email, token_type, token, expires_at)
       values ($1, $2, $3, $4, now() + $7::interval), ($1, $2, $5, $6, now() + $7::interval)`,
      [user.id, normalized, tokenType, code, tokenType === 'otp' ? 'magiclink' : tokenType, linkToken, expiry]
    )
    const kind = tokenType === 'otp' ? 'magiclink' : tokenType
    const link = `${this.config.apiUrl}/auth/v1/verify?token=${linkToken}&type=${kind}`
    await this.config.mailer.send({
      to: normalized,
      subject: tokenType === 'recovery' ? 'Reset your password' : flavor === 'confirm' ? 'Confirm your email' : 'Your login code',
      text:
        tokenType === 'recovery'
          ? `Reset your password with this link: ${link}\n\nOr use code ${code}`
          : flavor === 'confirm'
            ? `Confirm your email address with this link: ${link}\n\nOr enter the code ${code}`
            : `Your one-time code is ${code}\n\nOr sign in with this link: ${link}`,
    })
    return json(200, {})
  }

  private async sendOtp(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      phone?: string
      create_user?: boolean
      channel?: string
      data?: Record<string, unknown>
    }
    if (body.email && body.phone) return authError(400, 'validation_failed', 'email and phone are mutually exclusive')
    if (body.phone !== undefined) {
      if (body.channel !== undefined && body.channel !== 'sms') {
        return authError(422, 'unsupported_channel', 'Only the sms phone channel is supported')
      }
      const phone = normalizePhone(body.phone)
      if (!phone) return authError(400, 'validation_failed', 'phone must be a valid E.164 number')
      return this.limit('sms', req) ?? this.issuePhoneToken(phone, body.create_user !== false, recordValue(body.data))
    }
    if (!body.email) return authError(400, 'validation_failed', 'email or phone is required')
    return this.limit('otp', req) ?? this.issueToken(body.email, 'otp', body.create_user !== false)
  }

  private async issuePhoneToken(
    phone: string,
    createUser: boolean,
    metadata: Record<string, unknown>
  ): Promise<Response> {
    const sender = this.config.smsSender
    if (!this.settings.smsEnabled || !sender) {
      return authError(422, 'phone_provider_disabled', 'Phone sign-ins are disabled')
    }

    const fingerprint = await keyedDigest(this.config.jwtSecret, 'supacloud-lite:phone-fingerprint:v1', phone)
    const limited = this.limitKey('sms', `phone:${fingerprint}`)
    if (limited) return limited

    const code = randomOtp(this.settings.otpLength)
    const tokenDigest = `hmac-sha256:v1:${await keyedDigest(
      this.config.jwtSecret,
      'supacloud-lite:phone-otp:v1',
      `${phone}\0${code}`
    )}`
    const issuanceId = crypto.randomUUID()
    const prepared = await this.preparePhoneOtp({
      phone,
      createUser,
      metadata,
      fingerprint,
      tokenDigest,
      issuanceId,
      eligibleBefore: new Date(Date.now() - this.settings.smsOtpCooldownSeconds * 1000).toISOString(),
      expiry: `${this.settings.otpExpirySeconds} seconds`,
    })

    if (prepared.state === 'cooldown') {
      return authError(429, 'over_sms_send_rate_limit', 'SMS can only be requested after the cooldown')
    }
    if (prepared.state === 'signup_disabled') {
      return authError(422, 'signup_disabled', 'Signups not allowed for this instance')
    }
    if (prepared.state === 'unknown') return json(200, {})

    const body = this.settings.smsTemplate.replace(/\{\{\s*\.Code\s*\}\}/g, code)
    const delivery = createUser
      ? this.deliverPhoneOtp(prepared, sender, phone, body, true)
      : this.deferPhoneOtpDelivery(prepared, sender, phone, body)
    if (!createUser) {
      this.trackPhoneDelivery(delivery)
      return json(200, {})
    }
    return await delivery
      ? json(200, {})
      : authError(502, 'sms_provider_failed', 'Unable to send the verification code')
  }

  private async preparePhoneOtp(request: PhoneOtpIssueRequest): Promise<PhoneOtpPreparation> {
    try {
      return await this.db.transaction(async (query) => {
        const cooldown = await query(
          `insert into auth.phone_otp_cooldowns (phone_fingerprint, issuance_id, last_sent_at)
           values ($1, $2, now())
           on conflict (phone_fingerprint) do update
           set issuance_id = excluded.issuance_id, last_sent_at = excluded.last_sent_at
           where auth.phone_otp_cooldowns.last_sent_at <= $3::timestamptz
           returning phone_fingerprint`,
          [request.fingerprint, request.issuanceId, request.eligibleBefore]
        )
        if (cooldown.rows.length === 0) return { state: 'cooldown' }

        const resolved = await this.phoneUser(query, request)
        if (resolved === 'unknown' || resolved === 'signup_disabled') return { state: resolved }
        await this.createPhoneIdentity(query, resolved)
        await query(`delete from auth.one_time_tokens where phone = $1 and token_type = 'sms'`, [request.phone])
        await query(
          `insert into auth.one_time_tokens (id, user_id, phone, token_type, token, expires_at)
           values ($1, $2, $3, 'sms', $4, now() + $5::interval)`,
          [request.issuanceId, resolved.id, request.phone, request.tokenDigest, request.expiry]
        )
        return {
          state: 'issued', id: request.issuanceId,
          fingerprint: request.fingerprint, tokenDigest: request.tokenDigest,
        }
      })
    } catch (error) {
      this.reportPhoneFailure('issue', databaseDiagnosticCode(error))
      throw new Error('Unable to issue the verification code', { cause: error })
    }
  }

  private async phoneUser(
    query: Querier,
    request: PhoneOtpIssueRequest
  ): Promise<UserRow | 'unknown' | 'signup_disabled'> {
    const existing = await query<UserRow>(`select * from auth.users where phone = $1`, [request.phone])
    if (existing.rows[0]) return existing.rows[0]
    if (!request.createUser) return 'unknown'
    if (this.settings.disableSignup || !this.settings.smsSignupEnabled) return 'signup_disabled'
    const inserted = await query<UserRow>(
      `insert into auth.users (aud, role, phone, raw_app_meta_data, raw_user_meta_data)
       values ('authenticated', 'authenticated', $1, $2::jsonb, $3::jsonb)
       on conflict (phone) do nothing returning *`,
      [
        request.phone,
        JSON.stringify({ provider: 'phone', providers: ['phone'] }),
        JSON.stringify(request.metadata),
      ]
    )
    if (inserted.rows[0]) return inserted.rows[0]
    const concurrent = await query<UserRow>(`select * from auth.users where phone = $1`, [request.phone])
    if (!concurrent.rows[0]) throw new Error('phone user could not be resolved')
    return concurrent.rows[0]
  }

  private createPhoneIdentity(query: Querier, user: UserRow): Promise<unknown> {
    return query(
      `insert into auth.identities (user_id, provider, provider_id, identity_data)
       values ($1, 'phone', $2, $3::jsonb)
       on conflict (provider, provider_id) do nothing`,
      [user.id, user.phone, JSON.stringify({ sub: user.id, phone: user.phone, phone_verified: user.phone_confirmed_at != null })]
    )
  }

  private async deliverPhoneOtp(
    issuance: Extract<PhoneOtpPreparation, { state: 'issued' }>,
    sender: SmsSender,
    phone: string,
    body: string,
    releaseCooldownOnFailure: boolean
  ): Promise<boolean> {
    try {
      await sender.send({ to: phone, body })
      return true
    } catch {
      this.reportPhoneFailure('deliver', 'provider_error')
      try {
        await this.db.transaction(async (query) => {
          await query(`delete from auth.one_time_tokens where id = $1 and token = $2`, [issuance.id, issuance.tokenDigest])
          if (releaseCooldownOnFailure) {
            await query(
              `delete from auth.phone_otp_cooldowns where phone_fingerprint = $1 and issuance_id = $2`,
              [issuance.fingerprint, issuance.id]
            )
          }
        })
      } catch (cleanupError) {
        this.reportPhoneFailure('cleanup', databaseDiagnosticCode(cleanupError))
      }
      return false
    }
  }

  private async deferPhoneOtpDelivery(
    issuance: Extract<PhoneOtpPreparation, { state: 'issued' }>,
    sender: SmsSender,
    phone: string,
    body: string
  ): Promise<boolean> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    return this.deliverPhoneOtp(issuance, sender, phone, body, false)
  }

  private trackPhoneDelivery(delivery: Promise<boolean>): void {
    let tracked: Promise<void>
    tracked = delivery.then(() => {}).finally(() => this.phoneDeliveries.delete(tracked))
    this.phoneDeliveries.add(tracked)
  }

  private reportPhoneFailure(operation: string, code: string): void {
    try {
      this.config.log?.(`[auth] phone_otp_${operation} failed code=${code}`)
    } catch {
      // A broken diagnostic sink must not change the sanitized auth response.
    }
  }

  private async sendRecovery(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { email?: string }
    if (!body.email) return authError(400, 'validation_failed', 'email is required')
    return this.issueToken(body.email, 'recovery', false)
  }

  /** Max wrong guesses for a one-time code before its tokens are invalidated. */
  private static readonly MAX_OTP_ATTEMPTS = 5

  private async redeem(token: string, types: string[], email?: string): Promise<UserRow | null> {
    const normalizedEmail = email?.toLowerCase().trim() ?? null
    const res = await this.db.query(
      `delete from auth.one_time_tokens
       where token = $1 and token_type = any($2::text[])
         and ($3::text is null or email = $3) and expires_at > now()
         and attempts < $4
       returning user_id, email`,
      [token, `{${types.join(',')}}`, normalizedEmail, AuthHandler.MAX_OTP_ATTEMPTS]
    )
    const row = res.rows[0] as { user_id: string; email: string } | undefined
    if (!row) {
      // Wrong/expired code: count the failed guess against the live tokens for
      // this email, and burn them once the attempt cap is hit (brute-force
      // lockout for the 6-digit OTP). Requires the email to scope the counter.
      if (normalizedEmail) {
        await this.db.query(
          `update auth.one_time_tokens set attempts = attempts + 1
           where email = $1 and token_type = any($2::text[]) and expires_at > now()`,
          [normalizedEmail, `{${types.join(',')}}`]
        )
        await this.db.query(
          `delete from auth.one_time_tokens where email = $1 and attempts >= $2`,
          [normalizedEmail, AuthHandler.MAX_OTP_ATTEMPTS]
        )
      }
      return null
    }
    await this.db.query(`delete from auth.one_time_tokens where email = $1`, [row.email])
    const ures = await this.db.query(
      `update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()), last_sign_in_at = now()
       where id = $1 returning *`,
      [row.user_id]
    )
    return (ures.rows[0] as UserRow) ?? null
  }

  private async verifyToken(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { type?: string; email?: string; phone?: string; token?: string }
    if (!body.token) return authError(400, 'validation_failed', 'token is required')
    if (body.type === 'sms' || body.phone !== undefined) {
      const phone = normalizePhone(body.phone)
      if (body.type !== 'sms' || !phone || !/^\d{6,10}$/.test(body.token)) {
        return authError(400, 'validation_failed', 'phone, token, and type=sms are required')
      }
      const fingerprint = await keyedDigest(this.config.jwtSecret, 'supacloud-lite:phone-fingerprint:v1', phone)
      const limited = this.limitKey('verify', `phone:${fingerprint}`)
      if (limited) return limited
      let session: Record<string, unknown> | null
      try {
        session = await this.redeemPhoneOtp(phone, body.token)
      } catch (error) {
        this.reportPhoneFailure('verify', databaseDiagnosticCode(error))
        return authError(500, 'unexpected_failure', 'Unable to verify the code')
      }
      if (!session) return authError(403, 'otp_expired', 'Token has expired or is invalid')
      return json(200, session)
    }
    // A recovery (password-reset) token must be redeemed with type=recovery
    // explicitly - never fold it into the default set, or a guessed login OTP
    // could mint a recovery session.
    const types =
      body.type === 'recovery' ? ['recovery'] : body.type === 'magiclink' ? ['magiclink'] : ['otp', 'magiclink']
    const user = await this.redeem(body.token, types, body.email)
    if (!user) return authError(403, 'otp_expired', 'Token has expired or is invalid')
    return json(200, await this.sessionFor(user))
  }

  private async redeemPhoneOtp(phone: string, code: string): Promise<Record<string, unknown> | null> {
    const tokenDigest = `hmac-sha256:v1:${await keyedDigest(
      this.config.jwtSecret,
      'supacloud-lite:phone-otp:v1',
      `${phone}\0${code}`
    )}`
    return this.db.transaction(async (query) => {
      const claimed = await query<{ user_id: string }>(
        `delete from auth.one_time_tokens
         where phone = $1 and token_type = 'sms' and token = $2
           and expires_at > now() and attempts < $3
         returning user_id`,
        [phone, tokenDigest, AuthHandler.MAX_OTP_ATTEMPTS]
      )
      const userId = claimed.rows[0]?.user_id
      if (!userId) {
        const attempt = await query<{ id: string; attempts: number }>(
          `update auth.one_time_tokens set attempts = attempts + 1
           where phone = $1 and token_type = 'sms' and expires_at > now()
           returning id, attempts`,
          [phone]
        )
        const row = attempt.rows[0]
        if (row && row.attempts >= AuthHandler.MAX_OTP_ATTEMPTS) {
          await query(`delete from auth.one_time_tokens where id = $1`, [row.id])
        }
        await query(`delete from auth.one_time_tokens where phone = $1 and expires_at <= now()`, [phone])
        return null
      }

      await query(`delete from auth.one_time_tokens where phone = $1`, [phone])
      const users = await query<UserRow>(
        `update auth.users
         set phone_confirmed_at = coalesce(phone_confirmed_at, now()), last_sign_in_at = now(), updated_at = now()
         where id = $1 returning *`,
        [userId]
      )
      const user = users.rows[0]
      if (!user) throw new Error('phone OTP user no longer exists')
      await query(
        `insert into auth.identities (user_id, provider, provider_id, identity_data, last_sign_in_at)
         values ($1, 'phone', $2, $3::jsonb, now())
         on conflict (provider, provider_id) do update
         set identity_data = excluded.identity_data, last_sign_in_at = now(), updated_at = now()`,
        [user.id, phone, JSON.stringify({ sub: user.id, phone, phone_verified: true })]
      )
      return this.sessionFor(
        user,
        undefined,
        { amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }] },
        query
      )
    })
  }

  private async verifyLink(url: URL): Promise<Response> {
    const token = url.searchParams.get('token') ?? ''
    const type = url.searchParams.get('type') ?? 'magiclink'
    // Never redirect (with the freshly minted session tokens) to an origin the
    // operator hasn't allowed - a crafted magic-link would otherwise exfiltrate
    // the session. Unknown targets fall back to the site URL.
    const redirectTo = resolveRedirect(
      url.searchParams.get('redirect_to'),
      this.config.siteUrl,
      this.config.uriAllowList,
      this.config.enforceRedirectAllowList
    )
    const user = await this.redeem(token, [type])
    if (!user) {
      return new Response(null, { status: 303, headers: { location: `${redirectTo}#error=access_denied&error_code=otp_expired` } })
    }
    const session = (await this.sessionFor(user)) as { access_token: string; refresh_token: string; expires_in: number }
    const hash = `#access_token=${session.access_token}&refresh_token=${session.refresh_token}&expires_in=${session.expires_in}&token_type=bearer&type=${type}`
    return new Response(null, { status: 303, headers: { location: `${redirectTo}${hash}` } })
  }

  // ── admin ─────────────────────────────────────────────────────────────

  private async admin(req: Request, ctx: RequestContext, path: string, method: string): Promise<Response> {
    if (ctx.role !== 'service_role') {
      return authError(403, 'insufficient_permissions', 'Admin endpoints require the service_role key')
    }
    const idMatch = path.match(/^admin\/users\/([0-9a-f-]{36})$/)
    const exportMatch = path.match(/^admin\/users\/([0-9a-f-]{36})\/export$/)

    if (path === 'admin/audit' && method === 'GET') {
      const res = await this.db.query(
        `select id, payload, created_at, ip_address from auth.audit_log_entries
         order by created_at desc limit 200`
      )
      return json(200, { entries: res.rows })
    }

    if (exportMatch && method === 'GET') {
      return await this.exportUser(exportMatch[1])
    }

    if (path === 'admin/users' && method === 'GET') {
      const res = await this.db.query(`select * from auth.users order by created_at desc limit 1000`)
      return json(200, { users: (res.rows as UserRow[]).map((u) => this.userJson(u)), aud: 'authenticated' })
    }
    if (path === 'admin/users' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        email?: string
        password?: string
        email_confirm?: boolean
        user_metadata?: Record<string, unknown>
        app_metadata?: Record<string, unknown>
      }
      if (!body.email) return authError(400, 'validation_failed', 'email is required')
      const hashed = body.password ? await hashPassword(body.password) : null
      const res = await this.db.query(
        `insert into auth.users
           (aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
         values ('authenticated', 'authenticated', $1, $2, case when $3 then now() else null end, $4, $5)
         returning *`,
        [
          body.email.toLowerCase().trim(),
          hashed,
          body.email_confirm ?? true,
          JSON.stringify({ provider: 'email', providers: ['email'], ...(body.app_metadata ?? {}) }),
          JSON.stringify(body.user_metadata ?? {}),
        ]
      )
      return json(200, this.userJson(res.rows[0] as UserRow))
    }
    if (idMatch && method === 'GET') {
      const res = await this.db.query(`select * from auth.users where id = $1`, [idMatch[1]])
      if (res.rows.length === 0) return authError(404, 'user_not_found', 'User not found')
      return json(200, this.userJson(res.rows[0] as UserRow))
    }
    if (idMatch && method === 'PUT') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      const sets: string[] = []
      const params: unknown[] = []
      if (typeof body.email === 'string') {
        params.push(body.email.toLowerCase().trim())
        sets.push(`email = $${params.length}`)
      }
      if (typeof body.password === 'string') {
        params.push(await hashPassword(body.password))
        sets.push(`encrypted_password = $${params.length}`)
      }
      if (body.user_metadata) {
        params.push(JSON.stringify(body.user_metadata))
        sets.push(`raw_user_meta_data = $${params.length}::jsonb`)
      }
      if (body.app_metadata) {
        params.push(JSON.stringify(body.app_metadata))
        sets.push(`raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || $${params.length}::jsonb`)
      }
      if (body.email_confirm === true) sets.push(`email_confirmed_at = now()`)
      if (sets.length === 0) return authError(400, 'validation_failed', 'nothing to update')
      params.push(idMatch[1])
      const res = await this.db.query(
        `update auth.users set ${sets.join(', ')}, updated_at = now() where id = $${params.length} returning *`,
        params
      )
      if (res.rows.length === 0) return authError(404, 'user_not_found', 'User not found')
      return json(200, this.userJson(res.rows[0] as UserRow))
    }
    if (idMatch && method === 'DELETE') {
      return await this.eraseUser(idMatch[1])
    }
    return authError(404, 'not_found', `unknown admin endpoint`)
  }

  // ── audit trail ───────────────────────────────────────────────────────

  /**
   * Append a security event to auth.audit_log_entries (GoTrue-compatible
   * payload). Best-effort: a logging failure never breaks the request.
   */
  private async audit(
    action: string,
    opts: { actorId?: string | null; actorEmail?: string | null; type?: string; traits?: Record<string, unknown> } = {}
  ): Promise<void> {
    try {
      const payload = {
        action,
        actor_id: opts.actorId ?? null,
        actor_username: opts.actorEmail ?? null,
        log_type: opts.type ?? 'account',
        traits: opts.traits ?? {},
        timestamp: new Date().toISOString(),
      }
      await this.db.query(`insert into auth.audit_log_entries (payload) values ($1::jsonb)`, [JSON.stringify(payload)])
    } catch {
      // audit logging is best-effort
    }
  }

  // ── GDPR: data-subject access (export) ────────────────────────────────

  /**
   * Export everything held about one user across the auth schema, for a GDPR
   * right-of-access / portability request. Credentials (password hash, MFA
   * secrets, raw token values) are deliberately omitted - they are not personal
   * data to hand back and exporting them would leak secrets.
   */
  private async exportUser(userId: string): Promise<Response> {
    const ures = await this.db.query(`select * from auth.users where id = $1`, [userId])
    if (ures.rows.length === 0) return authError(404, 'user_not_found', 'User not found')
    const user = ures.rows[0] as UserRow & Record<string, unknown>

    const identities = await this.db.query(
      `select id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at
       from auth.identities where user_id = $1`,
      [userId]
    )
    const sessions = await this.db.query(
      `select id, parent, session_id, revoked, created_at, updated_at
       from auth.refresh_tokens where user_id = $1`,
      [userId]
    )
    const factors = await this.db.query(
      `select id, friendly_name, factor_type, status, created_at, updated_at
       from auth.mfa_factors where user_id = $1`,
      [userId]
    )

    // strip credential/token columns from the raw record before returning it
    const SENSITIVE = [
      'encrypted_password',
      'confirmation_token',
      'recovery_token',
      'email_change_token_new',
      'email_change_token_current',
      'phone_change_token',
      'reauthentication_token',
    ]
    const userSafe = Object.fromEntries(Object.entries(user).filter(([k]) => !SENSITIVE.includes(k)))
    await this.audit('user_data_exported', { actorId: userId, type: 'admin' })
    return json(200, {
      exported_at: new Date().toISOString(),
      user: this.userJson(user),
      user_record: userSafe,
      identities: identities.rows,
      sessions: sessions.rows,
      mfa_factors: factors.rows,
    })
  }

  /**
   * Erase a user (GDPR right to erasure). Deletes the user row; auth.identities,
   * refresh_tokens, one_time_tokens, flow_state, and mfa_factors/challenges are
   * removed by their ON DELETE CASCADE foreign keys. Returns a 404 if the user
   * doesn't exist and a summary of what was erased.
   *
   * Note: storage.objects.owner has no FK to auth.users, so object rows/bytes
   * owned by the user are not removed here - see COMPLIANCE.md for the
   * storage-erasure step the operator must run.
   */
  private async eraseUser(userId: string): Promise<Response> {
    const before = await this.db.query<{ identities: number; sessions: number; factors: number }>(
      `select
         (select count(*) from auth.identities where user_id = $1)::int as identities,
         (select count(*) from auth.refresh_tokens where user_id = $1)::int as sessions,
         (select count(*) from auth.mfa_factors where user_id = $1)::int as factors`,
      [userId]
    )
    const del = await this.db.query(`delete from auth.users where id = $1 returning id`, [userId])
    if (del.rows.length === 0) return authError(404, 'user_not_found', 'User not found')
    const c = before.rows[0]
    await this.audit('user_deleted', { actorId: userId, type: 'admin', traits: { erased: true } })
    return json(200, {
      erased: true,
      user_id: userId,
      cascaded: { identities: c.identities, sessions: c.sessions, mfa_factors: c.factors },
    })
  }

  // ── MFA (TOTP) ────────────────────────────────────────────────────────

  private async enrollFactor(req: Request): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (!user) return authError(401, 'no_authorization', 'This endpoint requires a Bearer token')
    const body = (await req.json().catch(() => ({}))) as {
      factor_type?: string
      friendly_name?: string
      issuer?: string
    }
    const factorType = body.factor_type ?? 'totp'
    if (factorType !== 'totp') {
      return authError(422, 'validation_failed', 'Only the totp factor type is supported')
    }
    if (!this.settings.totpEnrollEnabled) {
      return authError(422, 'mfa_totp_enroll_disabled', 'TOTP enrollment is disabled')
    }
    const enrolled = await this.db.query(
      `select count(*)::int as n from auth.mfa_factors where user_id = $1`,
      [user.id]
    )
    if ((enrolled.rows[0] as { n: number }).n >= this.settings.maxEnrolledFactors) {
      return authError(422, 'too_many_enrolled_mfa_factors', 'Maximum number of enrolled MFA factors reached')
    }
    const friendlyName = body.friendly_name ?? null
    if (friendlyName) {
      const dup = await this.db.query(
        `select 1 from auth.mfa_factors where user_id = $1 and friendly_name = $2`,
        [user.id, friendlyName]
      )
      if (dup.rows.length > 0) {
        return authError(422, 'mfa_factor_name_conflict', 'A factor with this friendly name already exists')
      }
    }
    const secret = generateTotpSecret()
    let issuer = body.issuer
    if (!issuer) {
      try {
        issuer = new URL(this.config.siteUrl).host || 'supacloud-lite'
      } catch {
        issuer = 'supacloud-lite'
      }
    }
    const uri = otpauthUri({ secret, account: user.email || user.id, issuer })
    const ins = await this.db.query(
      `insert into auth.mfa_factors (user_id, friendly_name, factor_type, status, secret)
       values ($1, $2, 'totp', 'unverified', $3) returning id`,
      [user.id, friendlyName, secret]
    )
    const id = (ins.rows[0] as { id: string }).id
    return json(200, {
      id,
      type: 'totp',
      friendly_name: friendlyName,
      status: 'unverified',
      totp: { qr_code: qrSvgDataUri(uri), secret, uri },
    })
  }

  private async challengeFactor(req: Request, factorId: string): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (!user) return authError(401, 'no_authorization', 'This endpoint requires a Bearer token')
    if (!this.settings.totpVerifyEnabled) {
      return authError(422, 'mfa_totp_verify_disabled', 'TOTP verification is disabled')
    }
    const fr = await this.db.query(`select id from auth.mfa_factors where id = $1 and user_id = $2`, [factorId, user.id])
    if (fr.rows.length === 0) return authError(404, 'mfa_factor_not_found', 'MFA factor not found')
    const expiresAt = new Date(Date.now() + 300_000).toISOString()
    const ins = await this.db.query(
      `insert into auth.mfa_challenges (factor_id, expires_at) values ($1, $2) returning id, expires_at`,
      [factorId, expiresAt]
    )
    const c = ins.rows[0] as { id: string; expires_at: string | Date }
    return json(200, {
      id: c.id,
      type: 'totp',
      expires_at: Math.floor(new Date(c.expires_at).getTime() / 1000),
    })
  }

  private async verifyFactor(req: Request, factorId: string): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (!user) return authError(401, 'no_authorization', 'This endpoint requires a Bearer token')
    const body = (await req.json().catch(() => ({}))) as { challenge_id?: string; code?: string }
    const fr = await this.db.query(
      `select id, secret, status from auth.mfa_factors where id = $1 and user_id = $2`,
      [factorId, user.id]
    )
    const factor = fr.rows[0] as { id: string; secret: string; status: string } | undefined
    if (!factor) return authError(404, 'mfa_factor_not_found', 'MFA factor not found')
    const cr = await this.db.query(
      `select id, expires_at, verified_at from auth.mfa_challenges where id = $1 and factor_id = $2`,
      [body.challenge_id ?? '', factorId]
    )
    const challenge = cr.rows[0] as { id: string; expires_at: string | Date; verified_at: string | Date | null } | undefined
    if (!challenge) return authError(404, 'mfa_challenge_not_found', 'MFA challenge not found')
    if (new Date(challenge.expires_at).getTime() < Date.now()) {
      return authError(422, 'mfa_challenge_expired', 'MFA challenge has expired, verify against another one')
    }
    // a challenge is single-use: once verified it cannot be replayed
    if (challenge.verified_at) {
      return authError(422, 'mfa_verification_failed', 'This challenge has already been verified')
    }
    if (!(await verifyTotp(factor.secret, body.code ?? ''))) {
      return authError(422, 'mfa_verification_failed', 'Invalid TOTP code entered')
    }
    await this.db.query(`update auth.mfa_challenges set verified_at = now() where id = $1`, [challenge.id])
    if (factor.status !== 'verified') {
      await this.db.query(`update auth.mfa_factors set status = 'verified', updated_at = now() where id = $1`, [factorId])
    }
    // elevate the session to aal2 for the same user
    const session = await this.sessionFor(user, undefined, {
      aal: 'aal2',
      amr: [
        { method: 'password', timestamp: Math.floor(Date.now() / 1000) },
        { method: 'totp', timestamp: Math.floor(Date.now() / 1000) },
      ],
    })
    return json(200, session)
  }

  private async unenrollFactor(req: Request, factorId: string): Promise<Response> {
    const user = await this.userFromBearer(req)
    if (!user) return authError(401, 'no_authorization', 'This endpoint requires a Bearer token')
    const del = await this.db.query(
      `delete from auth.mfa_factors where id = $1 and user_id = $2 returning id`,
      [factorId, user.id]
    )
    if (del.rows.length === 0) return authError(404, 'mfa_factor_not_found', 'MFA factor not found')
    return json(200, { id: factorId })
  }

  private async getUserFactors(
    userId: string,
    query: Querier = (sql, params) => this.db.query(sql, params)
  ): Promise<Record<string, unknown>[]> {
    const res = await query(
      `select id, friendly_name, factor_type, status, created_at, updated_at
       from auth.mfa_factors where user_id = $1 order by created_at`,
      [userId]
    )
    return (res.rows as Record<string, unknown>[]).map((f) => ({
      id: f.id,
      friendly_name: f.friendly_name ?? null,
      factor_type: f.factor_type,
      status: f.status,
      created_at: iso(f.created_at as Date | string | null),
      updated_at: iso(f.updated_at as Date | string | null),
    }))
  }

  /** GoTrue-shaped identities for a user (linked providers), from auth.identities. */
  private async getUserIdentities(
    userId: string,
    query: Querier = (sql, params) => this.db.query(sql, params)
  ): Promise<Record<string, unknown>[]> {
    const res = await query(
      `select id, provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at
       from auth.identities where user_id = $1 order by created_at`,
      [userId]
    )
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      identity_id: r.id,
      id: r.provider_id,
      user_id: r.user_id,
      identity_data: r.identity_data ?? {},
      provider: r.provider,
      last_sign_in_at: iso(r.last_sign_in_at as Date | string | null),
      created_at: iso(r.created_at as Date | string | null),
      updated_at: iso(r.updated_at as Date | string | null),
    }))
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private async rotateRefreshToken(token: string): Promise<Response> {
    return this.db.transaction(async (query) => {
      const claimedToken = await this.claimRefreshToken(query, token)
      if (!claimedToken) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found')
      const sessionStartedAt = await this.refreshSessionStartedAt(query, claimedToken)
      const expiryError = this.refreshExpiryError(claimedToken, sessionStartedAt)
      if (expiryError) return expiryError
      const userResult = await query(`select * from auth.users where id = $1`, [claimedToken.user_id])
      const session = await this.sessionFor(
        userResult.rows[0] as UserRow,
        token,
        {
          sessionId: claimedToken.session_id ?? undefined,
          sessionStartedAt: sessionStartedAt === null ? undefined : Math.floor(sessionStartedAt / 1000),
        },
        query
      )
      return json(200, session)
    })
  }

  private async claimRefreshToken(query: Querier, token: string): Promise<RefreshTokenRow | undefined> {
    const claimed = await query<RefreshTokenRow>(
      `update auth.refresh_tokens set revoked = true, updated_at = now()
       where token = $1 and revoked is not true
       returning user_id, session_id, created_at`,
      [token]
    )
    return claimed.rows[0]
  }

  private async refreshSessionStartedAt(query: Querier, refreshToken: RefreshTokenRow): Promise<number | null> {
    if (!refreshToken.session_id) return timestampMs(refreshToken.created_at)
    const sessionStart = await query<{ started_at: Date | string | null }>(
      `select min(created_at) as started_at from auth.refresh_tokens where session_id = $1`,
      [refreshToken.session_id]
    )
    return timestampMs(sessionStart.rows[0]?.started_at ?? null)
  }

  private refreshExpiryError(refreshToken: RefreshTokenRow, sessionStartedAt: number | null): Response | null {
    const now = Date.now()
    const lastActivity = timestampMs(refreshToken.created_at)
    if (
      this.config.sessionInactivitySeconds &&
      lastActivity !== null &&
      now - lastActivity >= this.config.sessionInactivitySeconds * 1000
    ) {
      return authError(400, 'session_expired', 'Session expired due to inactivity')
    }
    if (
      this.config.sessionTimeboxSeconds &&
      sessionStartedAt !== null &&
      now - sessionStartedAt >= this.config.sessionTimeboxSeconds * 1000
    ) {
      return authError(400, 'session_expired', 'Session expired')
    }
    return null
  }

  private async userFromBearer(req: Request): Promise<UserRow | null> {
    const claims = await this.claimsFromBearer(req)
    if (!claims?.sub) return null
    const res = await this.db.query(`select * from auth.users where id = $1`, [claims.sub])
    return (res.rows[0] as UserRow) ?? null
  }

  private async claimsFromBearer(req: Request): Promise<JwtClaims | null> {
    const authz = req.headers.get('authorization') ?? ''
    if (!authz.toLowerCase().startsWith('bearer ')) return null
    return verifyJwt(authz.slice(7), this.config.jwtSecret)
  }

  /** Shape a user row into the GoTrue user object supabase-js expects. */
  userJson(
    u: UserRow,
    factors: Record<string, unknown>[] = [],
    identities: Record<string, unknown>[] = []
  ): Record<string, unknown> {
    return {
      id: u.id,
      aud: u.aud ?? 'authenticated',
      role: u.role ?? 'authenticated',
      email: u.email ?? '',
      email_confirmed_at: iso(u.email_confirmed_at),
      phone: u.phone ?? '',
      phone_confirmed_at: iso(u.phone_confirmed_at),
      confirmed_at: iso(u.email_confirmed_at ?? u.phone_confirmed_at),
      last_sign_in_at: iso(u.last_sign_in_at),
      app_metadata: u.raw_app_meta_data ?? {},
      user_metadata: u.raw_user_meta_data ?? {},
      identities,
      factors,
      created_at: iso(u.created_at),
      updated_at: iso(u.updated_at),
      is_anonymous: u.is_anonymous ?? false,
    }
  }

  /** Session tokens for a bare user id (used by the OAuth implicit callback). */
  private async sessionTokensFor(userId: string): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    const res = await this.db.query(`select * from auth.users where id = $1`, [userId])
    const session = (await this.sessionFor(res.rows[0] as UserRow)) as {
      access_token: string
      refresh_token: string
      expires_in: number
    }
    return { access_token: session.access_token, refresh_token: session.refresh_token, expires_in: session.expires_in }
  }

  private async sessionFor(
    user: UserRow,
    parentToken?: string,
    opts?: {
      aal?: string
      amr?: { method: string; timestamp: number }[]
      sessionId?: string
      sessionStartedAt?: number
    },
    query: Querier = (sql, params) => this.db.query(sql, params)
  ): Promise<Record<string, unknown>> {
    const now = Math.floor(Date.now() / 1000)
    // Cap the access-token lifetime at the session timebox so a timeboxed
    // session can't outlive its absolute deadline (config.toml auth.sessions.timebox).
    const timeboxRemaining = this.config.sessionTimeboxSeconds
      ? opts?.sessionStartedAt !== undefined
        ? opts.sessionStartedAt + this.config.sessionTimeboxSeconds - now
        : this.config.sessionTimeboxSeconds
      : this.config.jwtExpiry
    const lifetime = Math.max(1, Math.min(this.config.jwtExpiry, timeboxRemaining))
    const expiresAt = now + lifetime
    const sessionId = opts?.sessionId ?? crypto.randomUUID()
    const claims: JwtClaims = {
      iss: `${this.config.apiUrl}/auth/v1`,
      sub: user.id,
      aud: user.aud ?? 'authenticated',
      exp: expiresAt,
      iat: now,
      email: user.email ?? '',
      phone: user.phone ?? '',
      app_metadata: user.raw_app_meta_data ?? {},
      user_metadata: user.raw_user_meta_data ?? {},
      role: user.role ?? 'authenticated',
      is_anonymous: user.is_anonymous ?? false,
      session_id: sessionId,
      aal: opts?.aal ?? 'aal1',
      amr: opts?.amr ?? [{ method: 'password', timestamp: now }],
    }
    const accessToken = await signJwt(claims, this.config.jwtSecret)
    const refreshToken = randomToken(24)
    await query(
      `insert into auth.refresh_tokens (token, user_id, parent, session_id) values ($1, $2, $3, $4)`,
      [refreshToken, user.id, parentToken ?? null, sessionId]
    )
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: lifetime,
      expires_at: expiresAt,
      refresh_token: refreshToken,
      user: this.userJson(user, await this.getUserFactors(user.id, query), await this.getUserIdentities(user.id, query)),
    }
  }
}
