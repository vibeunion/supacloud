import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { packConsumerArtifacts } from './package-artifacts.mjs'
import packageJson from '../package.json' with { type: 'json' }

const packageDir = resolve(import.meta.dir, '..')
const packDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-pack-'))
const consumerDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-consumer-'))
const noBunPath = await mkdtemp(join(tmpdir(), 'supacloud-lite-no-bun-'))
const authProjectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-package-auth-'))
const packageEnvironment = withoutLiteEnvironment()

try {
  if (packageJson.bin['supacloud-lite'] !== 'dist/launcher.mjs') {
    throw new Error('package bin must point to the Node launcher')
  }
  await access(join(packageDir, 'dist', 'cli.js'))
  await access(join(packageDir, 'dist', 'launcher.mjs'))

  const archives = await packConsumerArtifacts(packageDir, packDir, runCommand, npmCommand)
  await writeFile(
    join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'supacloud-lite-consumer', private: true, type: 'module' })
  )
  await runCommand(npmCommand(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...archives]), consumerDir)
  await runCommand(npmCommand([
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', 'typescript@5.9.3', '@types/node@22',
    `@supabase/supabase-js@${packageJson.devDependencies['@supabase/supabase-js']}`,
  ]), consumerDir)
  const installedPackage = join(consumerDir, 'node_modules', '@supacloud', 'lite', 'dist')
  const installedCli = join(installedPackage, 'cli.js')
  const installedLauncher = join(installedPackage, 'launcher.mjs')
  await access(installedCli)
  await access(installedLauncher)
  const node = Bun.which('node')
  if (!node) throw new Error('Package smoke requires Node to verify the installed ESM launcher')
  for (const runtime of [node, process.execPath]) {
    const runtimeVersion = (await runCommand([runtime, installedLauncher, 'version'], consumerDir)).trim()
    if (runtimeVersion !== packageJson.version) throw new Error(`unexpected launcher version: ${runtimeVersion}`)
  }
  const version = (await runCommand(npxCommand(['--no-install', 'supacloud-lite', 'version']), consumerDir)).trim()
  if (version !== packageJson.version) throw new Error(`unexpected CLI version: ${version}`)
  await mkdir(join(authProjectDir, 'supabase'), { recursive: true })
  await writeFile(
    join(authProjectDir, 'supabase', 'config.toml'),
    '[auth]\nenabled = true\nenable_signup = false\n[auth.email]\nenable_confirmations = true\n',
  )
  await runCommand(
    npxCommand(['--no-install', 'supacloud-lite', 'migrate', '--project-dir', authProjectDir]),
    consumerDir,
    packageEnvironment,
  )
  const authPassword = 'package-smoke-password-2026'
  const authOutput = await runCommand(
    npxCommand([
      '--no-install',
      'supacloud-lite',
      'auth',
      'create-user',
      '--project-dir',
      authProjectDir,
      '--email',
      'package-smoke@example.test',
      '--password-stdin',
      '--email-confirm',
      '--json',
    ]),
    consumerDir,
    packageEnvironment,
    `${authPassword}\n`,
  )
  let createdUser: unknown
  try {
    createdUser = JSON.parse(authOutput)
  } catch {
    throw new Error('installed Auth CLI did not return JSON')
  }
  if (
    typeof createdUser !== 'object' || createdUser === null ||
    !('id' in createdUser) || !('email' in createdUser) || !('email_confirmed' in createdUser) ||
    Object.keys(createdUser).sort().join(',') !== 'email,email_confirmed,id' ||
    typeof createdUser.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(createdUser.id) ||
    createdUser.email !== 'package-smoke@example.test' ||
    createdUser.email_confirmed !== true
  ) {
    throw new Error('installed Auth CLI returned an unexpected user')
  }
  const noBunEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: noBunPath,
  }
  if (process.platform === 'win32') noBunEnvironment['Path'] = noBunPath
  const missingBunOutput = await runCommandExpectingFailure([node, installedLauncher, 'version'], consumerDir, noBunEnvironment)
  if (!missingBunOutput.includes('Bun executable not found on PATH')) {
    throw new Error(`launcher did not explain a missing Bun executable:\n${missingBunOutput}`)
  }

  const smokePath = join(consumerDir, 'smoke.ts')
  await writeFile(
    smokePath,
    `import { createLiteBackend, SUPACLOUD_LITE_VERSION } from '@supacloud/lite'
const backend = await createLiteBackend({ jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), log: () => {} })
try {
  const response = await backend.fetch(new Request('http://local/health'))
  const body = await response.json()
  if (body.name !== 'supacloud-lite') throw new Error('health response mismatch')
  if (SUPACLOUD_LITE_VERSION !== '${packageJson.version}') throw new Error('version mismatch')
} finally {
  await backend.close()
}
`
  )
  const authSmokePath = join(consumerDir, 'auth-smoke.ts')
  await writeFile(
    authSmokePath,
    `import { createProjectBackend } from '@supacloud/lite'
import { createClient } from '@supabase/supabase-js'
const project = await createProjectBackend({
  projectDir: ${JSON.stringify(authProjectDir)},
  engine: 'pglite',
  applyMigrations: false,
  includeFunctions: false,
  includeWebhooks: false,
  startRuntimeServices: false,
  log: () => {},
})
try {
  const client = createClient('http://local', project.backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: project.backend.fetch },
  })
  const login = await client.auth.signInWithPassword({
    email: 'package-smoke@example.test',
    password: ${JSON.stringify(authPassword)},
  })
  if (login.error || !login.data.session || login.data.user?.id !== ${JSON.stringify(createdUser.id)}) {
    throw new Error('installed package could not sign in the CLI-created user')
  }
  const session = login.data.session
  const refreshed = await client.auth.refreshSession()
  if (refreshed.error || !refreshed.data.session || refreshed.data.user?.id !== session.user.id ||
      refreshed.data.session.refresh_token === session.refresh_token) {
    throw new Error('installed package did not rotate the refresh token')
  }
  const logout = await client.auth.signOut()
  if (logout.error) throw new Error('installed package could not sign out')
  const localSession = await client.auth.getSession()
  if (localSession.error || localSession.data.session !== null) throw new Error('SDK retained the signed-out session')
  const revoked = await client.auth.refreshSession({ refresh_token: refreshed.data.session.refresh_token })
  if (revoked.error?.status !== 400 || revoked.error?.code !== 'refresh_token_not_found' || revoked.data.session !== null) {
    throw new Error('installed package accepted the signed-out refresh token')
  }
} finally {
  await project.backend.close()
}
console.log('package-auth-smoke-ok')
`
  )
  await writeFile(
    join(consumerDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        lib: ['ES2022', 'DOM'],
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: false,
        types: [],
        noEmit: true,
      },
      include: ['smoke.ts'],
    })
  )
  await writeFile(
    join(consumerDir, 'tsconfig.auth.json'),
    JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { types: ['node'] },
      include: ['auth-smoke.ts'],
    }),
  )
  const installedTsc = join(consumerDir, 'node_modules', 'typescript', 'bin', 'tsc')
  await runCommand([process.execPath, installedTsc, '--noEmit', '-p', 'tsconfig.json'], consumerDir)
  await runCommand([process.execPath, installedTsc, '--noEmit', '-p', 'tsconfig.auth.json'], consumerDir)
  process.stdout.write(await runCommand([process.execPath, 'run', smokePath], consumerDir, packageEnvironment))
  process.stdout.write(await runCommand([process.execPath, 'run', authSmokePath], consumerDir, packageEnvironment))
  console.log('package-smoke-ok')
} finally {
  await Promise.all([
    rm(packDir, { recursive: true, force: true }),
    rm(consumerDir, { recursive: true, force: true }),
    rm(noBunPath, { recursive: true, force: true }),
    rm(authProjectDir, { recursive: true, force: true }),
  ])
}

