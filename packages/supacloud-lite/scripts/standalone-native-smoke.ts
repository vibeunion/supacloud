import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createSupaCloudClient } from '../test/helpers/supacloud-js-source.js'
import packageJson from '../package.json' with { type: 'json' }
import { executeBufferedCommand, withWindowsSubprocessRef } from './subprocess.js'

const packageDir = resolve(import.meta.dir, '..')
const binary = resolveStandaloneBinary()
const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-standalone-native-'))
const emptyPath = await mkdtemp(join(tmpdir(), 'supacloud-lite-native-empty-path-'))
const homeDir = join(projectDir, 'home')
const migrationDir = join(projectDir, 'supabase', 'migrations')
const cacheFunctionDir = join(projectDir, 'supabase', 'functions', 'cache-probe')
const commandTimeoutMs = 300_000
const password = 'correct-horse-battery-staple'

interface ProjectKeys {
  anon: string
  serviceRole: string
}

interface RoleClients {
  anonymous: SupabaseClient
  firstUser: SupabaseClient
  secondUser: SupabaseClient
  serviceRole: SupabaseClient
  firstUserId: string
  firstUserEmail: string
}

interface PersistenceSeeds {
  queueMessageId: number
  workflowRunId: string
  userEmail: string
}

async function main(): Promise<void> {
  try {
    await runAcceptanceMatrix()
    console.log('standalone-native-smoke-ok')
  } finally {
    await cleanupFixtures()
  }
}

async function runAcceptanceMatrix(): Promise<void> {
  assert(process.platform !== 'win32', 'native standalone smoke requires macOS or glibc Linux')
  await writeProjectFixture()
  const environment = isolatedEnvironment()
  await expectCliVersion(environment)
  await runCommand('native migrate', projectCommand('migrate'), environment)
  const keys = parseProjectKeys(await runCommand('project keys', projectCommand('keys', '--service-role'), environment))
  const persistenceSeeds = await withServer(environment, keys, (url) => expectFirstRun(url, keys))
  await withServer(environment, keys, (url) => expectPersistentState(url, keys, persistenceSeeds))
}

async function expectCliVersion(environment: NodeJS.ProcessEnv): Promise<void> {
  const version = (await runCommand('version', [binary, 'version'], environment)).trim()
  assert(version === packageJson.version, `unexpected standalone version: ${version}`)
}

async function expectFirstRun(url: string, keys: ProjectKeys): Promise<PersistenceSeeds> {
  const clients = await createRoleClients(url, keys)
  await expectRoleIsolation(clients)
  await expectStorageIsolation(clients)
  await expectQueueSdkContract(clients)
  await expectWorkflowContract(clients.serviceRole)
  await expectPgredisContract(url)
  return await seedPersistentState(url, clients)
}

async function cleanupFixtures(): Promise<void> {
  await Promise.all([
    rm(projectDir, { recursive: true, force: true }),
    rm(emptyPath, { recursive: true, force: true }),
  ])
}

async function writeProjectFixture(): Promise<void> {
  await mkdir(migrationDir, { recursive: true })
  await mkdir(cacheFunctionDir, { recursive: true })
  await mkdir(homeDir, { recursive: true })
  await writeFile(join(projectDir, 'supabase', 'config.toml'), projectConfig)
  await writeFile(join(migrationDir, '20260816000000_native_acceptance.sql'), acceptanceMigration)
  await writeFile(join(cacheFunctionDir, 'index.ts'), cacheProbeFunction)
}

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, PATH: emptyPath }
  if (process.platform === 'win32') environment.Path = emptyPath
  return environment
}

function projectCommand(command: string, ...args: string[]): string[] {
  return [binary, command, '--project-dir', projectDir, '--engine', 'native', ...args]
}

async function createRoleClients(url: string, keys: ProjectKeys): Promise<RoleClients> {
  const anonymous = supabaseClient(url, keys.anon)
  const firstUser = supabaseClient(url, keys.anon)
  const secondUser = supabaseClient(url, keys.anon)
  const serviceRole = supabaseClient(url, keys.serviceRole)
  const firstUserEmail = `first-${crypto.randomUUID()}@example.test`
  const firstSignup = await firstUser.auth.signUp({ email: firstUserEmail, password })
  const secondSignup = await secondUser.auth.signUp({
    email: `second-${crypto.randomUUID()}@example.test`,
    password,
  })
  assert(!firstSignup.error && firstSignup.data.user && firstSignup.data.session, `first signup failed: ${firstSignup.error?.message}`)
  assert(!secondSignup.error && secondSignup.data.user && secondSignup.data.session, `second signup failed: ${secondSignup.error?.message}`)
  return { anonymous, firstUser, secondUser, serviceRole, firstUserId: firstSignup.data.user.id, firstUserEmail }
}

