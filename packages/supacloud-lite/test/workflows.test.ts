import { describe, expect, test } from 'bun:test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createSupaCloudClient } from './helpers/supacloud-js-source.js'
import { createLiteBackend } from '../src/index.js'
import { signJwt } from '../src/runtime/jwt.js'

const backendConfig = {
  jwtSecret: 'x'.repeat(64),
  vaultKey: 'y'.repeat(64),
  log: () => {},
}

const firstRunId = '11111111-1111-4111-8111-111111111111'
const cancelledRunId = '22222222-2222-4222-8222-222222222222'
const exhaustedRunId = '33333333-3333-4333-8333-333333333333'
const failedRunId = '44444444-4444-4444-8444-444444444444'
const missingStepRunId = '55555555-5555-4555-8555-555555555555'
const highMessageRunId = '66666666-6666-4666-8666-666666666666'
const versionSevenRunId = '019c4f64-7b21-7d00-8000-000000000001'

describe('Durable workflows', () => {
  test('enforces service-role access and durable step semantics end to end', async () => {
    const backend = await createLiteBackend(backendConfig)
    try {
      const anon = supabaseClient(backend.anonKey, backend.fetch)
      const authenticatedToken = await signJwt(
        { role: 'authenticated', sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        backend.jwtSecret,
      )
      const authenticated = supabaseClient(backend.anonKey, backend.fetch, authenticatedToken)
      const serviceSupabase = supabaseClient(backend.serviceRoleKey, backend.fetch)
      const workflows = createSupaCloudClient({
        supabase: serviceSupabase,
        managementApiUrl: 'http://management-not-used',
        projectRef: 'lite',
      }).workflows

      for (const client of [anon, authenticated]) {
        const denied = await client.rpc('supacloud_workflow_get', { request: { runId: firstRunId } })
        expect(denied.data).toBeNull()
        expect(denied.error?.code).toBe('42501')
      }
      for (const client of [anon, authenticated, serviceSupabase]) {
        for (const queueName of [
          'supacloud_internal_workflows',
          'SUPACLOUD_INTERNAL_WORKFLOWS',
          'SupaCloud_Internal_Workflows',
        ]) {
          const internalQueue = await client.schema('pgmq_public').rpc('read', {
            queue_name: queueName,
            sleep_seconds: 30,
            n: 1,
          })
          expect(internalQueue.data).toBeNull()
          expect(internalQueue.error?.code).toBe('42501')
        }
      }

      const started = await workflows.start({
        runId: firstRunId,
        workflowName: 'invoice.issue',
        workflowVersion: '1',
        firstStepKey: 'validate',
        input: { invoiceId: 'inv-1' },
        maxAttempts: 3,
      })
      expect(started).toMatchObject({ runId: firstRunId, status: 'queued', idempotent: false })
      expect(started.steps).toHaveLength(1)
      expect((await workflows.start({
        runId: firstRunId,
        workflowName: 'invoice.issue',
        workflowVersion: '1',
        firstStepKey: 'validate',
        input: { invoiceId: 'inv-1' },
        maxAttempts: 3,
      })).idempotent).toBe(true)
      await expect(workflows.start({
        runId: firstRunId,
        workflowName: 'invoice.issue',
        workflowVersion: '1',
        firstStepKey: 'validate',
        input: { invoiceId: 'changed' },
        maxAttempts: 3,
      })).rejects.toMatchObject({ code: '23505' })

      const firstClaim = requireClaim(await workflows.claim({
        workerId: 'worker-1',
        visibilityTimeoutSeconds: 30,
      }))
      const firstAttempt = attemptRequest(firstClaim)
      expect(firstClaim).toMatchObject({ status: 'claimed', runId: firstRunId, stepKey: 'validate', attempt: 1 })

      const retried = await workflows.retry({ ...firstAttempt, errorMessage: 'temporary', delaySeconds: 0 })
      expect(retried.steps[0]).toMatchObject({ status: 'queued', attempts: 1 })
      expect((await workflows.retry({ ...firstAttempt, errorMessage: 'temporary', delaySeconds: 0 })).idempotent).toBe(true)

      const reclaimed = requireClaim(await workflows.claim({ workerId: 'worker-2', visibilityTimeoutSeconds: 30 }))
      expect(reclaimed).toMatchObject({ runId: firstRunId, stepKey: 'validate', attempt: 2 })
      expect((await workflows.retry({ ...firstAttempt, errorMessage: 'temporary', delaySeconds: 0 })).idempotent).toBe(true)
      await expect(workflows.retry({
        ...firstAttempt,
        errorMessage: 'changed',
        delaySeconds: 0,
      })).rejects.toMatchObject({ code: '23505' })
      await expect(workflows.advance({
        ...firstAttempt,
        output: { valid: true },
        nextStepKey: 'render',
        nextInput: { invoiceId: 'inv-1' },
      })).rejects.toMatchObject({ code: '40001' })

      const advanceRequest = {
        ...attemptRequest(reclaimed),
        output: { valid: true },
        nextStepKey: 'render',
        nextInput: { invoiceId: 'inv-1' },
        nextMaxAttempts: 2,
      }
      const advanced = await workflows.advance(advanceRequest)
      expect(advanced.steps.map((step) => [step.stepKey, step.status])).toEqual([
        ['validate', 'completed'],
        ['render', 'queued'],
      ])
      expect((await workflows.advance(advanceRequest)).idempotent).toBe(true)

      const finalClaim = requireClaim(await workflows.claim({ workerId: 'worker-3', visibilityTimeoutSeconds: 30 }))
      const completeRequest = {
        ...attemptRequest(finalClaim),
        stepOutput: { artifactId: 'artifact-1' },
        runOutput: { artifactId: 'artifact-1' },
      }
      expect((await workflows.complete(completeRequest)).status).toBe('completed')
      expect((await workflows.complete(completeRequest)).idempotent).toBe(true)

      const firstPage = await workflows.events(firstRunId, { limit: 2 })
      const secondPage = await workflows.events(firstRunId, {
        afterEventId: String(firstPage.at(-1)?.eventId),
        limit: 20,
      })
      expect(firstPage).toHaveLength(2)
      expect(secondPage.length).toBeGreaterThan(0)
      expect(BigInt(String(secondPage[0]?.eventId))).toBeGreaterThan(BigInt(String(firstPage.at(-1)?.eventId)))

      await startSimpleRun(workflows, cancelledRunId, 2)
      expect((await workflows.cancel(cancelledRunId, 'operator request')).status).toBe('cancelled')
      expect((await workflows.cancel(cancelledRunId, 'operator request')).idempotent).toBe(true)

      await startSimpleRun(workflows, exhaustedRunId, 1)
      const exhaustedClaim = requireClaim(await workflows.claim({ workerId: 'worker-4', visibilityTimeoutSeconds: 30 }))
      const exhausted = await workflows.retry({
        ...attemptRequest(exhaustedClaim),
        errorMessage: 'still unavailable',
      })
      expect(exhausted).toMatchObject({ status: 'failed', idempotent: false })
      expect(exhausted.steps[0]).toMatchObject({ status: 'dead_lettered', attempts: 1 })
      expect((await workflows.retry({
        ...attemptRequest(exhaustedClaim),
        errorMessage: 'still unavailable',
      })).idempotent).toBe(true)
      await expect(workflows.retry({
        ...attemptRequest(exhaustedClaim),
        errorMessage: 'still unavailable',
        delaySeconds: 1,
      })).rejects.toMatchObject({ code: '23505' })

      await startSimpleRun(workflows, failedRunId, 2)
      const failedClaim = requireClaim(await workflows.claim({ workerId: 'worker-5', visibilityTimeoutSeconds: 30 }))
      const failedRequest = { ...attemptRequest(failedClaim), errorMessage: 'permanent failure' }
      expect((await workflows.fail(failedRequest)).status).toBe('failed')
      expect((await workflows.fail(failedRequest)).idempotent).toBe(true)

      await startSimpleRun(workflows, missingStepRunId, 2)
      await backend.db.query(`delete from supacloud_workflows.steps where run_id = $1`, [missingStepRunId])
      await expect(startSimpleRun(workflows, missingStepRunId, 2)).rejects.toMatchObject({ code: '23505' })
      expect(await workflows.claim({ workerId: 'worker-6', visibilityTimeoutSeconds: 30 })).toMatchObject({
        status: 'discarded',
        reason: 'orphaned_message',
      })

      await backend.db.query(
        `select pgmq.send('supacloud_internal_workflows', '{"run_id":"bad","step_id":"bad"}'::jsonb, 0)`,
      )
      expect(await workflows.claim({ workerId: 'worker-7', visibilityTimeoutSeconds: 30 })).toMatchObject({
        status: 'discarded',
        reason: 'invalid_message',
      })

      await backend.db.query(
        `select setval(pg_get_serial_sequence('pgmq.q_supacloud_internal_workflows', 'msg_id'), 9007199254740992)`,
      )
      await backend.db.query(
        `select setval(pg_get_serial_sequence('supacloud_workflows.events', 'id'), 9007199254740992)`,
      )
      const highMessageRun = await workflows.start({
        runId: highMessageRunId,
        workflowName: 'test.high-message-id',
        workflowVersion: '1',
        firstStepKey: 'work',
        input: { runId: highMessageRunId },
      })
      expect(highMessageRun.steps[0]?.queueMessageId).toBe('9007199254740993')
      expect(highMessageRun.rowVersion).toBe('1')
      const highMessageClaim = requireClaim(await workflows.claim({ workerId: 'worker-8', visibilityTimeoutSeconds: 30 }))
      expect(highMessageClaim.messageId).toBe('9007199254740993')
      await workflows.complete({
        ...attemptRequest(highMessageClaim),
        runOutput: { completed: true },
      })
      const highEventPage = await workflows.events(highMessageRunId, { limit: 1 })
      expect(highEventPage[0]?.eventId).toBe('9007199254740993')
      expect((await workflows.events(highMessageRunId, {
        afterEventId: String(highEventPage[0]?.eventId),
        limit: 10,
      })).length).toBeGreaterThan(0)

      await startSimpleRun(workflows, versionSevenRunId, 1)
      expect((await workflows.get(versionSevenRunId))?.runId).toBe(versionSevenRunId)
    } finally {
      await backend.close()
    }
  }, 30_000)
})

function supabaseClient(key: string, fetchImpl: typeof fetch, bearer = key): SupabaseClient {
  return createClient('http://local', key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: fetchImpl,
      headers: { authorization: `Bearer ${bearer}` },
    },
  })
}

function requireClaim(result: Record<string, unknown> | null): Record<string, unknown> {
  expect(result).toMatchObject({ status: 'claimed' })
  if (!result || result.status !== 'claimed') throw new Error('expected a claimed workflow step')
  return result
}

function attemptRequest(claim: Record<string, unknown>) {
  return {
    stepId: String(claim.stepId),
    messageId: String(claim.messageId),
    attempt: Number(claim.attempt),
    workerId: String(claim.workerId),
  }
}

async function startSimpleRun(workflows: ReturnType<typeof createSupaCloudClient>['workflows'], runId: string, maxAttempts: number) {
  await workflows.start({
    runId,
    workflowName: 'test.simple',
    workflowVersion: '1',
    firstStepKey: 'work',
    input: { runId },
    maxAttempts,
  })
}
