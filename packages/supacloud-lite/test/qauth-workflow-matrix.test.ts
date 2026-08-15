import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createSupaCloudClient } from './helpers/supacloud-js-source.js'
import {
  createLiteBackend,
  createNativeEngine,
  signJwt,
  type SupaCloudLiteBackend,
} from '../src/index.js'

const backendConfig = {
  jwtSecret: 'x'.repeat(64),
  vaultKey: 'y'.repeat(64),
  log: () => {},
}
const nativeMode = process.env.SUPACLOUD_LITE_TEST_NATIVE === '1'
type WorkflowClient = ReturnType<typeof workflowClient>

describe(`queue, authorization, and workflow matrix (${nativeMode ? 'native' : 'pglite'})`, () => {
  test('preserves queue delivery, visibility, concurrency, and access boundaries', async () => {
    await withBackend('queues', exerciseQueueMatrix)
  }, 180_000)

  test('preserves workflow claims, lease recovery, backoff, cancellation, and dead letters', async () => {
    await withBackend('workflows', exerciseWorkflowMatrix)
  }, 180_000)

  test('reopens queued messages and workflow snapshots from persistent storage', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), `supacloud-lite-matrix-persistence-${nativeMode ? 'native' : 'pglite'}-`))
    const dataDir = join(rootDir, 'database')
    const runId = crypto.randomUUID()
    let backend: SupaCloudLiteBackend | undefined
    try {
      backend = await matrixBackend(dataDir)
      await backend.db.query(`select pgmq.create('persistent_jobs')`)
      await backend.db.query(`select pgmq.send('persistent_jobs', '{"persisted":true}'::jsonb, 0)`)
      await startWorkflow(workflowClient(backend), runId, 2)
      await backend.close()
      backend = undefined
      backend = await matrixBackend(dataDir)
      await expectPersistentState(backend, runId)
    } finally {
      await backend?.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  }, 180_000)
})

async function withBackend(label: string, run: (backend: SupaCloudLiteBackend) => Promise<void>): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), `supacloud-lite-matrix-${label}-${nativeMode ? 'native' : 'pglite'}-`))
  let backend: SupaCloudLiteBackend | undefined
  try {
    backend = await matrixBackend(join(rootDir, 'database'))
    await run(backend)
  } finally {
    await backend?.close()
    await rm(rootDir, { recursive: true, force: true })
  }
}

async function exerciseQueueMatrix(backend: SupaCloudLiteBackend): Promise<void> {
  const clients = await roleClients(backend)
  const queue = clients.anon.schema('pgmq_public')
  await backend.db.query(`select pgmq.create('matrix_jobs')`)
  await expectConcurrentQueueClaims(backend, clients)
  await expectQueueVisibility(queue)
  for (const client of Object.values(clients)) await expectInternalQueueDenied(client)
  for (const client of [clients.anon, clients.authenticated]) await expectRawQueueDenied(client)
}

async function expectConcurrentQueueClaims(
  backend: SupaCloudLiteBackend,
  clients: Record<'anon' | 'authenticated' | 'service', SupabaseClient>,
) {
  const queue = clients.anon.schema('pgmq_public')
  const sent = await queue.rpc('send', {
    queue_name: 'matrix_jobs',
    message: { sequence: 1 },
    sleep_seconds: 0,
  })
  expect(sent.error).toBeNull()
  const reads = await Promise.all([
    clients.authenticated.schema('pgmq_public').rpc('read', queueRead('matrix_jobs', 30)),
    clients.service.schema('pgmq_public').rpc('read', queueRead('matrix_jobs', 30)),
  ])
  const claimedIds = reads.flatMap((response) => queueMessageIds(response.data))
  expect(reads.map((response) => response.error)).toEqual([null, null])
  expect(claimedIds).toEqual([1])
  expect(reads.map((response) => queueMessageIds(response.data).length).sort()).toEqual([0, 1])
  expect(queueMessageIds((await queue.rpc('read', queueRead('matrix_jobs', 30))).data)).toEqual([])
  expect((await queue.rpc('archive', { queue_name: 'matrix_jobs', message_id: 1 })).data).toBe(true)
  await expectArchivedQueueInvariant(backend)
  expect((await queue.rpc('send_batch', {
    queue_name: 'matrix_jobs',
    messages: [{ sequence: 2 }, { sequence: 3 }],
    sleep_seconds: 0,
  })).error).toBeNull()
  expect((await queue.rpc('delete', { queue_name: 'matrix_jobs', message_id: 2 })).data).toBe(true)
  expect(queueMessageIds((await queue.rpc('pop', { queue_name: 'matrix_jobs' })).data)).toEqual([3])
}