async function expectRoleIsolation(clients: RoleClients): Promise<void> {
  const inserted = await clients.firstUser.from('private_notes').insert({ body: 'first-user-only' }).select().single()
  assert(!inserted.error, `first user insert failed: ${inserted.error?.message}`)
  assert(inserted.data.owner_id === clients.firstUserId, 'inserted row owner did not match the authenticated user')
  const firstRows = await clients.firstUser.from('private_notes').select('body')
  const secondRows = await clients.secondUser.from('private_notes').select('body')
  const anonymousRows = await clients.anonymous.from('private_notes').select('body')
  const serviceRows = await clients.serviceRole.from('private_notes').select('body')
  assert(!firstRows.error && firstRows.data.length === 1, 'first user could not read its row')
  assert(!secondRows.error && secondRows.data.length === 0, 'second user could read another user row')
  assert(!anonymousRows.error && anonymousRows.data.length === 0, 'anonymous role could read a private row')
  assert(!serviceRows.error && serviceRows.data.length === 1, 'service role could not inspect the private row')
}

async function expectStorageIsolation(clients: RoleClients): Promise<void> {
  const objectPath = `private/${crypto.randomUUID()}.txt`
  const uploaded = await clients.firstUser.storage.from('private-assets').upload(objectPath, 'first-user-storage', {
    contentType: 'text/plain',
  })
  assert(!uploaded.error, `first user storage upload failed: ${uploaded.error?.message}`)
  const firstDownload = await clients.firstUser.storage.from('private-assets').download(objectPath)
  assert(!firstDownload.error && await firstDownload.data.text() === 'first-user-storage', 'first user storage read failed')
  const secondDownload = await clients.secondUser.storage.from('private-assets').download(objectPath)
  const anonymousDownload = await clients.anonymous.storage.from('private-assets').download(objectPath)
  assert(secondDownload.error !== null, 'second user could download another user object')
  assert(anonymousDownload.error !== null, 'anonymous role could download a private object')
}

async function expectQueueSdkContract(clients: RoleClients): Promise<void> {
  const firstQueue = queueClient(clients.firstUser)
  const serviceQueue = queueClient(clients.serviceRole)
  await expectConcurrentQueueClaim(firstQueue, serviceQueue)
  await expectQueueRedelivery(firstQueue)
  await expectQueueBatch(firstQueue)
  await expectQueueAccessBoundaries(clients)
}

type QueueClient = ReturnType<typeof queueClient>

async function expectConcurrentQueueClaim(firstQueue: QueueClient, serviceQueue: QueueClient): Promise<void> {
  const sent = await firstQueue.send({ sequence: 1 })
  const claims = await Promise.all([
    firstQueue.receive({ visibilityTimeoutSec: 30 }),
    serviceQueue.receive({ visibilityTimeoutSec: 30 }),
  ])
  const claimed = claims.filter((message) => message !== null)
  const claimedMessage = claimed[0]
  assert(claimed.length === 1 && claimedMessage?.msg_id === sent.msg_id, 'concurrent queue consumers claimed the wrong cardinality')
  const acknowledged = await firstQueue.ack(claimedMessage.msg_id)
  assert(acknowledged.success && acknowledged.status === 'archived', 'queue acknowledgment did not archive the message')
}

async function expectQueueRedelivery(firstQueue: QueueClient): Promise<void> {
  await firstQueue.send({ redelivery: true })
  const firstDelivery = await firstQueue.receive({ visibilityTimeoutSec: 0 })
  const redelivery = await firstQueue.receive({ visibilityTimeoutSec: 30 })
  assert(firstDelivery && redelivery, 'queue visibility test did not return a message')
  assert(
    firstDelivery.msg_id === redelivery.msg_id && objectField(redelivery, 'read_ct') === 2,
    'queue visibility did not redeliver once',
  )
  await firstQueue.archive(redelivery.msg_id)
}

