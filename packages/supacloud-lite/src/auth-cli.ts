import { createProjectBackend, resolveProjectPaths, type ProjectRuntimeOptions } from './project-runtime.js'
import { loadAuthSettings } from './runtime/auth/settings.js'
import { assertDataDirUnlocked } from './runtime/db/data-dir-lock.js'
import { loadProjectConfig } from './runtime/node/load-config.js'
import { isRecord } from './runtime/validation.js'

export interface CreateAuthUserOptions extends ProjectRuntimeOptions {
  email?: string
  passwordStdin?: boolean
  emailConfirm?: boolean
}

export interface CreatedAuthUser {
  id: string
  email: string
  email_confirmed: boolean
}

export async function createLocalAuthUser(options: CreateAuthUserOptions): Promise<CreatedAuthUser> {
  if (options.memory) throw new Error('auth create-user requires a persistent project; --memory is not supported')
  const email = options.email?.trim().toLowerCase()
  if (!email || email.length > 254 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(email)) {
    throw new Error('auth create-user requires a valid --email')
  }
  if (!options.passwordStdin) throw new Error('auth create-user requires --password-stdin; passwords are not accepted as arguments')
  if (process.stdin.isTTY) throw new Error('--password-stdin requires piped or redirected input; terminal input is not accepted')

  const paths = resolveProjectPaths(options)
  const config = loadProjectConfig(paths.projectDir, process.env, options.runtimeMode)
  if (config.auth.enabled === false) throw new Error('cannot create a local user: Auth is disabled in config.toml')
  if (options.externalIdentity || options.identityModule || config.lite.identityModule) {
    throw new Error('cannot create a local user: the project uses external identity')
  }
  await assertDataDirUnlocked(paths.dataDir)
  const password = await readPassword()
  const project = await createProjectBackend({
    ...options,
    applyMigrations: false,
    includeSeed: false,
    includeFunctions: false,
    includeWebhooks: false,
    includeIdentity: false,
    graphql: { enabled: false },
    storageBackend: 'memory',
    startRuntimeServices: false,
    log: () => {},
  })
  try {
    const settings = await loadAuthSettings(project.backend.db, project.config.auth.settings)
    if (password.length < settings.minPasswordLength) {
      throw new Error(`password must be at least ${settings.minPasswordLength} characters`)
    }
    const existing = await project.backend.db.query<{ id: string }>(
      'select id from auth.users where email = $1',
      [email],
    )
    if (existing.rows.length > 0) throw new Error('an Auth user with this email already exists; no changes made')

    // Use the local admin handler for hashing and identity creation; never expose the service-role key.
    const response = await project.backend.fetch('http://local/auth/v1/admin/users', {
      method: 'POST',
      headers: {
        apikey: project.backend.serviceRoleKey,
        authorization: `Bearer ${project.backend.serviceRoleKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, password, email_confirm: options.emailConfirm === true }),
    })
    if (!response.ok) throw new Error(`local Auth user creation failed (HTTP ${response.status})`)
    const user: unknown = await response.json()
    if (!isRecord(user) || typeof user.id !== 'string' || typeof user.email !== 'string') {
      throw new Error('local Auth returned an invalid user response')
    }
    return { id: user.id, email: user.email, email_confirmed: typeof user.email_confirmed_at === 'string' }
  } finally {
    await project.backend.close()
  }
}

async function readPassword(): Promise<string> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of Bun.stdin.stream()) {
    length += chunk.byteLength
    if (length > 4098) throw new Error('password input exceeds 4096 bytes')
    chunks.push(chunk)
  }
  let password: string
  try {
    password = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, '')
  } catch {
    throw new Error('password input must be valid UTF-8')
  }
  if (!password || /[\r\n\x00]/.test(password)) throw new Error('password input must contain one non-empty line')
  if (Buffer.byteLength(password, 'utf8') > 4096) throw new Error('password input exceeds 4096 bytes')
  return password
}