async function expectArchivedQueueInvariant(backend: SupaCloudLiteBackend): Promise<void> {
  const counts = await backend.db.query<{ active_count: number; archive_count: number }>(`
    select
      (select count(*)::integer from pgmq.q_matrix_jobs where msg_id = 1) as active_count,
      (select count(*)::integer from pgmq.a_matrix_jobs where msg_id = 1) as archive_count
  `)
  expect(counts.rows).toEqual([{ active_count: 0, archive_count: 1 }])
}

async function expectQueueVisibility(queue: ReturnType<SupabaseClient['schema']>): Promise<void> {
  const sent = await queue.rpc('send', {
    queue_name: 'matrix_jobs',
    message: { visibility: true },
    sleep_seconds: 0,
  })
  expect(sent.error).toBeNull()
  const firstVisible = queueMessage((await queue.rpc('read', queueRead('matrix_jobs', 0))).data)
  const redelivered = queueMessage((await queue.rpc('read', queueRead('matrix_jobs', 30))).data)
  expect(redelivered).toMatchObject({ msg_id: firstVisible.msg_id, read_ct: 2 })
}

async function exerciseWorkflowMatrix(backend: SupaCloudLiteBackend): Promise<void> {
  const workflows = workflowClient(backend)
  await expectSingleWorkflowClaim(workflows)
  await expectWorkflowLeaseRecovery(backend, workflows)
  await expectWorkflowCancellation(workflows)
  await expectWorkflowDeadLetter(workflows)
}

async function expectSingleWorkflowClaim(workflows: WorkflowClient): Promise<void> {
  const runId = crypto.randomUUID()
  const starts = await Promise.all([
    startWorkflow(workflows, runId, 3),
    startWorkflow(workflows, runId, 3),
  ])
  expect(starts.map((snapshot) => snapshot.idempotent).sort()).toEqual([false, true])
  expect(starts.every((snapshot) => snapshot.steps.length === 1)).toBe(true)
  const claims = await Promise.all([
    workflows.claim({ workerId: 'worker-a', visibilityTimeoutSeconds: 30 }),
    workflows.claim({ workerId: 'worker-b', visibilityTimeoutSeconds: 30 }),
  ])
  const claimed = claims.filter(isClaimed)
  expect(claimed).toHaveLength(1)
  expect(claims.filter((claim) => claim === null)).toHaveLength(1)
  await workflows.complete({ ...attemptRequest(requireClaim(claimed[0] ?? null)), runOutput: { completed: true } })
}

async function expectWorkflowLeaseRecovery(backend: SupaCloudLiteBackend, workflows: WorkflowClient): Promise<void> {
  const runId = crypto.randomUUID()
  await startWorkflow(workflows, runId, 3)
  const expired = requireClaim(await workflows.claim({ workerId: 'expired-worker', visibilityTimeoutSeconds: 30 }))
  await makeWorkflowMessageVisible(backend, expired)
  const reclaimed = requireClaim(await workflows.claim({ workerId: 'recovery-worker', visibilityTimeoutSeconds: 30 }))
  expect(reclaimed).toMatchObject({ runId, attempt: 2 })
  await expectStaleWorkflowAttemptDenied(workflows, expired)
  await expectWorkflowBackoff(backend, workflows, reclaimed, runId)
}