async function expectQueueBatch(firstQueue: QueueClient): Promise<void> {
  const batch = await firstQueue.sendBatch([{ batch: 1 }, { batch: 2 }])
  const batchMessages = await firstQueue.read({ visibilityTimeoutSec: 30, n: 2 })
  assert(batchMessages.map((message) => message.msg_id).join(',') === batch.map((message) => message.msg_id).join(','), 'queue batch order changed')
  const firstBatchMessage = batchMessages[0]
  const secondBatchMessage = batchMessages[1]
  assert(firstBatchMessage && secondBatchMessage, 'queue batch did not return two messages')
  assert((await firstQueue.archive(firstBatchMessage.msg_id)).success, 'queue archive failed')
  assert((await firstQueue.delete(secondBatchMessage.msg_id)).success, 'queue delete failed')
}

async function expectQueueAccessBoundaries(clients: RoleClients): Promise<void> {
  const publicQueue = clients.anonymous.schema('pgmq_public')
  const internalSend = await publicQueue.rpc('send', {
    queue_name: 'supacloud_internal_workflows',
    message: { denied: true },
    sleep_seconds: 0,
  })
  const rawQueueRead = await clients.firstUser.schema('pgmq').rpc('read', {
    queue_name: 'standalone_jobs',
    sleep_seconds: 30,
    n: 1,
  })
  assert(internalSend.data === null && internalSend.error?.code === '42501', 'internal workflow queue was publicly writable')
  assert(rawQueueRead.data === null && rawQueueRead.error?.code === 'PGRST106', 'raw pgmq schema was exposed')
}

async function expectWorkflowContract(serviceClient: SupabaseClient): Promise<void> {
  const workflows = workflowClient(serviceClient)
  await expectWorkflowIdempotency(workflows)
  await expectWorkflowLeaseRecovery(workflows)
  await expectWorkflowCancellation(workflows)
  await expectWorkflowDeadLetter(workflows)
}

type WorkflowClient = ReturnType<typeof workflowClient>

async function expectWorkflowIdempotency(workflows: WorkflowClient): Promise<void> {
  const runId = crypto.randomUUID()
  const starts = await Promise.all([startWorkflow(workflows, runId, 2), startWorkflow(workflows, runId, 2)])
  assert(starts.map((run) => run.idempotent).sort().join(',') === 'false,true', 'workflow start was not idempotent')
  const claims = await Promise.all([
    workflows.claim({ workerId: 'idempotent-a', visibilityTimeoutSeconds: 30 }),
    workflows.claim({ workerId: 'idempotent-b', visibilityTimeoutSeconds: 30 }),
  ])
  const claim = onlyClaim(claims, 'concurrent workflow claim')
  const request = { ...attemptRequest(claim), runOutput: { completed: true } }
  const completed = await workflows.complete(request)
  const repeated = await workflows.complete(request)
  assert(completed.status === 'completed' && repeated.idempotent, 'workflow completion was not idempotent')
}

async function expectWorkflowLeaseRecovery(workflows: WorkflowClient): Promise<void> {
  const runId = crypto.randomUUID()
  await startWorkflow(workflows, runId, 3)
  const expired = onlyClaim([
    await workflows.claim({ workerId: 'expired-worker', visibilityTimeoutSeconds: 15 }),
  ], 'initial lease claim')
  await Bun.sleep(15_250)
  const reclaimed = onlyClaim([
    await workflows.claim({ workerId: 'recovery-worker', visibilityTimeoutSeconds: 30 }),
  ], 'reclaimed lease claim')
  assert(reclaimed.runId === runId && reclaimed.attempt === 2, 'workflow lease was not reclaimed at attempt two')
  assert(await rejectedCode(() => workflows.complete({ ...attemptRequest(expired), runOutput: { stale: true } })) === '40001', 'stale worker completion was accepted')
  const retryRequest = { ...attemptRequest(reclaimed), errorMessage: 'retry once', delaySeconds: 0 } satisfies Parameters<WorkflowClient['retry']>[0]
  const retried = await workflows.retry(retryRequest)
  const repeated = await workflows.retry(retryRequest)
  assert(retried.steps[0]?.status === 'queued' && repeated.idempotent, 'workflow retry was not idempotent')
  const finalClaim = onlyClaim([
    await workflows.claim({ workerId: 'final-worker', visibilityTimeoutSeconds: 30 }),
  ], 'final retry claim')
  assert(finalClaim.attempt === 3, 'workflow retry attempt did not advance')
  assert((await workflows.complete({ ...attemptRequest(finalClaim), runOutput: { recovered: true } })).status === 'completed', 'recovered workflow did not complete')
}

