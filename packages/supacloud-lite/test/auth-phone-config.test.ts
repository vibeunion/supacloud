import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'
import {
  DEFAULT_AUTH_SETTINGS,
  loadAuthSettings,
  saveAuthSettings,
} from '../src/runtime/auth/settings.js'
import { loadProjectConfig } from '../src/runtime/node/load-config.js'

test('loads SMS signup, cooldown, template, and independent send quota from config.toml', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-sms-config-'))
  try {
    await mkdir(join(projectDir, 'supabase'), { recursive: true })
    await writeFile(join(projectDir, 'supabase', 'config.toml'), `
[auth.sms]
enabled = false
enable_signup = false
max_frequency = "2s"
template = "Use {{ .Code }} to sign in"

[auth.rate_limit]
email_sent = 3
sms_sent = 7
`)
    const config = loadProjectConfig(projectDir)
    expect(config.auth.settings).toMatchObject({
      smsEnabled: false,
      smsSignupEnabled: false,
      smsOtpCooldownSeconds: 2,
      smsTemplate: 'Use {{ .Code }} to sign in',
    })
    expect(config.auth.rateLimits).toMatchObject({
      otp: { limit: 3, windowMs: 3_600_000 },
      sms: { limit: 7, windowMs: 3_600_000 },
    })
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('persists SMS settings and applies them after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'supacloud-lite-sms-settings-'))
  const dataDir = join(root, 'db')
  try {
    const first = await createLiteBackend({
      dataDir, jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64),
      authSettings: { smsEnabled: true, smsOtpCooldownSeconds: 1 },
      startRuntimeServices: false, log: () => {},
    })
    await saveAuthSettings(first.db, {
      ...DEFAULT_AUTH_SETTINGS,
      smsEnabled: false,
      smsSignupEnabled: false,
      smsOtpCooldownSeconds: 9,
      smsTemplate: 'Persisted code: {{ .Code }}',
    })
    await first.close()

    const reopened = await createLiteBackend({
      dataDir, jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64),
      authSettings: { smsEnabled: true, smsSignupEnabled: true, smsOtpCooldownSeconds: 1 },
      startRuntimeServices: false, log: () => {},
    })
    try {
      const loaded = await loadAuthSettings(reopened.db)
      expect(loaded).toMatchObject({
        smsEnabled: false,
        smsSignupEnabled: false,
        smsOtpCooldownSeconds: 9,
        smsTemplate: 'Persisted code: {{ .Code }}',
      })
      const settings = await reopened.fetch('http://local/auth/v1/settings', {
        headers: { apikey: reopened.anonKey },
      })
      expect((await settings.json()) as { external: { phone: boolean } })
        .toMatchObject({ external: { phone: false } })
      const client = createClient('http://local', reopened.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: reopened.fetch },
      })
      expect((await client.auth.signInWithOtp({ phone: '+8613800638000' })).error?.code)
        .toBe('phone_provider_disabled')
    } finally {
      await reopened.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
