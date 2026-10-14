import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectBackend, type ProjectBackend } from '../src/index.js'
import { testTimeout } from './helpers/timeouts.js'

const credentials = { email: 'lifecycle@example.test', password: 'correct-horse-battery-staple' }

describe.serial('persistent project Auth lifecycle through the Supabase SDK', () => {
  const environment = new Map<string, string>()
  let projectDir: string
  let project: ProjectBackend | undefined

  beforeEach(async () => {
    // Exercise generated, persisted secrets without inheriting a developer's project configuration.
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('SUPACLOUD_LITE_') && value !== undefined) {
        environment.set(key, value)
        delete process.env[key]
      }
    }
    projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-auth-lifecycle-'))
    await mkdir(join(projectDir, 'supabase'))
    await writeConfig('[auth]\nenabled = true\n[auth.email]\nenable_confirmations = false\n')
  })

  afterEach(async () => {
    try {
      await project?.backend.close()
    } finally {
      project = undefined
      try {
        if (projectDir) await rm(projectDir, { recursive: true, force: true })
      } finally {
        for (const [key, value] of environment) process.env[key] = value
        environment.clear()
      }
    }
  })

  async function writeConfig(config: string): Promise<void> {
    await writeFile(join(projectDir, 'supabase', 'config.toml'), config)
  }

  async function reopen(): Promise<ProjectBackend> {
    if (project) {
      await project.backend.close()
      project = undefined
    }
    const stateDir = join(projectDir, '.supacloud-lite')
    project = await createProjectBackend({
      projectDir,
      stateDir,
      dataDir: join(stateDir, 'db'),
      storageDir: join(stateDir, 'storage'),
      engine: 'pglite',
      host: '127.0.0.1',
      port: 54321,
      apiUrl: 'http://local',
      includeFunctions: false,
      includeWebhooks: false,
      startRuntimeServices: false,
      log: () => {},
    })
    return project
  }

  test('restores a session after reopening, rotates refresh tokens and persists global logout', async () => {
    const first = await reopen()
    const signup = await clientFor(first).auth.signUp(credentials)
    expect(signup.error).toBeNull()
    expect(signup.data.session).not.toBeNull()
    const signupSession = signup.data.session!

    const invalid = await clientFor(first).auth.signInWithPassword({
      ...credentials,
      password: 'incorrect-password',
    })
    expect(invalid.error?.status).toBe(400)
    expect(invalid.error?.code).toBe('invalid_credentials')
    expect(invalid.data.session).toBeNull()

    const login = await clientFor(first).auth.signInWithPassword(credentials)
    expect(login.error).toBeNull()
    expect(login.data.session).not.toBeNull()
    const session = login.data.session!
    expect(session.user.id).toBe(signupSession.user.id)
    const secrets = await readFile(first.paths.secretsFile, 'utf8')

    const second = await reopen()
    // Compare booleans so failed assertions never print project keys or secrets.
    expect(second.backend.anonKey === first.backend.anonKey).toBe(true)
    expect(second.backend.serviceRoleKey === first.backend.serviceRoleKey).toBe(true)
    expect(await readFile(second.paths.secretsFile, 'utf8') === secrets).toBe(true)
    const restoredClient = clientFor(second)
    const restored = await restoredClient.auth.setSession(session)
    expect(restored.error).toBeNull()
    expect(restored.data.user?.id).toBe(session.user.id)
    expect(restored.data.session?.refresh_token === session.refresh_token).toBe(true)
    const user = await restoredClient.auth.getUser()
    expect(user.error).toBeNull()
    expect(user.data.user?.id).toBe(session.user.id)

    const refreshed = await restoredClient.auth.refreshSession()
    expect(refreshed.error).toBeNull()
    expect(refreshed.data.session).not.toBeNull()
    expect(refreshed.data.user?.id).toBe(session.user.id)
    expect(refreshed.data.session!.refresh_token !== session.refresh_token).toBe(true)
    await expectRefreshRejected(second, session.refresh_token)

    // A rejected replay must not prevent the current session from rotating again.
    const rotated = await restoredClient.auth.refreshSession()
    expect(rotated.error).toBeNull()
    expect(rotated.data.session).not.toBeNull()
    expect(rotated.data.user?.id).toBe(session.user.id)
    const rotatedSession = rotated.data.session!
    expect(rotatedSession.refresh_token !== refreshed.data.session!.refresh_token).toBe(true)
    await expectRefreshRejected(second, refreshed.data.session!.refresh_token)

    const logout = await restoredClient.auth.signOut({ scope: 'global' })
    expect(logout.error).toBeNull()
    const signedOut = await restoredClient.auth.getSession()
    expect(signedOut.error).toBeNull()
    expect(signedOut.data.session).toBeNull()
    // Logout revokes refresh tokens; access JWTs may remain valid until expiry.
    await expectRefreshRejected(second, rotatedSession.refresh_token)
    await expectRefreshRejected(second, signupSession.refresh_token)

    const third = await reopen()
    await expectRefreshRejected(third, rotatedSession.refresh_token)
    await expectRefreshRejected(third, signupSession.refresh_token)
    const newLogin = await clientFor(third).auth.signInWithPassword(credentials)
    expect(newLogin.error).toBeNull()
    expect(newLogin.data.session).not.toBeNull()
    expect(newLogin.data.user?.id).toBe(session.user.id)
    expect(newLogin.data.session!.refresh_token !== rotatedSession.refresh_token).toBe(true)
  }, testTimeout(30_000))

  for (const mode of ['disabled', 'external-identity'] as const) {
    test(`rejects existing local credentials and sessions after switching to ${mode}`, async () => {
      const first = await reopen()
      const signup = await clientFor(first).auth.signUp(credentials)
      expect(signup.error).toBeNull()
      expect(signup.data.session).not.toBeNull()
      const session = signup.data.session!

      if (mode === 'disabled') {
        await writeConfig('[auth]\nenabled = false\n')
      } else {
        await writeFile(join(projectDir, 'identity.ts'), 'export default async () => null\n')
        await writeConfig('[auth]\nenabled = true\n[lite.identity]\nmodule = "identity.ts"\n')
      }

      const restricted = await reopen()
      const login = await clientFor(restricted).auth.signInWithPassword(credentials)
      expect(login.error?.status).toBe(404)
      expect(login.data.session).toBeNull()
      const refresh = await clientFor(restricted).auth.refreshSession({ refresh_token: session.refresh_token })
      expect(refresh.error?.status).toBe(404)
      expect(refresh.data.session).toBeNull()
      const user = await clientFor(restricted).auth.getUser(session.access_token)
      expect(user.error?.status).toBe(404)
      expect(user.data.user).toBeNull()
    }, testTimeout(30_000))
  }
})

function clientFor(project: ProjectBackend) {
  return createClient(project.url, project.backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: project.backend.fetch },
  })
}

async function expectRefreshRejected(project: ProjectBackend, refreshToken: string): Promise<void> {
  const result = await clientFor(project).auth.refreshSession({ refresh_token: refreshToken })
  expect(result.error?.status).toBe(400)
  expect(result.error?.code).toBe('refresh_token_not_found')
  expect(result.data.session).toBeNull()
}
