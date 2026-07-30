#!/usr/bin/env bun
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }
import { generateTypes, inspectDb } from './vendor/tinbase/index.js'
import { computeDbDiff, pullSchema } from './vendor/tinbase/node/db-diff.js'
import { loadSupabaseProject } from './vendor/tinbase/node/project.js'
import {
  createProjectBackend,
  assertResetPathsSafe,
  ensureProjectSecrets,
  mintProjectKeys,
  resolveStorageBackend,
  resolveProjectPaths,
  startProjectServer,
  type ProjectRuntimeOptions,
} from './project-runtime.js'
import { createSnapshot, restoreSnapshot } from './snapshot.js'

interface CliOptions extends ProjectRuntimeOptions {
  command: string
  positionals: string[]
  output?: string
  diffFile?: string
  serviceRole: boolean
  force: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv]
  const command = args[0] && !args[0]!.startsWith('-') ? args.shift()! : 'start'
  const options: CliOptions = {
    command,
    positionals: [],
    projectDir: process.cwd(),
    host: process.env.SUPACLOUD_LITE_HOST ?? '127.0.0.1',
    port: process.env.SUPACLOUD_LITE_PORT || process.env.PORT
      ? Number.parseInt(process.env.SUPACLOUD_LITE_PORT ?? process.env.PORT!, 10)
      : 54321,
    serviceRole: false,
    force: false,
  }

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    const next = () => {
      const value = args[++index]
      if (!value) throw new Error(`missing value for ${argument}`)
      return value
    }
    if (argument === '--port' || argument === '-p') options.port = Number.parseInt(next(), 10)
    else if (argument === '--host') options.host = next()
    else if (argument === '--api-url') options.apiUrl = next()
    else if (argument === '--site-url') options.siteUrl = next()
    else if (argument === '--project-dir' || argument === '--dir') options.projectDir = resolve(next())
    else if (argument === '--state-dir') options.stateDir = resolve(next())
    else if (argument === '--data-dir') options.dataDir = resolve(next())
    else if (argument === '--storage-dir') options.storageDir = resolve(next())
    else if (argument === '--storage-backend') options.storageBackend = next() as ProjectRuntimeOptions['storageBackend']
    else if (argument === '--s3-prefix') options.s3 = { ...options.s3, prefix: next() }
    else if (argument === '--memory') options.memory = true
    else if (argument === '--output' || argument === '-o') options.output = resolve(next())
    else if (argument === '--file' || argument === '-f') options.diffFile = next()
    else if (argument === '--service-role') options.serviceRole = true
    else if (argument === '--force') options.force = true
    else if (argument === '--version') {
      console.log(packageJson.version)
      process.exit(0)
    }
    else if (argument === '--help' || argument === '-h') {
      printHelp()
      process.exit(0)
    } else if (!argument.startsWith('-')) options.positionals.push(argument)
    else throw new Error(`unknown option: ${argument}`)
  }
  return options
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const paths = resolveProjectPaths(options)

  if (options.command === 'version' || options.command === '--version') {
    console.log(packageJson.version)
    return
  }

  if (options.command === 'keys') {
    const secrets = await ensureProjectSecrets(paths)
    const keys = await mintProjectKeys(secrets.jwtSecret)
    console.log(`anon key:\n${keys.anonKey}`)
    if (options.serviceRole) console.log(`\nservice_role key:\n${keys.serviceRoleKey}`)
    else console.log('\nUse --service-role to print the privileged key.')
    return
  }

  if (options.command === 'db') {
    await runDbCommand(options)
    return
  }

  if (options.command === 'snapshot') {
    await runSnapshotCommand(options)
    return
  }

  if (options.command === 'upgrade') {
    await runUpgradeCommand(options)
    return
  }

  if (options.command === 'gen') {
    if (options.positionals[0] && options.positionals[0] !== 'types' && options.positionals[0] !== 'typescript') {
      throw new Error(`unknown gen subcommand: ${options.positionals[0]}`)
    }
    const project = await createProjectBackend({ ...options, includeFunctions: false, includeWebhooks: false, log: quietLog })
    try {
      const source = await generateTypes(project.backend.db, 'public')
      if (options.output) {
        await mkdir(dirname(options.output), { recursive: true })
        await writeFile(options.output, source)
        console.log(`Wrote ${options.output}`)
      } else process.stdout.write(source)
    } finally {
      await project.backend.close()
    }
    return
  }

  if (options.command === 'inspect') {
    const project = await createProjectBackend({ ...options, includeFunctions: false, includeWebhooks: false, log: quietLog })
    try {
      printInspection(await inspectDb(project.backend.db, 'public'))
    } finally {
      await project.backend.close()
    }
    return
  }

  if (options.command === 'migrate' || options.command === 'status') {
    const project = await createProjectBackend({
      ...options,
      applyMigrations: options.command === 'migrate',
      includeFunctions: false,
      includeWebhooks: false,
      includeSeed: options.command === 'migrate',
      log: quietLog,
    })
    try {
      const applied = await project.backend.db.listAppliedMigrations()
      if (options.command === 'migrate') console.log(`${applied.length} migration(s) applied.`)
      else if (applied.length === 0) console.log('no migrations applied')
      else for (const migration of applied) console.log(`${migration.version}  ${migration.name ?? ''}`)
    } finally {
      await project.backend.close()
    }
    return
  }

  if (options.command !== 'start') throw new Error(`unknown command: ${options.command}`)

  const project = await startProjectServer({ ...options, log: (message) => console.log(`  ${message}`) })
  console.log(`
  SupaCloud Lite running

          API URL: ${project.url}
           Engine: PGlite${paths.dataDir ? ` (${paths.dataDir})` : ' (memory)'}
          Storage: ${formatStorage(project.storageBackend, paths.storageDir)}
       Migrations: ${project.migrationCount} file(s)
        Functions: ${project.functionNames.length ? project.functionNames.join(', ') : 'none'}
          Webhooks: ${project.webhookCount}
       Email inbox: ${project.backend.inbox ? `${project.url}/inbox` : 'disabled on network-exposed host'}

  Run "supacloud-lite keys" for the anon key.
  Run "supacloud-lite keys --service-role" only when privileged access is required.
`)

  await waitForShutdown(() => project.close())
  process.exitCode = 0
}