function npmCommand(args: string[]): string[] {
  if (process.platform !== 'win32') return ['npm', ...args]
  return npmCliCommand('npm-cli.js', args)
}

function npxCommand(args: string[]): string[] {
  if (process.platform !== 'win32') return ['npx', ...args]
  return npmCliCommand('npx-cli.js', args)
}

function npmCliCommand(script: string, args: string[]): string[] {
  const node = Bun.which('node')
  const npm = Bun.which('npm')
  if (!node || !npm) throw new Error('Windows package smoke requires node and npm on PATH')
  return [node, join(dirname(npm), 'node_modules', 'npm', 'bin', script), ...args]
}

async function runCommand(command: string[], cwd: string, env = packageEnvironment, stdin?: string): Promise<string> {
  const execution = await executeCommand(command, cwd, env, stdin)
  if (stdin !== undefined) {
    const password = stdin.replace(/\r?\n$/, '')
    if (execution.stdout.includes(password) || execution.stderr.includes(password)) {
      throw new Error('installed Auth CLI echoed the password')
    }
    // Auth diagnostics must not expose keys or tokens if the installed CLI regresses.
    if (execution.exitCode !== 0 || execution.stderr !== '') throw new Error('installed Auth CLI failed')
  }
  if (execution.exitCode !== 0) throw new Error(`${command.join(' ')} failed (${execution.exitCode})\n${execution.stdout}\n${execution.stderr}`)
  return execution.stdout
}

async function runCommandExpectingFailure(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const execution = await executeCommand(command, cwd, env)
  if (execution.exitCode === 0) throw new Error(`${command.join(' ')} unexpectedly succeeded`)
  return `${execution.stdout}\n${execution.stderr}`
}

async function executeCommand(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<CommandExecution> {
  const processHandle = Bun.spawn({
    cmd: command,
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env,
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    timeout: 180_000,
    killSignal: 'SIGKILL',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

interface CommandExecution {
  exitCode: number
  stdout: string
  stderr: string
}

function withoutLiteEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('SUPACLOUD_LITE_')) delete environment[key]
  }
  delete environment.PORT
  return environment
}