async function expectWorkflowCancellation(workflows: WorkflowClient): Promise<void> {
  const runId = crypto.randomUUID()
  await startWorkflow(workflows, runId, 2)
  const claim = onlyClaim([
    await workflows.claim({ workerId: 'cancel-worker', visibilityTimeoutSeconds: 30 }),
  ], 'cancel workflow claim')
  const cancelled = await workflows.cancel(runId, 'operator request')
  const repeated = await workflows.cancel(runId, 'operator request')
  assert(cancelled.status === 'cancelled' && repeated.idempotent, 'workflow cancellation was not idempotent')
  assert(await rejectedCode(() => workflows.complete({ ...attemptRequest(claim), runOutput: { stale: true } })) === '40001', 'cancelled workflow accepted completion')
}

async function expectWorkflowDeadLetter(workflows: WorkflowClient): Promise<void> {
  const runId = crypto.randomUUID()
  await startWorkflow(workflows, runId, 1)
  const claim = onlyClaim([
    await workflows.claim({ workerId: 'dead-letter-worker', visibilityTimeoutSeconds: 30 }),
  ], 'dead-letter workflow claim')
  const failed = await workflows.retry({ ...attemptRequest(claim), errorMessage: 'permanent failure' })
  const events = await workflows.events(runId)
  assert(failed.status === 'failed' && failed.steps[0]?.status === 'dead_lettered', 'workflow did not enter dead letter state')
  assert(events.some((event) => event.eventType === 'step_dead_lettered'), 'workflow dead letter event was missing')
}

async function expectPgredisContract(url: string): Promise<void> {
  await cacheOperation(url, { operation: 'set', key: 'ttl-probe', cacheValue: { version: 1 }, ttlMs: 80 })
  const initial = await cacheOperation(url, { operation: 'inspect', key: 'ttl-probe' })
  assert(objectField(initial, 'cacheValue') !== null, 'pgredis TTL value was not readable')
  const ttlMs = objectField(initial, 'ttlMs')
  assert(typeof ttlMs === 'number' && ttlMs > 0 && ttlMs <= 80, 'pgredis TTL was outside the requested range')
  await Bun.sleep(120)
  const expired = await cacheOperation(url, { operation: 'get', key: 'ttl-probe' })
  assert(objectField(expired, 'cacheValue') === null, 'pgredis did not expire the TTL value')

  await cacheOperation(url, { operation: 'set', key: 'take-once', cacheValue: { present: true } })
  const deleted = await Promise.all(Array.from({ length: 8 }, () => (
    cacheOperation(url, { operation: 'getdel', key: 'take-once' })
  )))
  assert(deleted.filter((entry) => objectField(entry, 'cacheValue') !== null).length === 1, 'pgredis getdel was not atomic')
}

async function seedPersistentState(url: string, clients: RoleClients): Promise<PersistenceSeeds> {
  const queued = await queueClient(clients.firstUser).send({ persisted: true })
  const workflowRunId = crypto.randomUUID()
  await startWorkflow(workflowClient(clients.serviceRole), workflowRunId, 2)
  await cacheOperation(url, { operation: 'set', key: 'restart-probe', cacheValue: { persisted: true } })
  return { queueMessageId: queued.msg_id, workflowRunId, userEmail: clients.firstUserEmail }
}

async function expectPersistentState(url: string, keys: ProjectKeys, seeds: PersistenceSeeds): Promise<void> {
  const signedIn = supabaseClient(url, keys.anon)
  const login = await signedIn.auth.signInWithPassword({ email: seeds.userEmail, password })
  assert(!login.error && login.data.session, `auth session did not persist: ${login.error?.message}`)
  const queueMessage = await queueClient(signedIn).receive({ visibilityTimeoutSec: 30 })
  assert(queueMessage?.msg_id === seeds.queueMessageId && queueMessage.payload.persisted === true, 'queue message did not persist across restart')
  await queueClient(signedIn).ack(queueMessage.msg_id)

  const workflows = workflowClient(supabaseClient(url, keys.serviceRole))
  const snapshot = await workflows.get(seeds.workflowRunId)
  assert(snapshot?.status === 'queued', 'workflow snapshot did not persist across restart')
  const claim = onlyClaim([
    await workflows.claim({ workerId: 'restart-worker', visibilityTimeoutSeconds: 30 }),
  ], 'restart workflow claim')
  assert(claim.runId === seeds.workflowRunId, 'workflow restart claimed the wrong run')
  assert((await workflows.complete({ ...attemptRequest(claim), runOutput: { restarted: true } })).status === 'completed', 'restarted workflow did not complete')

  const cached = await cacheOperation(url, { operation: 'get', key: 'restart-probe' })
  assert(objectField(cached, 'cacheValue') && objectField(objectField(cached, 'cacheValue'), 'persisted') === true, 'pgredis value did not persist across restart')
}

