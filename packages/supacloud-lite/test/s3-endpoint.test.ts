import { describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { createLiteBackend, MemoryStorageDriver, serveBun } from '../src/index.js'
import { testTimeout } from './helpers/timeouts.js'

const accessKeyId = 'lite-s3-access'
const secretAccessKey = 'lite-s3-secret-value'
const region = 'us-east-1'
const bucket = 's3-bucket'

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function canonicalUri(pathname: string): string {
  return pathname.split('/').map((part) => encode(decodeURIComponent(part))).join('/')
}

function canonicalQuery(url: URL, exclude: Set<string>): string {
  return [...url.searchParams.entries()]
    .filter(([key]) => !exclude.has(key))
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort((a, b) => a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
}

function signingKey(date: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), 's3'), 'aws4_request')
}

function authorization(method: string, url: URL, body: Uint8Array, extra: Record<string, string> = {}): Headers {
  const date = new Date()
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = extra['x-amz-content-sha256'] ?? sha256(body)
  const headers = new Headers({ host: 'local', 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, ...extra })
  const names = [...headers.keys()].sort()
  const canonicalHeaders = names.map((name) => `${name}:${(headers.get(name) ?? '').trim().replace(/\s+/g, ' ')}\n`).join('')
  const canonicalRequest = [
    method, canonicalUri(url.pathname), canonicalQuery(url, new Set()), canonicalHeaders, names.join(';'), payloadHash,
  ].join('\n')
  const scope = `${dateStamp}/${region}/s3/aws4_request`
  const signature = hmac(signingKey(dateStamp), `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`).toString('hex')
  headers.set('authorization', `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`)
  return headers
}

function presignedUrl(path: string): string {
  const date = new Date()
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const dateStamp = amzDate.slice(0, 8)
  const url = new URL(`http://local/storage/v1/s3${path}`)
  const scope = `${dateStamp}/${region}/s3/aws4_request`
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
  url.searchParams.set('X-Amz-Credential', `${accessKeyId}/${scope}`)
  url.searchParams.set('X-Amz-Date', amzDate)
  url.searchParams.set('X-Amz-Expires', '60')
  url.searchParams.set('X-Amz-SignedHeaders', 'host')
  const canonicalRequest = [
    'GET', canonicalUri(url.pathname), canonicalQuery(url, new Set()),
    `host:local\n`, 'host', 'UNSIGNED-PAYLOAD',
  ].join('\n')
  const signature = hmac(signingKey(dateStamp), `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`).toString('hex')
  url.searchParams.set('X-Amz-Signature', signature)
  return url.toString()
}

async function request(backend: Awaited<ReturnType<typeof createLiteBackend>>, method: string, path: string, body = '', headers: Record<string, string> = {}) {
  const url = new URL(`http://local/storage/v1/s3${path}`)
  const bytes = body === '' ? new Uint8Array() : new TextEncoder().encode(body)
  return backend.fetch(url, { method, headers: authorization(method, url, bytes, headers), body: method === 'GET' || method === 'HEAD' ? undefined : bytes })
}

