/**
 * Local Supabase project import for SupaCloud Lite.
 *
 * One command copies a Supabase project directory, applies its migrations and
 * optional data SQL, creates Auth users, uploads Storage objects, and invokes
 * Edge Functions in-process. Checklist rows are checked only after a local
 * read-back. This does not deploy and does not start hosted Realtime,
 * upstream Storage, or @supacloud/edge-runtime.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { buildVersionMatrix, type VersionMatrixRow } from './compat-matrix.js'
import { createProjectBackend, type ProjectBackend, type ProjectRuntimeOptions } from './project-runtime.js'
import { rewriteMigrationSql } from './runtime/db/sql-compat.js'
import { loadProjectConfig } from './runtime/node/load-config.js'
import { loadSupabaseProject } from './runtime/node/project.js'
import { isRecord } from './runtime/validation.js'

const DATA_SQL_LEDGER_PATH = 'supabase/import/data.sql'
const MAX_SQL_BYTES = 2 * 1024 * 1024
const MAX_OBJECT_BYTES = 1024 * 1024
const MAX_OBJECTS = 64
const MAX_AUTH_USERS = 32
const MAX_MIGRATIONS = 200
const MAX_FUNCTIONS = 32
const MAX_TREE_FILES = 500
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/
const BUCKET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/
const EMAIL = /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/

export type ChecklistId = 'config' | 'migrations' | 'data' | 'acl' | 'objects' | 'functions' | 'auth'

export interface ChecklistRow {
  id: ChecklistId
  checked: boolean
  attempted: boolean
  detail?: string
  blocker?: string
}

export interface ImportReport {
  deployed: false
  source: string
  project_dir: string
  checklist: ChecklistRow[]
  version_matrix: VersionMatrixRow[]
  exit_code: number
}

interface AuthUserImport {
  email: string
  password: string
  emailConfirm: boolean
}

interface DataExpectation {
  table: string
  rows: number
}

interface AclExpectation {
  table: string
  anonRows: number
  serviceRows: number
}

interface FunctionExpectation {
  name: string
  status: number
  body?: string
}

interface Expectations {
  data: DataExpectation[]
  acl: AclExpectation[]
  functions: FunctionExpectation[]
}

interface StorageObjectImport {
  bucket: string
  key: string
  bytes: Uint8Array
}

interface SdkClient {
  from: (table: string) => {
    select: (columns: string) => Promise<{ data: unknown; error: { message: string } | null }>
  }
  auth: {
    signInWithPassword: (credentials: { email: string; password: string }) => Promise<{
      data: { session: unknown }
      error: { message: string } | null
    }>
  }
  storage: {
    from: (bucket: string) => {
      upload: (path: string, body: Blob, options: { upsert: boolean; contentType: string }) => Promise<{ error: { message: string } | null }>
      download: (path: string) => Promise<{ data: Blob | null; error: { message: string } | null }>
    }
  }
  functions: {
    invoke: (name: string) => Promise<{ data: unknown; error: { message: string } | null }>
  }
}

class ImportStop extends Error {
  constructor(message: string, readonly row: ChecklistId) {
    super(message)
    this.name = 'ImportStop'
  }
}

const CHECKLIST_IDS: ChecklistId[] = ['config', 'migrations', 'data', 'acl', 'objects', 'functions', 'auth']

export async function runSupabaseImport(
  options: ProjectRuntimeOptions & { sourceDir: string; force?: boolean },
): Promise<ImportReport> {
  const source = resolve(options.sourceDir)
  const projectDir = resolve(options.projectDir ?? process.cwd())
  const secrets: string[] = []
  try {
    return await importProject(options, source, projectDir, secrets)
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), secrets)
    const row = error instanceof ImportStop ? error.row : 'migrations'
    const checklist = stoppedChecklist(row, message)
    return {
      deployed: false,
      source,
      project_dir: projectDir,
      checklist,
      version_matrix: await buildVersionMatrix({ supabaseJsExercised: false }),
      exit_code: 1,
    }
  }
}

export function formatImportReport(report: ImportReport): string {
  const lines = ['Supabase import lab (not deployed)']
  for (const row of report.checklist) {
    const mark = row.checked ? 'x' : ' '
    const text = row.checked ? (row.detail ?? 'verified') : (row.blocker ?? 'unchecked')
    lines.push(`[${mark}] ${row.id} — ${text}`)
  }
  lines.push('version matrix:')
  for (const row of report.version_matrix) {
    const mark = row.checked ? 'x' : ' '
    lines.push(`- [${mark}] ${row.component} ${row.declared_version}${row.blocker ? ` — ${row.blocker}` : ''}`)
  }
  lines.push('deployed: false')
  return `${lines.join('\n')}\n`
}

async function importProject(
  options: ProjectRuntimeOptions & { sourceDir: string; force?: boolean },
  source: string,
  projectDir: string,
  secrets: string[],
): Promise<ImportReport> {
  await assertDirectory(source, 'source directory')
  if (source !== projectDir) {
    const sourceReal = await realDirectory(source)
    const destinationReal = existsSync(projectDir) ? await realDirectory(projectDir) : projectDir
    if (isInside(sourceReal, destinationReal) || isInside(destinationReal, sourceReal)) {
      throw new ImportStop('source and destination directories must not contain each other', 'migrations')
    }
    await copyProject(source, projectDir, options.force === true)
  }

  const configPath = join(projectDir, 'supabase', 'config.toml')
  const configPresent = existsSync(configPath)
  if (configPresent) {
    await assertRegularFile(configPath)
    try {
      loadProjectConfig(projectDir)
    } catch (error) {
      throw new ImportStop(error instanceof Error ? error.message : String(error), 'config')
    }
  }
  const expectations = await readExpectations(projectDir)
  const users = await readAuthUsers(projectDir, secrets)
  const objects = await readStorageObjects(projectDir)
  const functionNames = await listFunctionNames(projectDir)
  const dataSqlPath = join(projectDir, 'supabase', 'import', 'data.sql')
  const dataSql = existsSync(dataSqlPath) ? await readUtf8File(dataSqlPath, 'import/data.sql', MAX_SQL_BYTES) : undefined
  if (users.length) await chmod(join(projectDir, 'supabase', 'import', 'auth-users.json'), 0o600)

  const migrationCount = (await loadSupabaseProject(projectDir, { enabled: false })).migrations.length
  let project: ProjectBackend | undefined
  let sdkPass = false
  const notes = emptyNotes()
  try {
    project = await createProjectBackend({
      ...options,
      projectDir,
      apiUrl: options.apiUrl ?? 'http://local',
      applyMigrations: true,
      includeFunctions: true,
      includeWebhooks: false,
      includeIdentity: false,
      startRuntimeServices: false,
      graphql: { enabled: false },
      log: () => {},
    })
    const strict = project.config.lite.runtimeMode === 'strict'
    if (migrationCount) notes.migrations = await verifyMigrations(project, projectDir)
    if (dataSql !== undefined) {
      notes.data = await applyDataSql(project, dataSql, strict)
      project.backend.db.invalidateSchemaCache()
    }
    const sdk = await loadSdk()
    const anon = sdk ? sdk.createClient('http://local', project.backend.anonKey, sdkOptions(project.backend.fetch)) : null
    const service = sdk ? sdk.createClient('http://local', project.backend.serviceRoleKey, sdkOptions(project.backend.fetch)) : null
    const seedPresent = existsSync(join(projectDir, 'supabase', 'seed.sql'))
    if (notes.data?.startsWith('blocked:')) {
      // A changed data.sql was refused. Do not report the previous row count as a pass.
    } else if (expectations.data.length) {
      notes.data = await verifyData(expectations, service, project, () => { sdkPass = true })
    } else if (dataSql !== undefined || seedPresent) {
      notes.data = 'skip: no row-count expectations in supabase/import/expectations.json'
    }
    if (expectations.acl.length) {
      notes.acl = await verifyAcl(expectations, anon, service, project, () => { sdkPass = true })
    }
    if (configPresent) notes.config = await verifyConfig(project)
    if (objects.length) notes.objects = await verifyObjects(objects, project, service, () => { sdkPass = true })
    if (functionNames.length || expectations.functions.length) {
      notes.functions = await verifyFunctions(functionNames, expectations, project, service, () => { sdkPass = true })
    }
    if (users.length) notes.auth = await verifyAuth(users, project, anon, () => { sdkPass = true })
  } finally {
    await project?.backend.close()
  }

  const checklist = buildChecklist(notes, {
    configPresent,
    migrationFiles: migrationCount > 0,
    dataInputs: expectations.data.length > 0 || dataSql !== undefined || existsSync(join(projectDir, 'supabase', 'seed.sql')),
    aclInputs: expectations.acl.length > 0,
    objectInputs: objects.length > 0,
    functionInputs: functionNames.length > 0 || expectations.functions.length > 0,
    authInputs: users.length > 0,
  })
  const exitCode = checklist.some((row) => row.attempted && !row.checked) ? 1 : 0
  return {
    deployed: false,
    source,
    project_dir: projectDir,
    checklist,
    version_matrix: await buildVersionMatrix({ supabaseJsExercised: sdkPass && exitCode === 0 }),
    exit_code: exitCode,
  }
}

interface Notes {
  config?: string
  migrations?: string
  data?: string
  acl?: string
  objects?: string
  functions?: string
  auth?: string
}

function emptyNotes(): Notes {
  return {}
}

function buildChecklist(notes: Notes, inputs: {
  configPresent: boolean
  migrationFiles: boolean
  dataInputs: boolean
  aclInputs: boolean
  objectInputs: boolean
  functionInputs: boolean
  authInputs: boolean
}): ChecklistRow[] {
  return [
    done('config', inputs.configPresent, notes.config, 'supabase/config.toml not found'),
    done('migrations', inputs.migrationFiles, notes.migrations, 'no supabase/migrations SQL files'),
    done('data', inputs.dataInputs, notes.data, 'no seed.sql, import/data.sql, or data expectations'),
    done('acl', inputs.aclInputs, notes.acl, 'no ACL expectations in supabase/import/expectations.json'),
    done('objects', inputs.objectInputs, notes.objects, 'no storage objects under supabase/import/storage'),
    done('functions', inputs.functionInputs, notes.functions, 'no supabase/functions entries'),
    done('auth', inputs.authInputs, notes.auth, 'no supabase/import/auth-users.json'),
  ]
}

function done(id: ChecklistId, inputs: boolean, detail: string | undefined, absentBlocker: string): ChecklistRow {
  if (!inputs) return { id, checked: false, attempted: false, blocker: absentBlocker }
  if (detail?.startsWith('skip:')) {
    return { id, checked: false, attempted: false, blocker: detail.slice('skip:'.length).trim() }
  }
  if (!detail || detail.startsWith('blocked:')) {
    return {
      id,
      checked: false,
      attempted: true,
      blocker: detail?.startsWith('blocked:') ? detail.slice('blocked:'.length).trim() : absentBlocker,
    }
  }
  return { id, checked: true, attempted: true, detail }
}

function stoppedChecklist(failed: ChecklistId, message: string): ChecklistRow[] {
  return CHECKLIST_IDS.map((id) => id === failed
    ? { id, checked: false, attempted: true, blocker: message }
    : { id, checked: false, attempted: false, blocker: `not evaluated: ${message}` })
}

async function verifyMigrations(project: ProjectBackend, projectDir: string): Promise<string> {
  const loaded = await loadSupabaseProject(projectDir, { enabled: false })
  if (!loaded.migrations.length) return 'blocked: no supabase/migrations SQL files'
  if (loaded.migrations.length > MAX_MIGRATIONS) {
    return `blocked: migration count ${loaded.migrations.length} exceeds ${MAX_MIGRATIONS}`
  }
  const history = await project.backend.db.query<{ version: string; statements: string[] | null }>(
    'select version, statements from supabase_migrations.schema_migrations',
  )
  const recorded = new Map<string, string>()
  for (const row of history.rows) {
    if (!row.statements?.length) return `blocked: migration ${row.version} has no verifiable SQL in the ledger`
    recorded.set(row.version, row.statements.join('\n'))
  }
  for (const migration of loaded.migrations) {
    const version = migration.name.match(/^(\d+)/)?.[1] ?? migration.name
    const stored = recorded.get(version)
    if (stored === undefined) return `blocked: migration ${version} is not in supabase_migrations.schema_migrations`
    if (stored !== migration.sql) return `blocked: migration ${version} SQL does not match the ledger`
  }
  return `${loaded.migrations.length} migration file(s) match supabase_migrations.schema_migrations`
}

async function applyDataSql(project: ProjectBackend, sql: string, strict: boolean): Promise<string> {
  const hash = createHash('sha256').update(sql).digest('hex')
  const existing = await project.backend.db.query<{ hash: string }>(
    'select hash from supabase_migrations.seed_files where path = $1',
    [DATA_SQL_LEDGER_PATH],
  )
  const previous = existing.rows[0]?.hash
  if (previous && previous !== hash) {
    return 'blocked: import/data.sql changed after it was applied; refusing to re-run it'
  }
  if (previous === hash) return 'import/data.sql already applied'
  await project.backend.db.engine.transaction(async (tx) => {
    await tx.exec(`set search_path to "$user", public, extensions`)
    await tx.exec(rewriteMigrationSql(sql, strict))
    await tx.query(
      `insert into supabase_migrations.seed_files (path, hash) values ($1, $2)`,
      [DATA_SQL_LEDGER_PATH, hash],
    )
  })
  return 'import/data.sql applied'
}

async function verifyData(
  expectations: Expectations,
  service: SdkClient | null,
  project: ProjectBackend,
  markSdk: () => void,
): Promise<string> {
  if (!expectations.data.length) return 'blocked: no row-count expectations in supabase/import/expectations.json'
  const counts: string[] = []
  for (const expected of expectations.data) {
    const rows = await countRows(expected.table, project.backend.serviceRoleKey, service, project.backend.fetch, markSdk, 'data')
    if (rows !== expected.rows) {
      return `blocked: public.${expected.table} has ${rows} rows; expected ${expected.rows}`
    }
    counts.push(`${expected.table}=${rows}`)
  }
  return `row counts ${counts.join(', ')}`
}

async function verifyAcl(
  expectations: Expectations,
  anon: SdkClient | null,
  service: SdkClient | null,
  project: ProjectBackend,
  markSdk: () => void,
): Promise<string> {
  const counts: string[] = []
  for (const expected of expectations.acl) {
    const anonRows = await countRows(expected.table, project.backend.anonKey, anon, project.backend.fetch, markSdk, 'acl')
    const serviceRows = await countRows(expected.table, project.backend.serviceRoleKey, service, project.backend.fetch, markSdk, 'acl')
    if (anonRows !== expected.anonRows || serviceRows !== expected.serviceRows) {
      return `blocked: public.${expected.table} anon=${anonRows} service=${serviceRows}; expected anon=${expected.anonRows} service=${expected.serviceRows}`
    }
    counts.push(`${expected.table} anon=${anonRows} service=${serviceRows}`)
  }
  return counts.join(', ')
}

async function verifyConfig(project: ProjectBackend): Promise<string> {
  const declared = project.config.storage.buckets ?? []
  const live = await project.backend.db.query<{ id: string }>(`select id from storage.buckets`)
  const liveIds = new Set(live.rows.map((row) => row.id))
  const missing = declared.filter((bucket) => !liveIds.has(bucket.id)).map((bucket) => bucket.id)
  if (missing.length) return `blocked: config buckets missing after startup: ${missing.join(', ')}`
  const names = declared.map((bucket) => bucket.id)
  return names.length ? `config.toml loaded; buckets ${names.join(', ')}` : 'config.toml loaded; no buckets declared'
}

async function verifyObjects(
  objects: StorageObjectImport[],
  project: ProjectBackend,
  service: SdkClient | null,
  markSdk: () => void,
): Promise<string> {
  const buckets = new Map((project.config.storage.buckets ?? []).map((bucket) => [bucket.id, bucket.public]))
  for (const object of objects) {
    const isPublic = buckets.get(object.bucket)
    if (isPublic === undefined) return `blocked: bucket ${object.bucket} is not declared in config.toml`
    const actual = service
      ? await roundTripSdk(service, object, markSdk)
      : await roundTripFetch(project, object)
    if (!equalBytes(actual, object.bytes)) return `blocked: ${object.bucket}/${object.key} bytes do not match`
    const encoded = object.key.split('/').map(encodeURIComponent).join('/')
    const pub = await project.backend.fetch(`http://local/storage/v1/object/public/${object.bucket}/${encoded}`)
    if (isPublic) {
      if (pub.status !== 200) return `blocked: public bucket ${object.bucket} returned HTTP ${pub.status}`
      if (!equalBytes(new Uint8Array(await pub.arrayBuffer()), object.bytes)) {
        return `blocked: public bytes for ${object.bucket}/${object.key} do not match`
      }
    } else if (pub.status === 200) {
      return `blocked: private bucket ${object.bucket} public URL returned 200`
    }
  }
  return `${objects.length} object(s) round-tripped`
}

async function verifyFunctions(
  names: string[],
  expectations: Expectations,
  project: ProjectBackend,
  service: SdkClient | null,
  markSdk: () => void,
): Promise<string> {
  const expectedByName = new Map(expectations.functions.map((item) => [item.name, item]))
  const loaded = new Set(project.functionNames)
  for (const name of names) {
    if (!loaded.has(name)) return `blocked: function ${name} did not load`
  }
  for (const expected of expectations.functions) {
    if (!names.includes(expected.name)) return `blocked: expected function ${expected.name} is not in supabase/functions`
  }
  const invoked = names.length ? names : expectations.functions.map((item) => item.name)
  for (const name of invoked) {
    const expected = expectedByName.get(name)
    const outcome = service
      ? await invokeSdk(service, name, markSdk)
      : await invokeFetch(project, name)
    const status = expected?.status ?? 200
    if (outcome.status !== status) return `blocked: function ${name} returned HTTP ${outcome.status}; expected ${status}`
    if (expected?.body !== undefined && outcome.body !== expected.body) {
      return `blocked: function ${name} body did not match the expectation`
    }
  }
  return `${invoked.length} function(s) invoked`
}

async function verifyAuth(
  users: AuthUserImport[],
  project: ProjectBackend,
  anon: SdkClient | null,
  markSdk: () => void,
): Promise<string> {
  if (project.config.auth.enabled === false) return 'blocked: Auth is disabled in config.toml'
  if (project.config.lite.identityModule) return 'blocked: external identity is configured; local user import was skipped'
  for (const user of users) {
    const existing = await project.backend.db.query<{ id: string }>(
      'select id from auth.users where lower(email) = $1',
      [user.email],
    )
    if (!existing.rows.length) {
      const response = await project.backend.fetch('http://local/auth/v1/admin/users', {
        method: 'POST',
        headers: {
          apikey: project.backend.serviceRoleKey,
          authorization: `Bearer ${project.backend.serviceRoleKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: user.email, password: user.password, email_confirm: user.emailConfirm }),
      })
      if (!response.ok) {
        const body = redact(await response.text(), [user.password])
        return `blocked: Auth user create failed (HTTP ${response.status}) ${body.slice(0, 180)}`
      }
    }
    if (anon) {
      const signedIn = await anon.auth.signInWithPassword({ email: user.email, password: user.password })
      markSdk()
      if (signedIn.error || !signedIn.data.session) {
        return `blocked: password grant failed for ${user.email}: ${redact(signedIn.error?.message ?? 'no session', [user.password])}`
      }
    } else {
      const response = await project.backend.fetch('http://local/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: {
          apikey: project.backend.anonKey,
          authorization: `Bearer ${project.backend.anonKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: user.email, password: user.password }),
      })
      const payload: unknown = await response.json().catch(() => null)
      const token = isRecord(payload) && typeof payload.access_token === 'string'
      if (!response.ok || !token) return `blocked: password grant failed for ${user.email} (HTTP ${response.status})`
    }
  }
  return `${users.length} Auth user(s) accepted a password grant`
}

async function countRows(
  table: string,
  key: string,
  sdk: SdkClient | null,
  fetchImpl: typeof fetch,
  markSdk: () => void,
  row: ChecklistId,
): Promise<number> {
  if (sdk) {
    const selected = await sdk.from(table).select('*')
    markSdk()
    if (selected.error) throw new ImportStop(selected.error.message, row)
    if (!Array.isArray(selected.data)) throw new ImportStop(`select ${table} did not return rows`, row)
    return selected.data.length
  }
  const response = await fetchImpl(`http://local/rest/v1/${table}?select=*`, {
    headers: { apikey: key, authorization: `Bearer ${key}`, accept: 'application/json' },
  })
  if (!response.ok) throw new ImportStop(`select ${table} failed (HTTP ${response.status})`, row)
  const body: unknown = await response.json()
  if (!Array.isArray(body)) throw new ImportStop(`select ${table} did not return rows`, row)
  return body.length
}

async function roundTripSdk(sdk: SdkClient, object: StorageObjectImport, markSdk: () => void): Promise<Uint8Array> {
  const uploaded = await sdk.storage.from(object.bucket).upload(object.key, new Blob([ownedBytes(object.bytes)]), {
    upsert: true,
    contentType: 'text/plain',
  })
  markSdk()
  if (uploaded.error) throw new ImportStop(uploaded.error.message, 'objects')
  const downloaded = await sdk.storage.from(object.bucket).download(object.key)
  if (downloaded.error || !downloaded.data) throw new ImportStop(downloaded.error?.message ?? 'empty storage download', 'objects')
  return new Uint8Array(await downloaded.data.arrayBuffer())
}

async function roundTripFetch(project: ProjectBackend, object: StorageObjectImport): Promise<Uint8Array> {
  const encoded = object.key.split('/').map(encodeURIComponent).join('/')
  const uploaded = await project.backend.fetch(`http://local/storage/v1/object/${object.bucket}/${encoded}`, {
    method: 'POST',
    headers: {
      apikey: project.backend.serviceRoleKey,
      authorization: `Bearer ${project.backend.serviceRoleKey}`,
      'content-type': 'text/plain',
      'x-upsert': 'true',
    },
    body: ownedBytes(object.bytes),
  })
  if (!uploaded.ok) throw new ImportStop(`storage upload failed (HTTP ${uploaded.status})`, 'objects')
  const downloaded = await project.backend.fetch(`http://local/storage/v1/object/${object.bucket}/${encoded}`, {
    headers: {
      apikey: project.backend.serviceRoleKey,
      authorization: `Bearer ${project.backend.serviceRoleKey}`,
    },
  })
  if (!downloaded.ok) throw new ImportStop(`storage download failed (HTTP ${downloaded.status})`, 'objects')
  return new Uint8Array(await downloaded.arrayBuffer())
}

async function invokeSdk(sdk: SdkClient, name: string, markSdk: () => void): Promise<{ status: number; body: string }> {
  const invoked = await sdk.functions.invoke(name)
  markSdk()
  if (invoked.error) throw new ImportStop(`function ${name} failed: ${invoked.error.message}`, 'functions')
  return { status: 200, body: typeof invoked.data === 'string' ? invoked.data : JSON.stringify(invoked.data) }
}

async function invokeFetch(project: ProjectBackend, name: string): Promise<{ status: number; body: string }> {
  const response = await project.backend.fetch(`http://local/functions/v1/${name}`, {
    headers: {
      apikey: project.backend.serviceRoleKey,
      authorization: `Bearer ${project.backend.serviceRoleKey}`,
    },
  })
  return { status: response.status, body: await response.text() }
}

async function loadSdk(): Promise<{ createClient: (url: string, key: string, options: ReturnType<typeof sdkOptions>) => SdkClient } | null> {
  try {
    const imported = await import('@supabase/supabase-js') as unknown as {
      createClient: (url: string, key: string, options: ReturnType<typeof sdkOptions>) => SdkClient
    }
    return imported
  } catch {
    return null
  }
}

function sdkOptions(fetchImpl: typeof fetch) {
  return {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchImpl },
  }
}

async function copyProject(source: string, destination: string, force: boolean): Promise<void> {
  const files = await collectSourceFiles(source)
  await mkdir(destination, { recursive: true })
  for (const file of files) {
    const target = join(destination, file.relativePath)
    if (!isInside(destination, target)) throw new ImportStop(`refusing to write outside destination: ${file.relativePath}`, 'migrations')
    await mkdir(dirname(target), { recursive: true })
    if (existsSync(target)) {
      const current = await readFile(target)
      if (Buffer.from(current).equals(file.bytes)) continue
      if (!force) throw new ImportStop(`refusing to overwrite ${file.relativePath}; pass --force`, 'migrations')
    }
    await writeFile(target, file.bytes)
    if (file.relativePath === 'supabase/import/auth-users.json') await chmod(target, 0o600)
  }
}

interface SourceFile {
  relativePath: string
  bytes: Uint8Array
}

async function collectSourceFiles(source: string): Promise<SourceFile[]> {
  const files: SourceFile[] = []
  const singles = ['supabase/config.toml', 'supabase/seed.sql', 'supabase/import/auth-users.json', 'supabase/import/expectations.json', 'supabase/import/data.sql']
  for (const relativePath of singles) {
    const full = join(source, relativePath)
    if (!existsSync(full)) continue
    await assertRegularFile(full)
    files.push({ relativePath, bytes: await readLimited(full, relativePath.endsWith('.sql') ? MAX_SQL_BYTES : MAX_OBJECT_BYTES) })
  }
  await walkSql(join(source, 'supabase', 'migrations'), 'supabase/migrations', files)
  await walkFunctions(join(source, 'supabase', 'functions'), files)
  await walkStorage(join(source, 'supabase', 'import', 'storage'), files)
  if (files.length > MAX_TREE_FILES) throw new ImportStop(`import tree exceeds ${MAX_TREE_FILES} files`, 'migrations')
  return files
}

async function walkSql(directory: string, prefix: string, files: SourceFile[]): Promise<void> {
  if (!existsSync(directory)) return
  await assertDirectory(directory, prefix)
  const entries = await readdir(directory, { withFileTypes: true })
  let count = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new ImportStop(`refusing to import a symbolic link: ${prefix}/${entry.name}`, 'migrations')
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = join(full, 'migration.sql')
      if (!existsSync(nested)) continue
      await assertRegularFile(nested)
      files.push({ relativePath: `${prefix}/${entry.name}/migration.sql`, bytes: await readLimited(nested, MAX_SQL_BYTES) })
      count += 1
    } else if (entry.isFile() && entry.name.endsWith('.sql')) {
      files.push({ relativePath: `${prefix}/${entry.name}`, bytes: await readLimited(full, MAX_SQL_BYTES) })
      count += 1
    }
  }
  if (count > MAX_MIGRATIONS) throw new ImportStop(`migration count ${count} exceeds ${MAX_MIGRATIONS}`, 'migrations')
}

async function walkFunctions(directory: string, files: SourceFile[]): Promise<void> {
  if (!existsSync(directory)) return
  await assertDirectory(directory, 'supabase/functions')
  const entries = await readdir(directory, { withFileTypes: true })
  let functions = 0
  for (const entry of entries) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    if (entry.isSymbolicLink()) throw new ImportStop(`refusing to import a symbolic link: supabase/functions/${entry.name}`, 'functions')
    if (!entry.isDirectory()) continue
    if (!FUNCTION_NAME.test(entry.name)) throw new ImportStop(`unsafe function name: ${entry.name}`, 'functions')
    functions += 1
    if (functions > MAX_FUNCTIONS) throw new ImportStop(`function count exceeds ${MAX_FUNCTIONS}`, 'functions')
    await walkPlain(join(directory, entry.name), `supabase/functions/${entry.name}`, files, 0)
  }
}

async function walkStorage(directory: string, files: SourceFile[]): Promise<void> {
  if (!existsSync(directory)) return
  await assertDirectory(directory, 'supabase/import/storage')
  const buckets = await readdir(directory, { withFileTypes: true })
  let objects = 0
  for (const bucket of buckets) {
    if (bucket.isSymbolicLink()) throw new ImportStop(`refusing to import a symbolic link: storage/${bucket.name}`, 'objects')
    if (!bucket.isDirectory() || !BUCKET_NAME.test(bucket.name)) {
      throw new ImportStop(`unsafe storage bucket directory: ${bucket.name}`, 'objects')
    }
    const found = await walkObjects(join(directory, bucket.name), `supabase/import/storage/${bucket.name}`, files, 0)
    objects += found
    if (objects > MAX_OBJECTS) throw new ImportStop(`storage object count exceeds ${MAX_OBJECTS}`, 'objects')
  }
}

async function walkPlain(directory: string, prefix: string, files: SourceFile[], depth: number): Promise<void> {
  if (depth > 8) throw new ImportStop(`function tree is too deep: ${prefix}`, 'functions')
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
    if (entry.isSymbolicLink()) throw new ImportStop(`refusing to import a symbolic link: ${prefix}/${entry.name}`, 'functions')
    const full = join(directory, entry.name)
    if (entry.isDirectory()) await walkPlain(full, `${prefix}/${entry.name}`, files, depth + 1)
    else if (entry.isFile()) files.push({ relativePath: `${prefix}/${entry.name}`, bytes: await readLimited(full, MAX_OBJECT_BYTES) })
  }
}

async function walkObjects(directory: string, prefix: string, files: SourceFile[], depth: number): Promise<number> {
  if (depth > 8) throw new ImportStop(`storage tree is too deep: ${prefix}`, 'objects')
  let count = 0
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new ImportStop(`refusing to import a symbolic link: ${prefix}/${entry.name}`, 'objects')
    const full = join(directory, entry.name)
    if (entry.isDirectory()) count += await walkObjects(full, `${prefix}/${entry.name}`, files, depth + 1)
    else if (entry.isFile()) {
      files.push({ relativePath: `${prefix}/${entry.name}`, bytes: await readLimited(full, MAX_OBJECT_BYTES) })
      count += 1
    }
  }
  return count
}

async function readExpectations(projectDir: string): Promise<Expectations> {
  const path = join(projectDir, 'supabase', 'import', 'expectations.json')
  if (!existsSync(path)) return { data: [], acl: [], functions: [] }
  await assertRegularFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readUtf8File(path, 'expectations.json', MAX_SQL_BYTES))
  } catch (error) {
    if (error instanceof ImportStop) throw error
    throw new ImportStop('expectations.json is not valid JSON', 'data')
  }
  if (!isRecord(parsed)) throw new ImportStop('expectations.json must be an object', 'data')
  return {
    data: readDataExpectations(parsed.data),
    acl: readAclExpectations(parsed.acl),
    functions: readFunctionExpectations(parsed.functions),
  }
}

function readDataExpectations(value: unknown): DataExpectation[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ImportStop('expectations data must be an array', 'data')
  return value.map((item) => {
    if (!isRecord(item) || typeof item.table !== 'string' || !TABLE_NAME.test(item.table) || !isCount(item.rows)) {
      throw new ImportStop('expectations data rows must name a public table and an integer count from 0 to 100', 'data')
    }
    return { table: item.table, rows: item.rows }
  })
}

function readAclExpectations(value: unknown): AclExpectation[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ImportStop('expectations acl must be an array', 'acl')
  return value.map((item) => {
    if (!isRecord(item) || typeof item.table !== 'string' || !TABLE_NAME.test(item.table) || !isCount(item.anon_rows) || !isCount(item.service_rows)) {
      throw new ImportStop('expectations acl rows must name a public table and anon_rows/service_rows counts', 'acl')
    }
    return { table: item.table, anonRows: item.anon_rows, serviceRows: item.service_rows }
  })
}

function readFunctionExpectations(value: unknown): FunctionExpectation[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ImportStop('expectations functions must be an array', 'functions')
  return value.map((item) => {
    if (!isRecord(item) || typeof item.name !== 'string' || !FUNCTION_NAME.test(item.name) || typeof item.status !== 'number') {
      throw new ImportStop('expectations functions need a name and HTTP status', 'functions')
    }
    if (item.body !== undefined && (typeof item.body !== 'string' || item.body.length > 500)) {
      throw new ImportStop('expectations function body must be a string of at most 500 characters', 'functions')
    }
    return { name: item.name, status: item.status, ...(typeof item.body === 'string' ? { body: item.body } : {}) }
  })
}

async function readAuthUsers(projectDir: string, secrets: string[]): Promise<AuthUserImport[]> {
  const path = join(projectDir, 'supabase', 'import', 'auth-users.json')
  if (!existsSync(path)) return []
  await assertRegularFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readUtf8File(path, 'auth-users.json', MAX_SQL_BYTES))
  } catch (error) {
    if (error instanceof ImportStop) throw error
    throw new ImportStop('auth-users.json is not valid JSON', 'auth')
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.users)) throw new ImportStop('auth-users.json must be { "users": [] }', 'auth')
  if (parsed.users.length > MAX_AUTH_USERS) throw new ImportStop(`auth user count exceeds ${MAX_AUTH_USERS}`, 'auth')
  return parsed.users.map((item) => {
    if (!isRecord(item) || typeof item.email !== 'string' || typeof item.password !== 'string') {
      throw new ImportStop('each auth user needs an email and password', 'auth')
    }
    const email = item.email.trim().toLowerCase()
    if (!EMAIL.test(email) || email.length > 254) throw new ImportStop('auth user email is invalid', 'auth')
    if (item.password.length < 6 || item.password.length > 72 || /[\r\n\x00]/.test(item.password)) {
      throw new ImportStop('auth user password must be one line of 6 to 72 characters', 'auth')
    }
    secrets.push(item.password)
    return { email, password: item.password, emailConfirm: item.email_confirm === true }
  })
}

async function readStorageObjects(projectDir: string): Promise<StorageObjectImport[]> {
  const root = join(projectDir, 'supabase', 'import', 'storage')
  if (!existsSync(root)) return []
  const objects: StorageObjectImport[] = []
  async function walk(directory: string, bucket: string, keyPrefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new ImportStop(`refusing to import a symbolic link: ${entry.name}`, 'objects')
      const full = join(directory, entry.name)
      if (entry.isDirectory()) await walk(full, bucket, keyPrefix ? `${keyPrefix}/${entry.name}` : entry.name)
      else if (entry.isFile()) {
        const key = keyPrefix ? `${keyPrefix}/${entry.name}` : entry.name
        if (key.split('/').some((segment) => segment === '.' || segment === '..')) {
          throw new ImportStop(`unsafe storage object key: ${key}`, 'objects')
        }
        objects.push({ bucket, key, bytes: await readLimited(full, MAX_OBJECT_BYTES) })
      }
    }
  }
  const buckets = await readdir(root, { withFileTypes: true })
  for (const bucket of buckets) {
    if (bucket.isSymbolicLink()) throw new ImportStop(`refusing to import a symbolic link: storage/${bucket.name}`, 'objects')
    if (!bucket.isDirectory() || !BUCKET_NAME.test(bucket.name)) {
      throw new ImportStop(`unsafe storage bucket directory: ${bucket.name}`, 'objects')
    }
    await walk(join(root, bucket.name), bucket.name, '')
  }
  if (objects.length > MAX_OBJECTS) throw new ImportStop(`storage object count exceeds ${MAX_OBJECTS}`, 'objects')
  return objects
}

async function listFunctionNames(projectDir: string): Promise<string[]> {
  const root = join(projectDir, 'supabase', 'functions')
  if (!existsSync(root)) return []
  const entries = await readdir(root, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

async function readUtf8File(path: string, label: string, limit: number): Promise<string> {
  const bytes = await readLimited(path, limit)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new ImportStop(`${label} is not valid UTF-8`, 'migrations')
  }
}

async function readLimited(path: string, limit: number): Promise<Uint8Array> {
  await assertRegularFile(path)
  const bytes = await readFile(path)
  if (bytes.byteLength > limit) throw new ImportStop(`${path} exceeds ${limit} bytes`, 'migrations')
  return bytes
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new ImportStop(`${label} not found`, 'migrations')
    throw error
  })
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ImportStop(`${label} must be a real directory`, 'migrations')
}

async function assertRegularFile(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new ImportStop(`refusing to import a symbolic link or non-file: ${path}`, 'migrations')
}

async function realDirectory(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return realpath(path)
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right))
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  copy.set(bytes)
  return copy
}

function redact(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('[redacted]')
  }
  return out
}

void loadProjectConfig