async function runDbCommand(options: CliOptions): Promise<void> {
  const subcommand = options.positionals[0]
  const paths = resolveProjectPaths(options)
  if (subcommand === 'reset') {
    if (resolveStorageBackend(options.storageBackend) === 's3') {
      throw new Error('db reset refuses the s3 storage backend because remote objects cannot be deleted atomically')
    }
    await assertResetPathsSafe(paths)
    if (paths.dataDir) await rm(paths.dataDir, { recursive: true, force: true })
    await rm(paths.storageDir, { recursive: true, force: true })
    const project = await createProjectBackend({ ...options, includeFunctions: false, includeWebhooks: false, log: quietLog })
    try {
      const applied = await project.backend.db.listAppliedMigrations()
      console.log(`reset complete: ${applied.length} migration(s) applied`)
    } finally {
      await project.backend.close()
    }
    return
  }

  const project = await loadSupabaseProject(resolve(options.projectDir ?? process.cwd()))
  if (subcommand === 'diff') {
    const ddl = await computeDbDiff({ liveDataDir: paths.dataDir, migrations: project.migrations })
    if (ddl.length === 0) {
      console.error('No schema changes found.')
      return
    }
    const source = `${ddl.join('\n\n')}\n`
    if (options.diffFile) {
      const stamp = timestamp()
      const output = join(paths.projectDir, 'supabase', 'migrations', `${stamp}_${options.diffFile}.sql`)
      await mkdir(join(paths.projectDir, 'supabase', 'migrations'), { recursive: true })
      await writeFile(output, source)
      console.log(`Wrote ${output}`)
    } else process.stdout.write(source)
    return
  }

  if (subcommand === 'pull') {
    const result = await pullSchema({
      liveDataDir: paths.dataDir,
      migrations: project.migrations,
      migrationsDir: join(paths.projectDir, 'supabase', 'migrations'),
      name: options.positionals[1] ?? 'remote_schema',
    })
    if (!result.path) console.error('No schema changes to pull.')
    else console.log(`Wrote ${result.path} and recorded version ${result.version} as applied.`)
    return
  }

  throw new Error(`unknown db subcommand: ${subcommand ?? '(none)'}`)
}

async function runSnapshotCommand(options: CliOptions): Promise<void> {
  const subcommand = options.positionals[0]
  const paths = resolveProjectPaths(options)
  const storageBackend = resolveStorageBackend(options.storageBackend)
  if (options.memory) throw new Error('snapshot does not support --memory because the database is not durable')

  if (subcommand === 'create') {
    await ensureProjectSecrets(paths)
    const output = options.output ?? join(paths.stateDir, 'backups', `snapshot-${timestamp()}.tar.gz`)
    const manifest = await createSnapshot({ paths, packageVersion: packageJson.version, storageBackend, output })
    console.log(`Snapshot created: ${output}`)
    if (manifest.storageBackend === 's3') console.log('S3 objects were not copied; the snapshot contains database metadata and secrets only.')
    return
  }

  if (subcommand === 'restore') {
    const input = options.positionals[1]
    if (!input) throw new Error('snapshot restore requires a snapshot file')
    const result = await restoreSnapshot({ paths, storageBackend, input, force: options.force })
    console.log(`Snapshot restored from ${resolve(input)}`)
    for (const rollbackPath of result.rollbackPaths) console.log(`Previous state retained at ${rollbackPath}`)
    if (result.manifest.storageBackend === 's3') console.log('Reconnect the original S3 bucket/prefix before starting Lite.')
    return
  }

  throw new Error(`unknown snapshot subcommand: ${subcommand ?? '(none)'}`)
}

