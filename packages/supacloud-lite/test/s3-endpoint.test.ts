import { describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { createLiteBackend } from '../src/index.js'
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
  const payloadHash = sha256(body)
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
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      buckets: [{ id: bucket, public: false, fileSizeLimit: null, allowedMimeTypes: null }],
      s3Endpoint: { accessKeyId, secretAccessKey, region },
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

      const listing = await request(backend, 'GET', `/${bucket}?list-type=2`)
      expect(listing.status).toBe(200)
      expect(await listing.text()).toContain('<Key>hello.txt</Key>')

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
      const complete = await request(
        backend,
        'POST',
        `/${bucket}/large.txt?uploadId=${uploadId}`,
        `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"${etag}"</ETag></Part></CompleteMultipartUpload>`,
      )
      expect(complete.status).toBe(200)
      expect(await (await request(backend, 'GET', `/${bucket}/large.txt`)).text()).toBe('multipart ')

      const deleted = await request(backend, 'POST', `/${bucket}?delete`, `<Delete><Object><Key>hello.txt</Key></Object><Object><Key>copy.txt</Key></Object></Delete>`)
      expect(deleted.status).toBe(200)
      expect(await deleted.text()).toContain('<Deleted><Key>hello.txt</Key></Deleted>')
      expect((await request(backend, 'GET', `/${bucket}/hello.txt`)).status).toBe(404)
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