async function expectStaleWorkflowAttemptDenied(workflows: WorkflowClient, expired: Record<string, unknown>) {
  await expect(workflows.advance({
    ...attemptRequest(expired),
    output: { stale: true },
    nextStepKey: 'should-not-run',
    nextInput: {},
  })).rejects.toMatchObject({ code: '40001' })
  await expect(workflows.complete({
    ...attemptRequest(expired),
    runOutput: { stale: true },
  })).rejects.toMatchObject({ code: '40001' })
}

async function expectWorkflowBackoff(
  backend: SupaCloudLiteBackend,
  workflows: WorkflowClient,
  reclaimed: Record<string, unknown>,
  runId: string,
): Promise<void> {
  const retried = await workflows.retry({
    ...attemptRequest(reclaimed),
    errorMessage: 'dependency unavailable',
    delaySeconds: 30,
  })
  expect(retried.steps[0]).toMatchObject({ status: 'queued', attempts: 2 })
  expect(await workflows.claim({ workerId: 'early-worker', visibilityTimeoutSeconds: 30 })).toBeNull()
  await makeWorkflowMessageVisible(backend, reclaimed)
  const finalClaim = requireClaim(await workflows.claim({ workerId: 'final-worker', visibilityTimeoutSeconds: 30 }))
  expect(finalClaim).toMatchObject({ runId, attempt: 3 })
  await workflows.complete({ ...attemptRequest(finalClaim), runOutput: { recovered: true } })
}

async function expectWorkflowCancellation(workflows: WorkflowClient): Promise<void> {
  const runId = crypto.randomUUID()
  await startWorkflow(workflows, runId, 2)
  const claim = requireClaim(await workflows.claim({ workerId: 'cancelled-worker', visibilityTimeoutSeconds: 30 }))
  expect((await workflows.cancel(runId, 'operator request')).status).toBe('cancelled')
  await expect(workflows.complete({
    ...attemptRequest(claim),
    runOutput: { shouldNotComplete: true },
  })).rejects.toMatchObject({ code: '40001' })
  expect(await workflows.get(runId)).toMatchObject({ runId, status: 'cancelled' })
  expect(await workflows.claim({ workerId: 'cancel-check', visibilityTimeoutSeconds: 30 })).toBeNull()
}

async function expectWorkflowDeadLetter(workflows: WorkflowClient): Promise<void> {
  const runId = crypto.randomUUID()
  await startWorkflow(workflows, runId, 1)
  const claim = requireClaim(await workflows.claim({ workerId: 'dead-letter-worker', visibilityTimeoutSeconds: 30 }))
  const exhausted = await workflows.retry({ ...attemptRequest(claim), errorMessage: 'permanent failure' })
  expect(exhausted).toMatchObject({ status: 'failed' })
  expect(exhausted.steps[0]).toMatchObject({ status: 'dead_lettered', attempts: 1 })
  expect((await workflows.events(runId)).map((event) => event.eventType)).toContain('step_dead_lettered')
}

async function expectPersistentState(backend: SupaCloudLiteBackend, runId: string): Promise<void> {
  const queueRows = await backend.db.query<{ message: { persisted?: boolean } }>(
    `select * from pgmq.read('persistent_jobs', 30, 1)`
  )
  expect(queueRows.rows[0]?.message).toEqual({ persisted: true })
  const workflows = workflowClient(backend)
  expect(await workflows.get(runId)).toMatchObject({ runId, status: 'queued' })
  expect((await workflows.events(runId)).map((event) => event.eventType)).toContain('run_started')
  const claim = requireClaim(await workflows.claim({ workerId: 'restart-worker', visibilityTimeoutSeconds: 30 }))
  expect(claim).toMatchObject({ runId, attempt: 1 })
  expect((await workflows.complete({ ...attemptRequest(claim), runOutput: { restarted: true } })).status).toBe('completed')
  expect((await workflows.events(runId)).map((event) => event.eventType)).toContain('run_completed')
}

async function matrixBackend(dataDir: string): Promise<SupaCloudLiteBackend> {
  if (!nativeMode) return createLiteBackend({ ...backendConfig, dataDir })
  return createLiteBackend({ ...backendConfig, engine: await createNativeEngine({ dataDir }) })
}