async function runUpgradeCommand(options: CliOptions): Promise<void> {
  if (options.memory) throw new Error('upgrade does not support --memory because there is no durable database to back up')
  const paths = resolveProjectPaths(options)
  const storageBackend = resolveStorageBackend(options.storageBackend)
  await ensureProjectSecrets(paths)
  const output = options.output ?? join(paths.stateDir, 'backups', `pre-upgrade-${timestamp()}.tar.gz`)
  await createSnapshot({ paths, packageVersion: packageJson.version, storageBackend, output })
  console.log(`Pre-upgrade snapshot: ${output}`)

  try {
    const project = await createProjectBackend({
      ...options,
      applyMigrations: true,
      includeFunctions: false,
      includeWebhooks: false,
      includeSeed: true,
      log: quietLog,
    })
    try {
      const applied = await project.backend.db.listAppliedMigrations()
      console.log(`Upgrade complete on @supacloud/lite ${packageJson.version}: ${applied.length} migration(s) recorded.`)
    } finally {
      await project.backend.close()
    }
  } catch (error) {
    throw new Error(
      `upgrade failed; snapshot retained at ${output}. Restore it with ` +
      `"supacloud-lite snapshot restore ${output} --force". ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function printInspection(rows: Awaited<ReturnType<typeof inspectDb>>): void {
  if (rows.length === 0) {
    console.log('No tables in schema "public".')
    return
  }
  const width = Math.max(5, ...rows.map((row) => row.table.length))
  console.log(`${'table'.padEnd(width)}  ${'rows'.padStart(10)}  size`)
  for (const row of rows) console.log(`${row.table.padEnd(width)}  ${String(row.rows).padStart(10)}  ${row.size}`)
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

function quietLog(): void {}

async function waitForShutdown(closeProject: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    const resolveOnSignal = () => {
      process.off('SIGINT', resolveOnSignal)
      process.off('SIGTERM', resolveOnSignal)
      resolveShutdown()
    }
    process.once('SIGINT', resolveOnSignal)
    process.once('SIGTERM', resolveOnSignal)
  })
  await closeProject()
}

function printHelp(): void {
  console.log(`supacloud-lite - Bun-native Supabase-compatible backend on PGlite

Usage: supacloud-lite [command] [options]

Commands:
  start                 start the single-project server
  migrate               apply pending supabase/migrations/*.sql
  status                list applied migrations
  keys                  print the anon key
  keys --service-role   also print the privileged service_role key
  gen types             emit Supabase-shaped TypeScript database types
  db reset              wipe database and storage, then re-run migrations
  db diff               print schema changes outside migrations
  db pull [name]        write live schema changes as an applied migration
  snapshot create       create a compressed database/storage/secrets snapshot
  snapshot restore <f>  restore a snapshot into an empty target
  upgrade               snapshot first, then apply pending migrations
  inspect               show table rows and sizes
  version               print the package version

Options:
  -p, --port <n>          port (default 54321)
      --host <host>       bind host (default 127.0.0.1)
      --api-url <url>     public API URL used by Auth and Functions
      --site-url <url>    frontend URL used as the default Auth redirect
      --project-dir <p>   project containing supabase/ (default cwd)
      --state-dir <p>     state root (default .supacloud-lite)
      --data-dir <p>      PGlite data directory
      --storage-dir <p>   object storage directory
      --storage-backend <b> fs, memory, or s3 (default fs)
      --s3-prefix <p>      optional key prefix for the s3 backend
      --memory            use an in-memory PGlite database
  -o, --output <p>        output file for gen types
  -f, --file <name>       migration suffix for db diff
      --force             replace non-empty restore targets and retain rollback copies
`)
}

function formatStorage(backend: ProjectRuntimeOptions['storageBackend'] | 'custom', storageDir: string): string {
  if (backend === 's3') return 'S3 remote (S3_*/AWS_* credentials)'
  if (backend === 'memory') return 'in-memory'
  if (backend === 'custom') return 'custom driver'
  return storageDir
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
