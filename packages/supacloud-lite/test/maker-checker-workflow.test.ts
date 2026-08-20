import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createSupaCloudClient } from './helpers/supacloud-js-source.js'
import {
  createLiteBackend,
  createNativeEngine,
  signJwt,
  type SupaCloudLiteBackend,
} from '../src/index.js'

const nativeMode = process.env.SUPACLOUD_LITE_TEST_NATIVE === '1'
const makerId = '11111111-1111-4111-8111-111111111111'
const checkerId = '22222222-2222-4222-8222-222222222222'
const documentId = '33333333-3333-4333-8333-333333333333'

describe(`Maker-Checker and workflow dispatcher (${nativeMode ? 'native' : 'pglite'})`, () => {
  test('enforces transitions and dispatches the durable workflow through @supacloud/js', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), `supacloud-lite-maker-checker-${nativeMode ? 'native' : 'pglite'}-`))
    let backend: SupaCloudLiteBackend | undefined
    try {
      backend = await makerCheckerBackend(join(rootDir, 'database'))
      await seedReviewDocument(backend)
      const maker = await authenticatedClient(backend, makerId)
      const checker = await authenticatedClient(backend, checkerId)
      const service = supabaseClient(backend, backend.serviceRoleKey, backend.serviceRoleKey)
      const supacloud = createSupaCloudClient({
        supabase: service,
        managementApiUrl: 'http://management-not-used',
        projectRef: 'lite',
      })

      expect((await checker.rpc('transition_review_document', {
        request: transitionRequest('approve', 1, 'checker-before-submit'),
      })).error?.code).toBe('55000')
      expect((await maker.rpc('transition_review_document', {
        request: transitionRequest('submit', 1, 'maker-submit'),
      })).data).toMatchObject({ status: 'submitted', rowVersion: '2', idempotent: false })
      expect((await maker.rpc('transition_review_document', {
        request: transitionRequest('submit', 1, 'maker-submit'),
      })).data).toMatchObject({ status: 'submitted', rowVersion: '2', idempotent: true })
      expect((await maker.rpc('transition_review_document', {
        request: transitionRequest('approve', 2, 'maker-self-approval'),
      })).error?.code).toBe('42501')
      expect((await checker.rpc('transition_review_document', {
        request: transitionRequest('approve', 1, 'stale-approval'),
      })).error?.code).toBe('40001')
      expect((await checker.rpc('transition_review_document', {
        request: transitionRequest('approve', 2, 'checker-approval'),
      })).data).toMatchObject({ status: 'approved', rowVersion: '3', idempotent: false })

      await expect(backend.db.query(
        `update public.review_documents set status = 'draft' where id = $1`,
        [documentId],
      )).rejects.toThrow('REVIEW_DOCUMENT_DIRECT_TRANSITION_FORBIDDEN')
      await expect(backend.db.query(
        `delete from public.review_document_transition_events where document_id = $1`,
        [documentId],
      )).rejects.toThrow('REVIEW_DOCUMENT_EVENT_APPEND_ONLY')

      const transitionState = await backend.db.query<{ status: string; row_version: number; event_count: number; outbox_count: number }>(`
        SELECT
          document.status,
          document.row_version,
          (SELECT count(*)::integer FROM public.review_document_transition_events event
           WHERE event.document_id = document.id) AS event_count,
          (SELECT count(*)::integer FROM public.review_document_workflow_outbox outbox
           WHERE outbox.document_id = document.id) AS outbox_count
        FROM public.review_documents document WHERE document.id = $1
      `, [documentId])
      expect(transitionState.rows).toEqual([{
        status: 'approved',
        row_version: 3,
        event_count: 2,
        outbox_count: 1,
      }])

      const dispatch = await service.rpc('claim_review_document_workflow', {
        request: { workerId: 'lite-dispatcher', leaseSeconds: 300 },
      })
      expect(dispatch.error).toBeNull()
      const claim = requireDispatchClaim(dispatch.data)
      expect(claim).toMatchObject({
        workflowName: 'review-document.after-approval',
        workflowVersion: '1',
        firstStepKey: 'render',
      })
      const started = await supacloud.workflows.start({
        runId: claim.runId,
        workflowName: claim.workflowName,
        workflowVersion: claim.workflowVersion,
        firstStepKey: claim.firstStepKey,
        input: claim.input,
        maxAttempts: 5,
      })
      expect(started).toMatchObject({ runId: claim.runId, status: 'queued', idempotent: false })
      expect((await supacloud.workflows.start({
        runId: claim.runId,
        workflowName: claim.workflowName,
        workflowVersion: claim.workflowVersion,
        firstStepKey: claim.firstStepKey,
        input: claim.input,
        maxAttempts: 5,
      })).idempotent).toBe(true)
      expect((await service.rpc('complete_review_document_workflow_dispatch', {
        request: {
          outboxId: claim.outboxId,
          claimToken: claim.claimToken,
          workerId: 'lite-dispatcher',
        },
      })).data).toEqual({ outboxId: claim.outboxId, dispatched: true })
      expect((await service.rpc('claim_review_document_workflow', {
        request: { workerId: 'lite-dispatcher', leaseSeconds: 300 },
      })).data).toBeNull()

      const workflowClaim = await supacloud.workflows.claim({
        workerId: 'lite-workflow-worker',
        visibilityTimeoutSeconds: 30,
      })
      if (!workflowClaim || workflowClaim.status !== 'claimed') throw new Error('expected queued workflow step')
      const completed = await supacloud.workflows.complete({
        stepId: workflowClaim.stepId,
        messageId: workflowClaim.messageId,
        attempt: workflowClaim.attempt,
        workerId: workflowClaim.workerId,
        runOutput: { artifactId: '44444444-4444-4444-8444-444444444444' },
      })
      expect(completed).toMatchObject({ runId: claim.runId, status: 'completed' })
    } finally {
      await backend?.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  }, 180_000)
})

