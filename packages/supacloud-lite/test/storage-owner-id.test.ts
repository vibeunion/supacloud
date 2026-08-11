import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startProjectServer, type RunningProjectServer } from '../src/project-runtime.js'
import { signJwt } from '../src/runtime/jwt.js'

const bucketId = 'external-owners'
const externalSubject = 'external-user'
const ownerPolicyMigration = `
create policy external_owner_select on storage.objects
  for select to authenticated
  using (bucket_id = '${bucketId}' and owner_id = auth.jwt() ->> 'sub');

create policy external_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = '${bucketId}'
    and owner is null
    and owner_id = auth.jwt() ->> 'sub'
  );

create policy external_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = '${bucketId}' and owner_id = auth.jwt() ->> 'sub')
  with check (
    bucket_id = '${bucketId}'
    and owner is null
    and owner_id = auth.jwt() ->> 'sub'
  );
`

test('stores non-UUID subjects only in owner_id across Storage write paths', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-storage-owner-id-'))
  let project: RunningProjectServer | undefined

  try {
    await prepareProjectFiles(rootDir)
    project = await startProjectServer({ projectDir: rootDir, port: 0, log: () => {} })
    const token = await signJwt({ role: 'authenticated', sub: externalSubject }, project.backend.jwtSecret)
    await exerciseObjectWrites(project, token)
    await exerciseTusWrite(project, token)
    await expectStoredOwnership(project)
  } finally {
    await project?.close()
    await rm(rootDir, { recursive: true, force: true })
  }
}, 60_000)

async function prepareProjectFiles(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, 'supabase', 'migrations'), { recursive: true })
  await writeFile(
    join(rootDir, 'supabase', 'migrations', '20260811000000_external_owner.sql'),
    ownerPolicyMigration
  )
  await writeFile(
    join(rootDir, 'supabase', 'config.toml'),
    `[storage]\nfile_size_limit = "16B"\n\n[storage.buckets.${bucketId}]\npublic = false\nallowed_mime_types = ["text/plain"]\n`
  )
}

async function exerciseObjectWrites(project: RunningProjectServer, token: string): Promise<void> {
  const objectUrl = `${project.url}/storage/v1/object/${bucketId}/regular.txt`
  await expectStatus(await fetch(objectUrl, {
    method: 'POST',
    headers: storageHeaders(project, token),
    body: 'hello',
  }), 200)
  await expectStatus(await fetch(objectUrl, {
    method: 'POST',
    headers: { ...storageHeaders(project, token), 'x-upsert': 'true' },
    body: 'again',
  }), 200)
  await expectStatus(await fetch(`${project.url}/storage/v1/object/copy`, {
    method: 'POST',
    headers: { ...storageHeaders(project, token), 'content-type': 'application/json' },
    body: JSON.stringify({ bucketId, sourceKey: 'regular.txt', destinationKey: 'copied.txt' }),
  }), 200)
}

async function exerciseTusWrite(project: RunningProjectServer, token: string): Promise<void> {
  const created = await createTusUpload({ project, token, key: 'resumable.txt', length: 5 })
  await expectStatus(created, 201)
  const location = created.headers.get('location')
  expect(location).toBeString()
  await expectStatus(await fetch(location!, {
    method: 'PATCH',
    headers: {
      apikey: project.backend.anonKey,
      authorization: `Bearer ${token}`,
      'content-type': 'application/offset+octet-stream',
      'tus-resumable': '1.0.0',
      'upload-offset': '0',
    },
    body: 'hello',
  }), 204)
}

async function expectStoredOwnership(project: RunningProjectServer): Promise<void> {
  const stored = await project.backend.db.query<{ name: string; owner: string | null; owner_id: string }>(
    `select name, owner, owner_id from storage.objects where bucket_id = $1 order by name`,
    [bucketId]
  )
  expect(stored.rows).toEqual([
    { name: 'copied.txt', owner: null, owner_id: externalSubject },
    { name: 'regular.txt', owner: null, owner_id: externalSubject },
    { name: 'resumable.txt', owner: null, owner_id: externalSubject },
  ])
}

function storageHeaders(project: RunningProjectServer, token: string): Record<string, string> {
  return {
    apikey: project.backend.anonKey,
    authorization: `Bearer ${token}`,
    'content-type': 'text/plain',
  }
}

interface TusUploadRequest {
  project: RunningProjectServer
  token: string
  key: string
  length: number
}

function createTusUpload(request: TusUploadRequest): Promise<Response> {
  const metadata = [
    `bucketName ${btoa(bucketId)}`,
    `objectName ${btoa(request.key)}`,
    `contentType ${btoa('text/plain')}`,
  ].join(',')
  return fetch(`${request.project.url}/storage/v1/upload/resumable`, {
    method: 'POST',
    headers: {
      apikey: request.project.backend.anonKey,
      authorization: `Bearer ${request.token}`,
      'tus-resumable': '1.0.0',
      'upload-length': String(request.length),
      'upload-metadata': metadata,
    },
  })
}

async function expectStatus(response: Response, expectedStatus: number): Promise<void> {
  const failureBody = response.status === expectedStatus ? '' : await response.text()
  expect(response.status, failureBody).toBe(expectedStatus)
}