async function roleClients(backend: SupaCloudLiteBackend): Promise<Record<'anon' | 'authenticated' | 'service', SupabaseClient>> {
  const token = await signJwt(
    { role: 'authenticated', sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    backend.jwtSecret,
  )
  return {
    anon: supabaseClient(backend, backend.anonKey),
    authenticated: supabaseClient(backend, token),
    service: supabaseClient(backend, backend.serviceRoleKey, backend.serviceRoleKey),
  }
}

function supabaseClient(backend: SupaCloudLiteBackend, bearer: string, apiKey = backend.anonKey): SupabaseClient {
  return createClient('http://local', apiKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: backend.fetch,
      headers: { authorization: `Bearer ${bearer}` },
    },
  })
}

function workflowClient(backend: SupaCloudLiteBackend) {
  return createSupaCloudClient({
    supabase: supabaseClient(backend, backend.serviceRoleKey, backend.serviceRoleKey),
    managementApiUrl: 'http://management-not-used',
    projectRef: 'lite',
  }).workflows
}

function queueRead(queueName: string, visibilityTimeoutSeconds: number) {
  return { queue_name: queueName, sleep_seconds: visibilityTimeoutSeconds, n: 1 }
}

function queueMessageIds(payload: unknown): number[] {
  if (!Array.isArray(payload)) return []
  return payload.flatMap((entry) => isQueueMessage(entry) ? [entry.msg_id] : [])
}

function queueMessage(payload: unknown): { msg_id: number; read_ct: number } {
  if (!Array.isArray(payload) || !isQueueMessage(payload[0])) throw new Error('expected one queue message')
  return payload[0]
}

function isQueueMessage(candidate: unknown): candidate is { msg_id: number; read_ct: number } {
  return typeof candidate === 'object' && candidate !== null
    && typeof (candidate as Record<string, unknown>).msg_id === 'number'
    && typeof (candidate as Record<string, unknown>).read_ct === 'number'
}

async function expectInternalQueueDenied(client: SupabaseClient): Promise<void> {
  const queue = client.schema('pgmq_public')
  const responses = await Promise.all([
    queue.rpc('send', {
      queue_name: 'supacloud_internal_workflows',
      message: { denied: true },
      sleep_seconds: 0,
    }),
    queue.rpc('read', queueRead('supacloud_internal_workflows', 30)),
    queue.rpc('pop', { queue_name: 'supacloud_internal_workflows' }),
  ])
  expect(responses.map((response) => response.data)).toEqual([null, null, null])
  expect(responses.map((response) => response.error?.code)).toEqual(['42501', '42501', '42501'])
}

async function expectRawQueueDenied(client: SupabaseClient): Promise<void> {
  const response = await client.schema('pgmq').rpc('read', queueRead('matrix_jobs', 30))
  expect(response.data).toBeNull()
  expect(response.error?.code).toBe('PGRST106')
}

async function startWorkflow(
  workflows: WorkflowClient,
  runId: string,
  maxAttempts: number,
): ReturnType<WorkflowClient['start']> {
  return workflows.start({
    runId,
    workflowName: 'matrix.workflow',
    workflowVersion: '1',
    firstStepKey: 'execute',
    input: { runId },
    maxAttempts,
  })
}

function isClaimed(claim: Record<string, unknown> | null): claim is Record<string, unknown> {
  return claim?.status === 'claimed'
}

function requireClaim(claim: Record<string, unknown> | null): Record<string, unknown> {
  expect(claim).toMatchObject({ status: 'claimed' })
  if (!isClaimed(claim)) throw new Error('expected a claimed workflow step')
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

async function makeWorkflowMessageVisible(
  backend: SupaCloudLiteBackend,
  claim: Record<string, unknown>,
): Promise<void> {
  await backend.db.query(
    `select * from pgmq.set_vt('supacloud_internal_workflows', $1, 0)`,
    [String(claim.messageId)],
  )
}