async function makerCheckerBackend(dataDir: string): Promise<SupaCloudLiteBackend> {
  const examples = resolve(import.meta.dir, '../../../docs/examples')
  const migrations = await Promise.all([
    ['20260820010000_maker_checker', 'maker-checker-state-machine.sql'],
    ['20260820010001_workflow_bridge', 'maker-checker-workflow-bridge.sql'],
  ].map(async ([name, file]) => ({ name, sql: await readFile(join(examples, file), 'utf8') })))
  const config = {
    jwtSecret: 'x'.repeat(64),
    vaultKey: 'y'.repeat(64),
    migrations,
    log: () => {},
  }
  if (!nativeMode) return createLiteBackend({ ...config, dataDir })
  return createLiteBackend({ ...config, engine: await createNativeEngine({ dataDir }) })
}

async function seedReviewDocument(backend: SupaCloudLiteBackend): Promise<void> {
  await backend.db.query(`
    insert into auth.users (id, aud, role, raw_app_meta_data, raw_user_meta_data)
    values
      ($1, 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}', '{}'),
      ($2, 'authenticated', 'authenticated', '{"provider":"email","providers":["email"]}', '{}')
  `, [makerId, checkerId])
  await backend.db.query(`
    insert into public.review_documents (id, maker_id, payload)
    values ($2, $1, '{"sampleId":"sample-1","result":"pass"}')
  `, [makerId, documentId])
  await backend.db.query(`
    insert into public.review_document_members (document_id, user_id, role)
    values ($1, $2, 'maker'), ($1, $3, 'checker')
  `, [documentId, makerId, checkerId])
}

async function authenticatedClient(backend: SupaCloudLiteBackend, userId: string): Promise<SupabaseClient> {
  const token = await signJwt({ role: 'authenticated', sub: userId }, backend.jwtSecret)
  return supabaseClient(backend, token)
}

function supabaseClient(backend: SupaCloudLiteBackend, bearer: string, apiKey = backend.anonKey): SupabaseClient {
  return createClient('http://local', apiKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: backend.fetch, headers: { authorization: `Bearer ${bearer}` } },
  })
}

function transitionRequest(event: string, expectedVersion: number, idempotencyKey: string) {
  return { documentId, event, expectedVersion, idempotencyKey }
}

function requireDispatchClaim(value: unknown): {
  outboxId: string
  claimToken: string
  runId: string
  workflowName: string
  workflowVersion: string
  firstStepKey: string
  input: Record<string, unknown>
} {
  if (!value || typeof value !== 'object') throw new Error('expected workflow dispatch claim')
  return value as ReturnType<typeof requireDispatchClaim>
}