describe('S3-compatible endpoint', () => {
  test('supports signed bucket/object operations, presigned GET, range, copy, multipart and delete', async () => {
    const driver = new RecordingStorageDriver()
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      buckets: [{ id: bucket, public: false, fileSizeLimit: null, allowedMimeTypes: null }],
      s3Endpoint: { accessKeyId, secretAccessKey, region },
      storageDriver: driver,
      log: () => {},
    })
    try {
      const list = await request(backend, 'GET', '')
      expect(list.status).toBe(200)
      expect(await list.text()).toContain(`<Name>${bucket}</Name>`)

      const put = await request(backend, 'PUT', `/${bucket}/hello.txt`, 'hello world', { 'content-type': 'text/plain' })
      expect(put.status).toBe(200)
      const get = await request(backend, 'GET', `/${bucket}/hello.txt`)
      expect(get.status).toBe(200)
      expect(await get.text()).toBe('hello world')

      const storageRead = await backend.fetch(`http://local/storage/v1/object/authenticated/${bucket}/hello.txt`, {
        headers: { apikey: backend.serviceRoleKey, authorization: `Bearer ${backend.serviceRoleKey}` },
      })
      expect(storageRead.status).toBe(200)
      expect(await storageRead.text()).toBe('hello world')

      const range = await backend.fetch(`http://local/storage/v1/s3/${bucket}/hello.txt`, {
        headers: { ...Object.fromEntries(authorization('GET', new URL(`http://local/storage/v1/s3/${bucket}/hello.txt`), new Uint8Array()).entries()), range: 'bytes=6-10' },
      })
      expect(range.status).toBe(206)
      expect(await range.text()).toBe('world')
      const suffix = await request(backend, 'GET', `/${bucket}/hello.txt`, '', { range: 'bytes=-5' })
      expect(suffix.status).toBe(206)
      expect(suffix.headers.get('content-range')).toBe('bytes 6-10/11')
      expect(await suffix.text()).toBe('world')
      for (const [header, text, contentRange] of [
        ['bytes=0-0', 'h', 'bytes 0-0/11'],
        ['bytes=6-', 'world', 'bytes 6-10/11'],
        ['bytes=-100', 'hello world', 'bytes 0-10/11'],
        ['bytes=6-100', 'world', 'bytes 6-10/11'],
      ]) {
        const response = await request(backend, 'GET', `/${bucket}/hello.txt`, '', { range: header! })
        expect(response.status).toBe(206)
        expect(response.headers.get('content-range')).toBe(contentRange!)
        expect(await response.text()).toBe(text!)
      }
      for (const invalid of ['bytes=-', 'bytes=-0', 'bytes=11-', 'bytes=3-1', 'bytes=0-1,3-4', 'bytes=9007199254740992-']) {
        expect((await request(backend, 'GET', `/${bucket}/hello.txt`, '', { range: invalid })).status).toBe(416)
      }
      expect((await request(backend, 'PUT', `/${bucket}/empty`)).status).toBe(200)
      expect((await request(backend, 'GET', `/${bucket}/empty`, '', { range: 'bytes=0-' })).status).toBe(416)

      const listing = await request(backend, 'GET', `/${bucket}?list-type=2`)
      expect(listing.status).toBe(200)
      expect(await listing.text()).toContain('<Key>hello.txt</Key>')
      expect((await request(backend, 'PUT', `/${bucket}/literal%25key`, 'literal')).status).toBe(200)
      expect((await request(backend, 'PUT', `/${bucket}/literalXkey`, 'other')).status).toBe(200)
      const literalPrefix = await request(backend, 'GET', `/${bucket}?list-type=2&prefix=literal%25`)
      const prefixXml = await literalPrefix.text()
      expect(prefixXml).toContain('<Key>literal%key</Key>')
      expect(prefixXml).not.toContain('literalXkey')
      for (const key of ['%2E%2E%2Foutside', 'back%5Cslash', 'nul%00key', 'x'.repeat(1025)]) {
        expect((await request(backend, 'PUT', `/${bucket}/${key}`, 'blocked')).status).toBe(400)
      }

      const copy = await request(backend, 'PUT', `/${bucket}/copy.txt`, '', { 'x-amz-copy-source': `/${bucket}/hello.txt` })
      expect(copy.status).toBe(200)
      expect(await (await request(backend, 'GET', `/${bucket}/copy.txt`)).text()).toBe('hello world')

      const presigned = await backend.fetch(presignedUrl(`/${bucket}/hello.txt`))
      expect(presigned.status).toBe(200)
      expect(await presigned.text()).toBe('hello world')

      const create = await request(backend, 'POST', `/${bucket}/large.txt?uploads`)
      expect(create.status).toBe(200)
      const uploadId = (await create.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1]
      expect(uploadId).toBeString()
      const part = await request(backend, 'PUT', `/${bucket}/large.txt?partNumber=1&uploadId=${uploadId}`, 'multipart ')
      expect(part.status).toBe(200)
      const etag = part.headers.get('etag')!.replaceAll('"', '')
      const second = await request(backend, 'PUT', `/${bucket}/large.txt?partNumber=2&uploadId=${uploadId}`, 'unused')
      expect(second.status).toBe(200)
      const secondEtag = second.headers.get('etag')!
      const beforeInvalid = driver.reads
      for (const invalid of [
        '',
        '<CompleteMultipartUpload/>',
        '<CompleteMultipartUpload><Part></Part></CompleteMultipartUpload>',
        `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><PartNumber>2</PartNumber><ETag>"${etag}"</ETag></Part></CompleteMultipartUpload>`,
        `<CompleteMultipartUpload><Part><PartNumber>2</PartNumber><ETag>${secondEtag}</ETag></Part><Part><PartNumber>1</PartNumber><ETag>"${etag}"</ETag></Part></CompleteMultipartUpload>`,
      ]) {
        expect((await request(backend, 'POST', `/${bucket}/large.txt?uploadId=${uploadId}`, invalid)).status).toBe(400)
      }
      const duplicate = await request(
        backend,
        'POST',
        `/${bucket}/large.txt?uploadId=${uploadId}`,
        `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"${etag}"</ETag></Part><Part><PartNumber>1</PartNumber><ETag>"${etag}"</ETag></Part></CompleteMultipartUpload>`,
      )
      expect(duplicate.status).toBe(400)
      expect(driver.reads).toBe(beforeInvalid)
      await backend.db.query('update storage.s3_multipart_parts set size = $1 where upload_id = $2 and part_number = 1', [64 * 1024 * 1024 + 1, uploadId])
      const oversized = await request(backend, 'POST', `/${bucket}/large.txt?uploadId=${uploadId}`, `<CompleteMultipartUpload><Part><ETag>"${etag}"</ETag><PartNumber>1</PartNumber></Part></CompleteMultipartUpload>`)
      expect(oversized.status).toBe(413)
      expect(driver.reads).toBe(beforeInvalid)
      await backend.db.query('update storage.s3_multipart_parts set size = $1 where upload_id = $2 and part_number = 1', [10, uploadId])
      const complete = await request(
        backend,
        'POST',
        `/${bucket}/large.txt?uploadId=${uploadId}`,
        `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Part><ETag>&quot;${etag}&quot;</ETag><PartNumber>1</PartNumber></Part></CompleteMultipartUpload>`,
      )
      expect(complete.status).toBe(200)
      expect(await (await request(backend, 'GET', `/${bucket}/large.txt`)).text()).toBe('multipart ')

      const scoped = await request(backend, 'POST', `/${bucket}/scoped.txt?uploads`)
      const scopedUploadId = (await scoped.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1]
      expect(scopedUploadId).toBeString()
      const wrongKeyAbort = await request(backend, 'DELETE', `/${bucket}/other.txt?uploadId=${scopedUploadId}`)
      expect(wrongKeyAbort.status).toBe(404)
      const abort = await request(backend, 'DELETE', `/${bucket}/scoped.txt?uploadId=${scopedUploadId}`)
      expect(abort.status).toBe(204)

      const deleted = await request(backend, 'POST', `/${bucket}?delete`, `<Delete><Object><Key>hello.txt</Key></Object><Object><Key>copy.txt</Key></Object></Delete>`)
      expect(deleted.status).toBe(200)
      expect(await deleted.text()).toContain('<Deleted><Key>hello.txt</Key></Deleted>')
      expect((await request(backend, 'GET', `/${bucket}/hello.txt`)).status).toBe(404)
    } finally {
      await backend.close()
    }
  }, testTimeout(30_000))

  test('enforces bucket size and content-type policies on S3 writes', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      buckets: [{ id: bucket, public: false, fileSizeLimit: 5, allowedMimeTypes: ['text/plain'] }],
      s3Endpoint: { accessKeyId, secretAccessKey, region },
      log: () => {},
    })
    try {
      const tooLarge = await request(backend, 'PUT', `/${bucket}/large.txt`, '123456', { 'content-type': 'text/plain' })
      expect(tooLarge.status).toBe(413)
      const wrongType = await request(backend, 'PUT', `/${bucket}/json.txt`, '{}', { 'content-type': 'application/json' })
      expect(wrongType.status).toBe(415)
      expect((await request(backend, 'PUT', '/source-bucket')).status).toBe(200)
      expect((await request(backend, 'PUT', '/source-bucket/plain', '123456', { 'content-type': 'text/plain' })).status).toBe(200)
      expect((await request(backend, 'PUT', `/${bucket}/copy`, '', { 'x-amz-copy-source': '/source-bucket/plain' })).status).toBe(413)
      expect((await request(backend, 'PUT', '/source-bucket/json', '{}', { 'content-type': 'application/json' })).status).toBe(200)
      expect((await request(backend, 'PUT', `/${bucket}/copy`, '', { 'x-amz-copy-source': '/source-bucket/json' })).status).toBe(415)
      expect((await request(backend, 'PUT', `/${bucket}/copy`, '', { 'x-amz-copy-source': '/source-bucket/json', 'x-amz-metadata-directive': 'REPLACE', 'content-type': 'text/plain' })).status).toBe(200)
      expect((await request(backend, 'POST', `/${bucket}/multipart?uploads`, '', { 'content-type': 'application/json' })).status).toBe(415)
      const created = await request(backend, 'POST', `/${bucket}/multipart?uploads`, '', { 'content-type': 'text/plain' })
      expect(created.status).toBe(200)
      const uploadId = (await created.text()).match(/<UploadId>([^<]+)<\/UploadId>/)![1]
      const first = await request(backend, 'PUT', `/${bucket}/multipart?partNumber=1&uploadId=${uploadId}`, '123')
      expect(first.status).toBe(200)
      expect((await request(backend, 'PUT', `/${bucket}/multipart?partNumber=2&uploadId=${uploadId}`, '456')).status).toBe(413)
      await backend.db.query('update storage.buckets set file_size_limit = 2 where id = $1', [bucket])
      const xml = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${first.headers.get('etag')}</ETag></Part></CompleteMultipartUpload>`
      expect((await request(backend, 'POST', `/${bucket}/multipart?uploadId=${uploadId}`, xml)).status).toBe(413)
      await backend.db.query("update storage.buckets set file_size_limit = 5, allowed_mime_types = ARRAY['application/json'] where id = $1", [bucket])
      expect((await request(backend, 'POST', `/${bucket}/multipart?uploadId=${uploadId}`, xml)).status).toBe(415)
    } finally {
      await backend.close()
    }
  }, testTimeout(30_000))

  test('does not abort a multipart upload through another bucket or key', async () => {
    const driver = new MemoryStorageDriver()
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), storageDriver: driver,
      buckets: [{ id: bucket, public: false, fileSizeLimit: null, allowedMimeTypes: null }],
      s3Endpoint: { accessKeyId, secretAccessKey, region, bucketScope: [bucket] }, log: () => {},
    })
    try {
      const uploadId = 'cross-scope-upload'
      const driverKey = `s3-multipart/${uploadId}/1`
      await driver.put(driverKey, new TextEncoder().encode('kept'))
      await backend.db.query('insert into storage.s3_multipart_uploads (upload_id, bucket_id, name) values ($1, $2, $3)', [uploadId, 'outside-bucket', 'original.txt'])
      await backend.db.query('insert into storage.s3_multipart_parts (upload_id, part_number, etag, size, driver_key) values ($1, 1, $2, 4, $3)', [uploadId, sha256('kept'), driverKey])
      expect((await request(backend, 'DELETE', `/${bucket}/other.txt?uploadId=${uploadId}`)).status).toBe(404)
      expect((await request(backend, 'DELETE', `/outside-bucket/original.txt?uploadId=${uploadId}`)).status).toBe(403)
      expect((await backend.db.query('select 1 from storage.s3_multipart_uploads where upload_id = $1', [uploadId])).rows.length).toBe(1)
      expect(new TextDecoder().decode((await driver.get(driverKey))!)).toBe('kept')
    } finally {
      await backend.close()
    }
  }, testTimeout(30_000))

  test('authenticates before reading and cancels chunked bodies above the byte limit', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64),
      s3Endpoint: { accessKeyId, secretAccessKey, region }, log: () => {},
    })
    try {
      let unsignedReads = 0
      const unsigned = new ReadableStream<Uint8Array>({ pull() { unsignedReads += 1 } }, { highWaterMark: 0 })
      const unsignedResponse = await backend.fetch(`http://local/storage/v1/s3/${bucket}/object`, { method: 'PUT', body: unsigned })
      expect(unsignedResponse.status).toBe(401)
      expect(unsignedReads).toBe(0)
      await unsigned.cancel()

      const url = new URL(`http://local/storage/v1/s3/${bucket}/object`)
      const headers = authorization('PUT', url, new Uint8Array(), { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' })
      let reads = 0
      let cancelled = false
      const chunk = new Uint8Array(1024 * 1024)
      const chunked = new ReadableStream<Uint8Array>({
        pull(controller) { reads += 1; controller.enqueue(chunk) },
        cancel() { cancelled = true },
      }, { highWaterMark: 0 })
      const oversized = await backend.fetch(url, { method: 'PUT', headers, body: chunked })
      expect(oversized.status).toBe(413)
      expect(reads).toBe(65)
      expect(cancelled).toBe(true)
      let earlyCancelled = false
      const declared = new ReadableStream<Uint8Array>({ cancel() { earlyCancelled = true } }, { highWaterMark: 0 })
      const declaredResponse = await backend.fetch(url, {
        method: 'PUT',
        headers: authorization('PUT', url, new Uint8Array(), { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-length': String(64 * 1024 * 1024 + 1) }),
        body: declared,
      })
      expect(declaredResponse.status).toBe(413)
      expect(earlyCancelled).toBe(true)
    } finally {
      await backend.close()
    }
  }, testTimeout(30_000))

  test('bounds staging quotas, reclaims expiry and removes failed writes', async () => {
    const driver = new RecordingStorageDriver()
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), storageDriver: driver,
      buckets: [{ id: bucket, public: false, fileSizeLimit: null, allowedMimeTypes: null }],
      s3Endpoint: { accessKeyId, secretAccessKey, region }, log: () => {},
    })
    try {
      const created = await request(backend, 'POST', `/${bucket}/staged?uploads`)
      expect(created.status).toBe(200)
      const uploadId = (await created.text()).match(/<UploadId>([^<]+)<\/UploadId>/)![1]!
      const partPath = `/${bucket}/staged?partNumber=1&uploadId=${uploadId}`
      driver.failAfterPut = true
      expect((await request(backend, 'PUT', partPath, 'failed')).status).toBe(500)
      expect(await driver.get(driver.lastPut!)).toBeNull()
      expect((await backend.db.query('select 1 from storage.s3_multipart_parts')).rows).toHaveLength(0)
      await backend.db.exec(`
        create function storage.fail_s3_part() returns trigger language plpgsql as $$
        begin raise exception 'synthetic part metadata failure'; end $$;
        create trigger fail_s3_part before insert on storage.s3_multipart_parts for each row execute function storage.fail_s3_part();
      `)
      expect((await request(backend, 'PUT', partPath, 'failed')).status).toBe(500)
      expect(await driver.get(driver.lastPut!)).toBeNull()
      await backend.db.exec('drop trigger fail_s3_part on storage.s3_multipart_parts')
      expect((await request(backend, 'PUT', partPath, 'kept')).status).toBe(200)
      const oldKey = driver.lastPut!
      expect((await request(backend, 'PUT', partPath, 'replaced')).status).toBe(200)
      expect(await driver.get(oldKey)).toBeNull()

      await backend.db.query(
        `insert into storage.s3_multipart_uploads (upload_id, bucket_id, name)
         select 'quota-' || n, $1, 'quota' from generate_series(1, 127) n`,
        [bucket],
      )
      expect((await request(backend, 'POST', `/${bucket}/overflow?uploads`)).status).toBe(503)
      const stagedKey = driver.lastPut!
      await backend.db.exec("update storage.s3_multipart_uploads set created_at = now() - interval '25 hours'")
      const afterExpiry = await request(backend, 'POST', `/${bucket}/fresh?uploads`)
      expect(afterExpiry.status).toBe(200)
      expect(await driver.get(stagedKey)).toBeNull()
      expect((await backend.db.query('select 1 from storage.s3_multipart_uploads')).rows).toHaveLength(1)
      const freshId = (await afterExpiry.text()).match(/<UploadId>([^<]+)<\/UploadId>/)![1]!
      await backend.db.query(
        `insert into storage.s3_multipart_parts (upload_id, part_number, etag, size, driver_key)
         select $1, n, 'quota', 0, 'quota/' || n from generate_series(1, 10000) n`,
        [freshId],
      )
      const another = await request(backend, 'POST', `/${bucket}/another?uploads`)
      const anotherId = (await another.text()).match(/<UploadId>([^<]+)<\/UploadId>/)![1]!
      expect((await request(backend, 'PUT', `/${bucket}/another?uploadId=${anotherId}&partNumber=1`, 'new')).status).toBe(503)
      await backend.db.query('delete from storage.s3_multipart_parts where upload_id = $1 and part_number > 1', [freshId])
      await backend.db.query('update storage.s3_multipart_parts set size = $1 where upload_id = $2', [256 * 1024 * 1024, freshId])
      expect((await request(backend, 'PUT', `/${bucket}/another?uploadId=${anotherId}&partNumber=1`, 'new')).status).toBe(503)
      expect((await request(backend, 'DELETE', `/${bucket}`)).status).toBe(204)
      expect((await backend.db.query('select 1 from storage.s3_multipart_uploads')).rows).toHaveLength(0)
      expect((await backend.db.query('select 1 from storage.s3_multipart_parts')).rows).toHaveLength(0)
    } finally {
      await backend.close()
    }
  }, testTimeout(30_000))

  test('returns oversized HTTP responses without waiting for wrapped-body cancellation', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64),
      s3Endpoint: { accessKeyId, secretAccessKey, region }, log: () => {},
    })
    const server = await serveBun(backend, { port: 0 })
    const path = `/storage/v1/s3/${bucket}/object?uploadId=missing`
    try {
      const oversized = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: authorization('POST', new URL(`http://local${path}`), new Uint8Array(), {
          'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        }),
        body: new Uint8Array(2 * 1024 * 1024 + 1),
        signal: AbortSignal.timeout(5000),
      })
      expect(oversized.status).toBe(413)
      expect(await oversized.text()).toContain('EntityTooLarge')
      const listing = await fetch(`${server.url}/storage/v1/s3`, {
        headers: authorization('GET', new URL('http://local/storage/v1/s3'), new Uint8Array()),
        signal: AbortSignal.timeout(5000),
      })
      expect(listing.status).toBe(200)
    } finally {
      await server.close()
      await backend.close()
    }
  }, testTimeout(30_000))

  test('keeps staged bytes when multipart metadata deletion rolls back', async () => {
    const driver = new MemoryStorageDriver()
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), storageDriver: driver,
      buckets: [{ id: bucket, public: false, fileSizeLimit: null, allowedMimeTypes: null }],
      s3Endpoint: { accessKeyId, secretAccessKey, region }, log: () => {},
    })
    try {
      const created = await request(backend, 'POST', `/${bucket}/rollback?uploads`)
      const uploadId = (await created.text()).match(/<UploadId>([^<]+)<\/UploadId>/)![1]!
      const part = await request(backend, 'PUT', `/${bucket}/rollback?partNumber=1&uploadId=${uploadId}`, 'kept')
      expect(part.status).toBe(200)
      const stagedKey = (await backend.db.query<{ driver_key: string }>(
        'select driver_key from storage.s3_multipart_parts where upload_id = $1',
        [uploadId],
      )).rows[0]!.driver_key
      await backend.db.exec(`
        create function storage.fail_s3_upload_delete() returns trigger language plpgsql as $$
        begin raise exception 'synthetic upload delete failure'; end $$;
        create trigger fail_s3_upload_delete before delete on storage.s3_multipart_uploads
          for each row execute function storage.fail_s3_upload_delete();
      `)
      expect((await request(backend, 'DELETE', `/${bucket}/rollback?uploadId=${uploadId}`)).status).toBe(500)
      expect((await request(backend, 'DELETE', `/${bucket}`)).status).toBe(500)
      await backend.db.exec("update storage.s3_multipart_uploads set created_at = now() - interval '25 hours'")
      expect((await request(backend, 'POST', `/${bucket}/fresh?uploads`)).status).toBe(500)
      expect(await driver.get(stagedKey)).not.toBeNull()
      expect((await backend.db.query(
        'select 1 from storage.s3_multipart_parts where upload_id = $1', [uploadId],
      )).rows).toHaveLength(1)
      await backend.db.exec('drop trigger fail_s3_upload_delete on storage.s3_multipart_uploads')
      await backend.db.exec('update storage.s3_multipart_uploads set created_at = now()')
      expect((await request(backend, 'DELETE', `/${bucket}/rollback?uploadId=${uploadId}`)).status).toBe(204)
      expect(await driver.get(stagedKey)).toBeNull()
    } finally {
      await backend.close()
    }
  }, testTimeout(30_000))

  test('rejects unsigned and incorrectly signed requests', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      s3Endpoint: { accessKeyId, secretAccessKey, region },
      log: () => {},
    })
    try {
      const unsigned = await backend.fetch(`http://local/storage/v1/s3/${bucket}/hello.txt`)
      expect(unsigned.status).toBe(401)
      const url = new URL(`http://local/storage/v1/s3/${bucket}/hello.txt`)
      const headers = authorization('PUT', url, new TextEncoder().encode('payload'))
      headers.set('authorization', headers.get('authorization')!.replace(/Signature=[0-9a-f]+/, 'Signature=deadbeef'))
      const bad = await backend.fetch(url, { method: 'PUT', headers, body: 'payload' })
      expect(bad.status).toBe(403)
    } finally {
      await backend.close()
    }
  }, testTimeout(30_000))
})

class RecordingStorageDriver extends MemoryStorageDriver {
  reads = 0
  failAfterPut = false
  lastPut: string | undefined
  override async put(key: string, bytes: Uint8Array): Promise<void> {
    this.lastPut = key
    await super.put(key, bytes)
    if (this.failAfterPut) {
      this.failAfterPut = false
      throw new Error('synthetic staged write failure')
    }
  }
  override async get(key: string): Promise<Uint8Array | null> {
    this.reads += 1
    return super.get(key)
  }
}