function supabaseClient(url: string, apiKey: string): SupabaseClient {
  return createClient(url, apiKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

function queueClient(client: SupabaseClient) {
  return createSupaCloudClient({
    supabase: client,
    managementApiUrl: 'http://management-not-used',
    projectRef: 'lite',
  }).queue('standalone_jobs')
}

function workflowClient(client: SupabaseClient) {
  return createSupaCloudClient({
    supabase: client,
    managementApiUrl: 'http://management-not-used',
    projectRef: 'lite',
  }).workflows
}

function startWorkflow(workflows: WorkflowClient, runId: string, maxAttempts: number) {
  return workflows.start({
    runId,
    workflowName: 'standalone.acceptance',
    workflowVersion: '1',
    firstStepKey: 'execute',
    input: { runId },
    maxAttempts,
  })
}

function onlyClaim(claims: Array<Record<string, unknown> | null>, label: string): Record<string, unknown> {
  const claimed = claims.filter((claim): claim is Record<string, unknown> => claim?.status === 'claimed')
  assert(claimed.length === 1, `${label} expected one claim, got ${claimed.length}`)
  const claim = claimed[0]
  assert(claim, `${label} did not return a claim`)
  return claim
}

function attemptRequest(claim: Record<string, unknown>) {
  return {
    stepId: String(claim.stepId),
    messageId: String(claim.messageId),
    attempt: Number(claim.attempt),
    workerId: String(claim.workerId),
  }
}

async function rejectedCode(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
  } catch (error) {
    if (typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>).code === 'string') {
      return String((error as Record<string, unknown>).code)
    }
    throw error
  }
  throw new Error('operation unexpectedly succeeded')
}

async function cacheOperation(url: string, command: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${url}/functions/v1/cache-probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  })
  const responseText = await response.text()
  assert(response.ok, `pgredis probe returned HTTP ${response.status}: ${responseText}`)
  return JSON.parse(responseText) as unknown
}

function objectField(candidate: unknown, key: string): unknown {
  assert(typeof candidate === 'object' && candidate !== null, `expected an object containing ${key}`)
  return (candidate as Record<string, unknown>)[key]
}

async function withServer<T>(
  environment: NodeJS.ProcessEnv,
  keys: ProjectKeys,
  check: (url: string) => Promise<T>,
): Promise<T> {
  const port = await findEphemeralPort()
  const server = startNativeServer(environment, port)
  let checkCompleted: boolean = false
  try {
    const url = `http://127.0.0.1:${port}`
    await waitForHealth(url, server.processHandle)
    const authHealth = await fetch(`${url}/auth/v1/health`, { headers: { apikey: keys.anon } })
    assert(authHealth.ok && objectField(await authHealth.json(), 'version') === packageJson.version, 'auth version endpoint mismatch')
    const checkResult = await check(url)
    checkCompleted = true
    return checkResult
  } finally {
    await stopNativeServer(server, checkCompleted)
  }
}

