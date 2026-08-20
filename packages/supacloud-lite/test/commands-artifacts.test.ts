import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createSupaCloudClient } from './helpers/supacloud-js-source.js'
import { createLiteBackend, createNativeEngine, type SupaCloudLiteBackend } from '../src/index.js'

const config = {
  jwtSecret: 'x'.repeat(64),
  vaultKey: 'y'.repeat(64),
  log: () => {},
}
const nativeMode = process.env.SUPACLOUD_LITE_TEST_NATIVE === '1'

describe(`Transactional commands and artifact registry (${nativeMode ? 'native' : 'pglite'})`, () => {
  test('enforces service-role access, idempotency, durability, and immutability', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), `supacloud-lite-primitives-${nativeMode ? 'native' : 'pglite'}-`))
    const backend = await primitivesBackend(join(rootDir, 'database'))
    try {
      const anon = supabaseClient(backend.anonKey, backend.fetch)
      const serviceSupabase = supabaseClient(backend.serviceRoleKey, backend.fetch)
      const client = createSupaCloudClient({
        supabase: serviceSupabase,
        managementApiUrl: 'http://management-not-used',
        projectRef: 'lite',
      })
      const commandId = '11111111-1111-4111-8111-111111111111'

      const denied = await anon.rpc('supacloud_command_get', { request: { commandId } })
      expect(denied.data).toBeNull()
      expect(denied.error?.code).toBe('42501')

      const commandRequest = {
        commandId,
        commandType: 'report.issue',
        targetType: 'report',
        targetId: 'report-1',
        payload: { reportId: 'report-1' },
        maxAttempts: 2,
      }
      expect(await client.commands.submit(commandRequest)).toMatchObject({
        commandId,
        commandType: 'report.issue',
        idempotent: false,
        workflow: { status: 'queued' },
      })
      expect((await client.commands.submit(commandRequest)).idempotent).toBe(true)
      await expect(client.commands.submit({
        ...commandRequest,
        payload: { reportId: 'changed' },
      })).rejects.toMatchObject({ code: '23505' })

      const claim = await client.workflows.claim({ workerId: 'command-worker', visibilityTimeoutSeconds: 30 })
      expect(claim).toMatchObject({
        status: 'claimed',
        runId: commandId,
        workflowName: 'command.report.issue',
      })
      if (!claim || claim.status !== 'claimed') throw new Error('expected command workflow claim')
      await client.workflows.complete({
        stepId: claim.stepId,
        messageId: claim.messageId,
        attempt: claim.attempt,
        workerId: claim.workerId,
        runOutput: { reportVersion: 2 },
      })
      expect(await client.commands.get(commandId)).toMatchObject({
        commandId,
        workflow: { status: 'completed', output: { reportVersion: 2 } },
      })

      await backend.db.query(`insert into storage.buckets (id, name, public) values ('reports', 'reports', false)`)
      const objectIds = [
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
      ]
      await backend.db.query(
        `insert into storage.objects (id, bucket_id, name, version, metadata)
         values ($1, 'reports', 'source.pdf', 'v1', '{"size":100}'::jsonb),
                ($2, 'reports', 'derived.json', 'v1', '{"size":20}'::jsonb)`,
        objectIds,
      )
      const sourceArtifactId = '44444444-4444-4444-8444-444444444444'
      const derivedArtifactId = '55555555-5555-4555-8555-555555555555'
      const sourceRequest = {
        artifactId: sourceArtifactId,
        bucketId: 'reports',
        objectPath: 'source.pdf',
        artifactType: 'document.pdf',
        sha256: 'a'.repeat(64),
        sizeBytes: 100,
        mimeType: 'application/pdf',
      }
      expect(await client.artifacts.register(sourceRequest)).toMatchObject({
        artifactId: sourceArtifactId,
        objectVersion: 'v1',
        idempotent: false,
      })
      expect((await client.artifacts.register(sourceRequest)).idempotent).toBe(true)
      await expect(client.artifacts.register({ ...sourceRequest, sha256: 'b'.repeat(64) }))
        .rejects.toMatchObject({ code: '23505' })
      await client.artifacts.register({
        artifactId: derivedArtifactId,
        bucketId: 'reports',
        objectPath: 'derived.json',
        artifactType: 'ocr.result',
        sha256: 'c'.repeat(64),
        sizeBytes: 20,
        mimeType: 'application/json',
      })
      expect(await client.artifacts.link({
        parentArtifactId: sourceArtifactId,
        childArtifactId: derivedArtifactId,
        relationType: 'derived_from',
      })).toMatchObject({
        artifactId: derivedArtifactId,
        parents: [{ artifactId: sourceArtifactId, relationType: 'derived_from' }],
      })
      await expect(client.artifacts.link({
        parentArtifactId: derivedArtifactId,
        childArtifactId: sourceArtifactId,
        relationType: 'derived_from',
      })).rejects.toMatchObject({ code: '23514' })
      await expect(backend.db.query(
        `update storage.objects set name = 'changed.pdf' where id = $1`,
        [objectIds[0]],
      )).rejects.toThrow('SUPACLOUD_ARTIFACT_IMMUTABLE')
      await expect(backend.db.query(
        `delete from storage.objects where id = $1`,
        [objectIds[0]],
      )).rejects.toThrow('SUPACLOUD_ARTIFACT_IMMUTABLE')
    } finally {
      await backend.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  }, 180_000)
})

async function primitivesBackend(dataDir: string): Promise<SupaCloudLiteBackend> {
  if (!nativeMode) return createLiteBackend({ ...config, dataDir })
  return createLiteBackend({ ...config, engine: await createNativeEngine({ dataDir }) })
}

function supabaseClient(key: string, fetchImpl: typeof fetch): SupabaseClient {
  return createClient('http://local', key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchImpl, headers: { authorization: `Bearer ${key}` } },
  })
}
