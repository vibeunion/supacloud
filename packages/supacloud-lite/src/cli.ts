#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }
import { generateTypes, inspectDb } from './runtime/index.js'
import { computeDbDiff, createTemporaryNativeEngine, pullSchema } from './runtime/node/db-diff.js'
import { assertDataDirUnlocked } from './runtime/db/data-dir-lock.js'
import { createNativeEngine } from './runtime/node/native/engine.js'
import { inspectPowerSyncReadiness, liteCapabilities } from './runtime/node/native/readiness.js'
import { loadSupabaseProject } from './runtime/node/project.js'
import {
  createProjectBackend,
  assertResetPathsSafe,
  ensureProjectSecrets,
  mintProjectKeys,
  resolveStorageBackend,
  resolveProjectPaths,
  resolveNativeReplicationOptions,
  startProjectServer,
  type ProjectRuntimeOptions,
} from './project-runtime.js'
import { createSnapshot, restoreSnapshot } from './snapshot.js'
import { waitForShutdown } from './shutdown.js'

interface CliOptions extends ProjectRuntimeOptions {
  command: string
  positionals: string[]
  output?: string
  diffFile?: string
  serviceRole: boolean
  force: boolean
  json: boolean
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
    json: false,
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
    else if (argument === '--engine') options.engine = next() as ProjectRuntimeOptions['engine']
    else if (argument === '--replication-profile') {
      options.replicationProfile = next() as ProjectRuntimeOptions['replicationProfile']
    }
    else if (argument === '--replication-host') options.replicationHost = next()
    else if (argument === '--replication-port') options.replicationPort = Number.parseInt(next(), 10)
    else if (argument === '--replication-allow-cidrs') options.replicationAllowCidrs = commaSeparated(next())
    else if (argument === '--powersync-tables') options.powersyncPublicationTables = commaSeparated(next())
    else if (argument === '--replication-tls-cert') options.replicationTlsCertFile = resolve(next())
    else if (argument === '--replication-tls-key') options.replicationTlsKeyFile = resolve(next())
    else if (argument === '--memory') options.memory = true
    else if (argument === '--output' || argument === '-o') options.output = resolve(next())
    else if (argument === '--file' || argument === '-f') options.diffFile = next()
    else if (argument === '--service-role') options.serviceRole = true
    else if (argument === '--force') options.force = true
    else if (argument === '--json') options.json = true
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
    await writeStandardOutput(`${packageJson.version}\n`)
    return
  }

  if (options.command === 'keys') {
    const secrets = await ensureProjectSecrets(paths)
    const keys = await mintProjectKeys(secrets.jwtSecret)
    const privilegedKey = options.serviceRole
      ? `\nservice_role key:\n${keys.serviceRoleKey}`
      : '\nUse --service-role to print the privileged key.'
    await writeStandardOutput(`anon key:\n${keys.anonKey}\n${privilegedKey}\n`)
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
    const project = await createProjectBackend({
      ...options,
      applyMigrations: false,
      includeFunctions: false,
      includeWebhooks: false,
      startRuntimeServices: false,
      log: quietLog,
    })
    try {
      const source = await generateTypes(project.backend.db, 'public')
      if (options.output) {
        await mkdir(dirname(options.output), { recursive: true })
        await writeFile(options.output, source)
        await writeStandardOutput(`Wrote ${options.output}\n`)
      } else await writeStandardOutput(source)
    } finally {
      await project.backend.close()
    }
    return
  }

  if (options.command === 'inspect') {
    const project = await createProjectBackend({
      ...options,
      applyMigrations: false,
      includeFunctions: false,
      includeWebhooks: false,
      startRuntimeServices: false,
      log: quietLog,
    })
    try {
      await printInspection(await inspectDb(project.backend.db, 'public'))
    } finally {
      await project.backend.close()
    }
    return
  }

  if (options.command === 'doctor') {
    const replication = resolveNativeReplicationOptions(options, paths.databaseEngine)
    const report = liteCapabilities(paths.databaseEngine, replication?.profile)
    if (paths.databaseEngine === 'native' && replication) {
      if (!paths.dataDir || !existsSync(join(paths.dataDir, 'PG_VERSION'))) {
        throw new Error('PowerSync readiness requires an initialized native database; run migrate first')
      }
      const engine = await createNativeEngine({ dataDir: paths.dataDir, log: quietLog, replication })
      try {
        report.powersync_readiness = await inspectPowerSyncReadiness(engine, replication)
      } finally {
        await engine.close()
      }
    }
    if (options.json) await writeStandardOutput(`${JSON.stringify(report, null, 2)}\n`)
    else await printDoctor(report)
    return
  }

  if (options.command === 'migrate' || options.command === 'status') {
    const project = await createProjectBackend({
      ...options,
      applyMigrations: options.command === 'migrate',
      includeFunctions: false,
      includeWebhooks: false,
      includeSeed: options.command === 'migrate',
      startRuntimeServices: false,
      log: quietLog,
    })
    try {
      const applied = await project.backend.db.listAppliedMigrations()
      const output = options.command === 'migrate'
        ? `${applied.length} migration(s) applied.`
        : applied.length === 0
          ? 'no migrations applied'
          : applied.map((migration) => `${migration.version}  ${migration.name ?? ''}`).join('\n')
      await writeStandardOutput(`${output}\n`)
    } finally {
      await project.backend.close()
    }
    return
  }

  if (options.command !== 'start') throw new Error(`unknown command: ${options.command}`)

  const project = await startProjectServer({ ...options, log: (message) => console.log(`  ${message}`) })
  const shutdown = waitForShutdown(() => project.close())
  await writeStandardOutput(`
  SupaCloud Lite running

          API URL: ${project.url}
           Engine: ${formatDatabaseEngine(project.databaseEngine, paths.dataDir)}
          Storage: ${formatStorage(project.storageBackend, paths.storageDir)}
       Migrations: ${project.migrationCount} file(s)
        Functions: ${project.functionNames.length ? project.functionNames.join(', ') : 'none'}
          Webhooks: ${project.webhookCount}
       Email inbox: ${project.backend.inbox ? `${project.url}/inbox` : 'disabled on network-exposed host'}

  Run "supacloud-lite keys" for the anon key.
  Run "supacloud-lite keys --service-role" only when privileged access is required.
\n`)

  await shutdown
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
    await assertDataDirUnlocked(paths.dataDir)
    if (paths.dataDir) await rm(paths.dataDir, { recursive: true, force: true })
    await rm(paths.storageDir, { recursive: true, force: true })
    const project = await createProjectBackend({
      ...options,
      includeFunctions: false,
      includeWebhooks: false,
      startRuntimeServices: false,
      log: quietLog,
    })
    try {
      const applied = await project.backend.db.listAppliedMigrations()
      await writeStandardOutput(`reset complete: ${applied.length} migration(s) applied\n`)
    } finally {
      await project.backend.close()
    }
    return
  }

  const project = await loadSupabaseProject(resolve(options.projectDir ?? process.cwd()))
  if (subcommand === 'diff') {
    const liveEngine = paths.databaseEngine === 'native'
      ? await createNativeEngine({
          dataDir: paths.dataDir!,
          log: quietLog,
          replication: resolveNativeReplicationOptions(options, paths.databaseEngine),
        })
      : undefined
    const ddl = await computeDbDiff({
      liveDataDir: paths.databaseEngine === 'pglite' ? paths.dataDir : undefined,
      liveEngine,
      migrations: project.migrations,
      makeShadowEngine: paths.databaseEngine === 'native' ? createTemporaryNativeEngine : undefined,
    })
    if (ddl.length === 0) {
      await writeStandardError('No schema changes found.\n')
      return
    }
    const source = `${ddl.join('\n\n')}\n`
    if (options.diffFile) {
      const stamp = timestamp()
      const output = join(paths.projectDir, 'supabase', 'migrations', `${stamp}_${options.diffFile}.sql`)
      await mkdir(join(paths.projectDir, 'supabase', 'migrations'), { recursive: true })
      await writeFile(output, source)
      await writeStandardOutput(`Wrote ${output}\n`)
    } else await writeStandardOutput(source)
    return
  }

  if (subcommand === 'pull') {
    const liveEngine = paths.databaseEngine === 'native'
      ? await createNativeEngine({
          dataDir: paths.dataDir!,
          log: quietLog,
          replication: resolveNativeReplicationOptions(options, paths.databaseEngine),
        })
      : undefined
    const result = await pullSchema({
      liveDataDir: paths.databaseEngine === 'pglite' ? paths.dataDir : undefined,
      liveEngine,
      migrations: project.migrations,
      makeShadowEngine: paths.databaseEngine === 'native' ? createTemporaryNativeEngine : undefined,
      migrationsDir: join(paths.projectDir, 'supabase', 'migrations'),
      name: options.positionals[1] ?? 'remote_schema',
    })
    if (!result.path) await writeStandardError('No schema changes to pull.\n')
    else await writeStandardOutput(`Wrote ${result.path} and recorded version ${result.version} as applied.\n`)
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
    await writeStandardOutput(`Snapshot created: ${output}\n`)
    if (manifest.storageBackend === 's3') {
      await writeStandardOutput('S3 objects were not copied; the snapshot contains database metadata and secrets only.\n')
    }
    return
  }

  if (subcommand === 'restore') {
    const input = options.positionals[1]
    if (!input) throw new Error('snapshot restore requires a snapshot file')
    const result = await restoreSnapshot({ paths, storageBackend, input, force: options.force })
    const rollbackLines = result.rollbackPaths.map((rollbackPath) => `Previous state retained at ${rollbackPath}`)
    const reconnectLine = result.manifest.storageBackend === 's3'
      ? ['Reconnect the original S3 bucket/prefix before starting Lite.']
      : []
    await writeStandardOutput([
      `Snapshot restored from ${resolve(input)}`,
      ...rollbackLines,
      ...reconnectLine,
    ].join('\n') + '\n')
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
  await writeStandardOutput(`Pre-upgrade snapshot: ${output}\n`)

  try {
    const project = await createProjectBackend({
      ...options,
      applyMigrations: true,
      includeFunctions: false,
      includeWebhooks: false,
      includeSeed: true,
      startRuntimeServices: false,
      log: quietLog,
    })
    try {
      const applied = await project.backend.db.listAppliedMigrations()
      await writeStandardOutput(
        `Upgrade complete on @supacloud/lite ${packageJson.version}: ${applied.length} migration(s) recorded.\n`
      )
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

async function printInspection(rows: Awaited<ReturnType<typeof inspectDb>>): Promise<void> {
  if (rows.length === 0) {
    await writeStandardOutput('No tables in schema "public".\n')
    return
  }
  const width = Math.max(5, ...rows.map((row) => row.table.length))
  const output = [
    `${'table'.padEnd(width)}  ${'rows'.padStart(10)}  size`,
    ...rows.map((row) => `${row.table.padEnd(width)}  ${String(row.rows).padStart(10)}  ${row.size}`),
  ]
  await writeStandardOutput(`${output.join('\n')}\n`)
}

async function printDoctor(report: ReturnType<typeof liteCapabilities>): Promise<void> {
  const output = Object.entries(report)
    .filter(([, value]) => typeof value !== 'object')
    .map(([name, value]) => `${name}: ${value}`)
  if (report.powersync_readiness) {
    output.push(`powersync_ready: ${report.powersync_readiness.ready}`)
    for (const blocker of report.powersync_readiness.blockers) output.push(`blocker: ${blocker}`)
    for (const warning of report.powersync_readiness.warnings) output.push(`warning: ${warning}`)
  }
  await writeStandardOutput(`${output.join('\n')}\n`)
}

async function writeStandardOutput(output: string): Promise<void> {
  await Bun.write(Bun.stdout, output)
}

async function writeStandardError(output: string): Promise<void> {
  await Bun.write(Bun.stderr, output)
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

function quietLog(): void {}

function commaSeparated(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

function printHelp(): void {
  console.log(`supacloud-lite - Bun-native Supabase-compatible backend on PGlite or native PostgreSQL

Usage: supacloud-lite [command] [options]

Commands:
  start                 start the single-project server
  migrate               apply pending supabase/migrations/*.sql
  status                list applied migrations
  keys                  print the anon key
  keys --service-role   also print the privileged service_role key
  gen types             emit Supabase-shaped TypeScript database types
  db reset              reset initialized database/storage and re-run migrations
  db diff               print schema changes outside migrations
  db pull [name]        write live schema changes as an applied migration
  snapshot create       create a compressed database/storage/secrets snapshot
  snapshot restore <f>  restore a snapshot into an empty target
  upgrade               snapshot first, then apply pending migrations
  inspect               show table rows and sizes
  doctor                report Lite capability and replication readiness
  version               print the package version

Fresh projects must run "supacloud-lite migrate" before "db reset".

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
      --engine <e>         pglite (default) or native (macOS/glibc Linux x64/arm64)
      --replication-profile <p> optional powersync profile (native only)
      --replication-host <ip> database listener (default 127.0.0.1)
      --replication-port <n> database listener port (default 54322)
      --replication-allow-cidrs <list> explicit client CIDRs
      --powersync-tables <list> schema-qualified publication table allowlist
      --replication-tls-cert <p> PostgreSQL TLS certificate
      --replication-tls-key <p> PostgreSQL TLS private key
      --memory            use an in-memory PGlite database
      --json              emit machine-readable doctor output
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

function formatDatabaseEngine(engine: NonNullable<ProjectRuntimeOptions['engine']>, dataDir?: string): string {
  const label = engine === 'native' ? 'Native PostgreSQL' : 'PGlite'
  return dataDir ? `${label} (${dataDir})` : `${label} (memory)`
}

let exitCode = 0
try {
  await main()
} catch (error) {
  await writeStandardError(`${error instanceof Error ? error.message : String(error)}\n`)
  exitCode = 1
}
process.exit(exitCode)