function startNativeServer(environment: NodeJS.ProcessEnv, port: number) {
  const processHandle = Bun.spawn({
    cmd: [...projectCommand('start'), '--host', '127.0.0.1', '--port', String(port)],
    cwd: projectDir,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    processHandle,
    stdout: new Response(processHandle.stdout).text(),
    stderr: new Response(processHandle.stderr).text(),
  }
}

type NativeServer = ReturnType<typeof startNativeServer>

async function stopNativeServer(server: NativeServer, checkCompleted: boolean): Promise<void> {
  server.processHandle.kill('SIGTERM')
  const exitCode = await withWindowsSubprocessRef(() => server.processHandle.exited)
  const [stdoutText, stderrText] = await Promise.all([server.stdout, server.stderr])
  if (!checkCompleted && stdoutText) console.error(`[standalone-native-smoke] stdout:\n${stdoutText}`)
  if (!checkCompleted && stderrText) console.error(`[standalone-native-smoke] stderr:\n${stderrText}`)
  if (!isRequestedShutdown(exitCode)) {
    throw new Error(`standalone native server exited with ${exitCode}\n${stdoutText}\n${stderrText}`)
  }
}

function isRequestedShutdown(exitCode: number): boolean {
  // Bun may report an explicitly delivered SIGTERM as either graceful exit or 128 + SIGTERM.
  return exitCode === 0 || exitCode === 143
}

async function waitForHealth(url: string, processHandle: Bun.Subprocess): Promise<void> {
  for (let attempt: number = 0; attempt < 600; attempt++) {
    if (processHandle.exitCode !== null) throw new Error(`standalone native server exited before health (${processHandle.exitCode})`)
    try {
      if ((await fetch(`${url}/health`)).ok) return
    } catch (error) {
      if (!isConnectionRefused(error)) throw error
      // Native PostgreSQL and Edge Functions initialize before the port opens.
    }
    await Bun.sleep(100)
  }
  throw new Error('standalone native server did not become healthy within 60 seconds')
}

function isConnectionRefused(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === 'ConnectionRefused' || code === 'ECONNREFUSED'
}

async function findEphemeralPort(): Promise<number> {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  return port
}

async function runCommand(commandLabel: string, command: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const execution = await executeBufferedCommand({ command, cwd: projectDir, env, timeoutMs: commandTimeoutMs })
  if (execution.timedOut) throw new Error(`${commandLabel} timed out after ${commandTimeoutMs}ms`)
  if (execution.exitCode !== 0) throw new Error(`${commandLabel} failed (${execution.exitCode})\n${execution.stderr}`)
  return execution.stdout
}

function parseProjectKeys(output: string): ProjectKeys {
  const anon = output.match(/anon key:\s*\n([^\n]+)/)?.[1]?.trim()
  const serviceRole = output.match(/service_role key:\s*\n([^\n]+)/)?.[1]?.trim()
  assert(anon && serviceRole, 'CLI did not return both project keys')
  return { anon, serviceRole }
}

function resolveStandaloneBinary(): string {
  const configuredBinary = process.env.SUPACLOUD_LITE_STANDALONE_BINARY
  if (configuredBinary) return resolve(configuredBinary)
  return join(packageDir, 'dist', 'standalone', 'supacloud-lite')
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const projectConfig = `
[auth.email]
enable_confirmations = false

[storage.buckets.private-assets]
public = false
allowed_mime_types = ["text/plain"]

[functions.cache-probe]
verify_jwt = false
`

const acceptanceMigration = `
create table public.private_notes (
  id bigint generated by default as identity primary key,
  owner_id uuid not null default auth.uid(),
  body text not null
);

alter table public.private_notes enable row level security;

create policy private_notes_select on public.private_notes
  for select to authenticated using (owner_id = auth.uid());
create policy private_notes_insert on public.private_notes
  for insert to authenticated with check (owner_id = auth.uid());

create policy private_assets_select on storage.objects
  for select to authenticated
  using (bucket_id = 'private-assets' and owner = auth.uid() and owner_id = auth.uid()::text);
create policy private_assets_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'private-assets' and owner = auth.uid() and owner_id = auth.uid()::text);
create policy private_assets_update on storage.objects
  for update to authenticated
  using (bucket_id = 'private-assets' and owner = auth.uid() and owner_id = auth.uid()::text)
  with check (bucket_id = 'private-assets' and owner = auth.uid() and owner_id = auth.uid()::text);
create policy private_assets_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'private-assets' and owner = auth.uid() and owner_id = auth.uid()::text);

grant usage on schema public to anon, authenticated, service_role;
grant select on public.private_notes to anon;
grant select, insert on public.private_notes to authenticated, service_role;
grant usage, select on sequence public.private_notes_id_seq to authenticated, service_role;
select pgmq.create('standalone_jobs');
`

const cacheProbeFunction = `
Deno.serve(async (request) => {
  const command = await request.json()
  const cache = globalThis.SupaCloud.pgredis
  if (command.operation === 'set') {
    return Response.json({ stored: await cache.set(command.key, command.cacheValue, command.ttlMs) })
  }
  if (command.operation === 'get') {
    return Response.json({ cacheValue: await cache.get(command.key) })
  }
  if (command.operation === 'inspect') {
    return Response.json({ cacheValue: await cache.get(command.key), ttlMs: await cache.ttl(command.key) })
  }
  if (command.operation === 'getdel') {
    return Response.json({ cacheValue: await cache.getdel(command.key) })
  }
  return Response.json({ error: 'unsupported cache operation' }, { status: 400 })
})
`

await main()
