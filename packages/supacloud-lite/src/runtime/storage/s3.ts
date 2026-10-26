/**
 * Inbound S3-compatible API (`/storage/v1/s3`) for Lite.
 *
 * This is a protocol adapter, not the outbound S3StorageDriver: AWS SDKs sign
 * requests with SigV4 and expect XML responses, while Lite's normal Storage API
 * uses JWT/apikey and JSON. Both share storage.buckets, storage.objects and the
 * configured StorageDriver for bytes.
 */
import type { Database, Querier } from '../db/database.js'
import { Mutex } from '../db/engine.js'
import type { StorageDriver } from '../types.js'
import { invalidMimeType, invalidObjectKey, readLimitedBody } from './handler.js'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

export interface S3EndpointOptions {
  accessKeyId: string
  secretAccessKey: string
  /** SigV4 region expected in credentials. Default: us-east-1. */
  region?: string
  /** Optional bucket allowlist; empty means every bucket in this project. */
  bucketScope?: string[]
}

export interface S3RequestCredentials {
  accessKeyId: string
  secretAccessKey: string
  region: string
  bucketScope: string[]
}

const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60
const MAX_OBJECT_BYTES = 64 * 1024 * 1024
const MAX_XML_BYTES = 2 * 1024 * 1024
const MAX_ACTIVE_UPLOADS = 128
const MAX_STAGED_PARTS = 10000
const MAX_STAGED_BYTES = 4 * MAX_OBJECT_BYTES

class S3Error extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

interface S3ObjectRow {
  id: string
  bucket_id: string
  name: string
  owner: string | null
  owner_id: string | null
  version: string | null
  metadata: Record<string, unknown> | null
  created_at: Date | string | null
  updated_at: Date | string | null
  last_accessed_at: Date | string | null
}

interface S3BucketRow {
  id: string
  name: string
  created_at: Date | string | null
  file_size_limit: number | string | null
  allowed_mime_types: string[] | null
}

interface MultipartPart {
  part_number: number
  etag: string
  size: number | string
  driver_key: string
}

const encoder = new TextEncoder()

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function xml(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8', ...headers },
  })
}

function xmlError(error: S3Error, requestId: string): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Error><Code>${xmlEscape(error.code)}</Code><Message>${xmlEscape(error.message)}</Message>` +
    `<RequestId>${xmlEscape(requestId)}</RequestId></Error>`
  return xml(error.status, body)
}

function s3Error(status: number, code: string, message: string): never {
  throw new S3Error(status, code, message)
}

function iso(value: Date | string | null): string {
  return value instanceof Date ? value.toISOString() : new Date(value ?? Date.now()).toISOString()
}

function headerDate(value: Date | string | null): string {
  return new Date(value ?? Date.now()).toUTCString()
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return toHex(new Uint8Array(digest))
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)))
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function canonicalUri(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join('/')
}

function canonicalQuery(url: URL, excluded: Set<string>): string {
  const entries = [...url.searchParams.entries()]
    .filter(([key]) => !excluded.has(key))
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort((a, b) => a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))
  return entries.map(([key, value]) => `${key}=${value}`).join('&')
}

function canonicalHeaders(headers: Headers, names: string[]): string {
  return names
    .map((name) => `${name}:${(headers.get(name) ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('')
}

async function signingKey(secret: string, date: string, region: string): Promise<Uint8Array> {
  const dateKey = await hmac(encoder.encode(`AWS4${secret}`), date)
  const regionKey = await hmac(dateKey, region)
  const serviceKey = await hmac(regionKey, 's3')
  return hmac(serviceKey, 'aws4_request')
}

function parseCredential(value: string): { accessKeyId: string; date: string; region: string; service: string } | null {
  const parts = value.split('/')
  if (parts.length !== 5 || parts[4] !== 'aws4_request') return null
  const [accessKeyId, date, region, service] = parts
  return accessKeyId && date && region && service ? { accessKeyId, date, region, service } : null
}

/**
 * Verify header or query-string SigV4. Rejects streaming/trailer payloads
 * explicitly so a partial implementation never silently accepts a signature
 * that covers bytes the server did not verify.
 */
export async function verifyS3Signature(
  req: Request,
  url: URL,
  body: Uint8Array,
  config: S3RequestCredentials,
): Promise<void> {
  const payloadHash = await verifyS3Request(req, url, config)
  await verifyS3Payload(body, payloadHash)
}

async function verifyS3Payload(body: Uint8Array, payloadHash: string): Promise<void> {
  if (payloadHash === 'UNSIGNED-PAYLOAD') return
  const actual = await sha256Hex(body)
  if (!constantTimeEqual(actual, payloadHash.toLowerCase())) {
    s3Error(400, 'XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 does not match the request body')
  }
}

async function verifyS3Request(req: Request, url: URL, config: S3RequestCredentials): Promise<string> {
  const authorization = req.headers.get('authorization')
  const presignedAlgorithm = url.searchParams.get('X-Amz-Algorithm')
  let accessKeyId: string
  let credentialDate: string
  let credentialRegion: string
  let signedHeaders: string[]
  let signature: string
  let amzDate: string
  let payloadHash: string
  let presigned = false

  if (authorization) {
    const match = authorization.match(/^AWS4-HMAC-SHA256\s+Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)$/i)
    if (!match) s3Error(400, 'AuthorizationHeaderMalformed', 'The authorization header is malformed')
    const credential = parseCredential(match[1]!)
    if (!credential) s3Error(400, 'AuthorizationHeaderMalformed', 'The credential scope is malformed')
    accessKeyId = credential.accessKeyId
    credentialDate = credential.date
    credentialRegion = credential.region
    if (credential.service !== 's3') s3Error(400, 'AuthorizationHeaderMalformed', 'The credential service must be s3')
    signedHeaders = match[2]!.toLowerCase().split(';')
    signature = match[3]!.toLowerCase()
    amzDate = req.headers.get('x-amz-date') ?? ''
    payloadHash = req.headers.get('x-amz-content-sha256') ?? ''
    if (!amzDate) s3Error(400, 'AccessDenied', 'x-amz-date is required')
    if (!payloadHash) s3Error(400, 'InvalidRequest', 'x-amz-content-sha256 is required')
  } else if (presignedAlgorithm) {
    if (presignedAlgorithm !== 'AWS4-HMAC-SHA256') s3Error(400, 'AuthorizationQueryParametersError', 'Unsupported signature algorithm')
    const credentialValue = url.searchParams.get('X-Amz-Credential')
    const credential = credentialValue ? parseCredential(credentialValue) : null
    if (!credential) s3Error(400, 'AuthorizationQueryParametersError', 'X-Amz-Credential is malformed')
    accessKeyId = credential.accessKeyId
    credentialDate = credential.date
    credentialRegion = credential.region
    if (credential.service !== 's3') s3Error(400, 'AuthorizationQueryParametersError', 'The credential service must be s3')
    signedHeaders = (url.searchParams.get('X-Amz-SignedHeaders') ?? 'host').toLowerCase().split(';')
    signature = (url.searchParams.get('X-Amz-Signature') ?? '').toLowerCase()
    amzDate = url.searchParams.get('X-Amz-Date') ?? ''
    payloadHash = url.searchParams.get('X-Amz-Content-Sha256') ?? 'UNSIGNED-PAYLOAD'
    const expires = Number(url.searchParams.get('X-Amz-Expires'))
    if (!signature || !amzDate) s3Error(400, 'AuthorizationQueryParametersError', 'X-Amz-Signature and X-Amz-Date are required')
    if (!Number.isInteger(expires) || expires < 0 || expires > MAX_PRESIGN_SECONDS) {
      s3Error(400, 'AuthorizationQueryParametersError', 'X-Amz-Expires is invalid')
    }
    presigned = true
  } else {
    s3Error(401, 'AccessDenied', 'Missing AWS Signature Version 4 authorization')
  }

  if (!constantTimeEqual(accessKeyId, config.accessKeyId)) {
    s3Error(403, 'InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.')
  }
  const expectedRegion = config.region || 'us-east-1'
  if (credentialRegion !== expectedRegion) {
    s3Error(400, 'AuthorizationHeaderMalformed', `The authorization header is malformed; the region is wrong; expecting ${expectedRegion}`)
  }

  const dateMatch = amzDate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!dateMatch) s3Error(400, 'AccessDenied', 'X-Amz-Date is invalid')
  const requestTime = Date.UTC(
    Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]),
    Number(dateMatch[4]), Number(dateMatch[5]), Number(dateMatch[6]),
  )
  const now = Date.now()
  const skew = presigned
    ? now - requestTime
    : Math.abs(now - requestTime)
  if (presigned ? skew < -MAX_CLOCK_SKEW_MS || skew > Number(url.searchParams.get('X-Amz-Expires')) * 1000 : skew > MAX_CLOCK_SKEW_MS) {
    s3Error(403, 'RequestTimeTooSkewed', 'The difference between the request time and the current time is too large')
  }
  if (dateMatch[1] + dateMatch[2] + dateMatch[3] !== credentialDate) {
    s3Error(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided')
  }

  if (payloadHash.startsWith('STREAMING-')) {
    s3Error(501, 'NotImplemented', 'Streaming SigV4 payloads are not supported')
  }

  const names = [...new Set(signedHeaders.length > 0 ? signedHeaders : ['host'])].sort()
  const canonicalHeaderSource = new Headers(req.headers)
  if (!canonicalHeaderSource.has('host')) canonicalHeaderSource.set('host', url.host)
  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url, new Set(['X-Amz-Signature'])),
    canonicalHeaders(canonicalHeaderSource, names),
    names.join(';'),
    payloadHash,
  ].join('\n')
  const scope = `${credentialDate}/${credentialRegion}/s3/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`
  const key = await signingKey(config.secretAccessKey, credentialDate, credentialRegion)
  const expected = toHex(await hmac(key, stringToSign))
  if (!constantTimeEqual(expected, signature)) {
    s3Error(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided')
  }
  return payloadHash
}

/** Storage-backed inbound S3 API. Only path-style addressing is supported. */
export class S3Handler {
  private readonly multipartMutex = new Mutex()

  private constructor(
    private readonly db: Database,
    private readonly driver: StorageDriver,
    private readonly options: S3RequestCredentials,
    private readonly defaultFileSizeLimit = MAX_OBJECT_BYTES,
  ) {}

  static async create(db: Database, driver: StorageDriver, options: S3EndpointOptions, defaultFileSizeLimit?: number): Promise<S3Handler> {
    const handler = new S3Handler(db, driver, {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region ?? 'us-east-1',
      bucketScope: options.bucketScope ?? [],
    }, defaultFileSizeLimit)
    await db.exec(`
      create table if not exists storage.s3_multipart_uploads (
        upload_id text primary key,
        bucket_id text not null,
        name text not null,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create table if not exists storage.s3_multipart_parts (
        upload_id text not null references storage.s3_multipart_uploads(upload_id) on delete cascade,
        part_number integer not null,
        etag text not null,
        size bigint not null,
        driver_key text not null,
        primary key (upload_id, part_number)
      );
      create table if not exists storage.s3_staged_cleanup (
        driver_key text primary key
      );
    `)
    await handler.drainStagedCleanup()
    await handler.expireMultipart()
    return handler
  }

  async handle(req: Request, url: URL): Promise<Response> {
    const requestId = crypto.randomUUID()
    try {
      const payloadHash = await verifyS3Request(req, url, this.options)
      const body = req.method === 'GET' || req.method === 'HEAD'
        ? new Uint8Array()
        : await readLimitedBody(req, req.method === 'POST' ? MAX_XML_BYTES : MAX_OBJECT_BYTES)
      if (body === null) s3Error(413, 'EntityTooLarge', 'The request body exceeded the maximum allowed size')
      await verifyS3Payload(body, payloadHash)
      return await this.route(req, url, body, requestId)
    } catch (error) {
      if (error instanceof S3Error) return xmlError(error, requestId)
      return xmlError(new S3Error(500, 'InternalError', 'We encountered an internal error. Please try again.'), requestId)
    } finally {
      if (req.body && !req.bodyUsed && !req.body.locked) await req.body.cancel()
    }
  }

  private async route(req: Request, url: URL, body: Uint8Array, requestId: string): Promise<Response> {
    const rest = url.pathname.replace(/^\/storage\/v1\/s3\/?/, '')
    const segments = rest === '' ? [] : rest.split('/').map((segment) => decodeURIComponent(segment))
    const bucket = segments[0]
    const key = segments.slice(1).join('/')
    const method = req.method.toUpperCase()

    if (!bucket) {
      if (method === 'GET') return this.listBuckets(requestId)
      s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource')
    }
    this.assertBucketScope(bucket)
    if (!key) return await this.bucketOperation(req, url, bucket, method, body, requestId)
    assertObjectKey(key)
    return await this.objectOperation(req, url, bucket, key, method, body, requestId)
  }

  private assertBucketScope(bucket: string): void {
    if (this.options.bucketScope.length > 0 && !this.options.bucketScope.includes(bucket)) {
      s3Error(403, 'AccessDenied', 'Access Denied')
    }
  }

  private async listBuckets(requestId: string): Promise<Response> {
    const result = await this.db.query<S3BucketRow>(`select id, name, created_at from storage.buckets order by id`)
    const buckets = result.rows
      .filter((row) => this.options.bucketScope.length === 0 || this.options.bucketScope.includes(row.id))
      .map((row) => `<Bucket><Name>${xmlEscape(row.id)}</Name><CreationDate>${iso(row.created_at)}</CreationDate></Bucket>`)
      .join('')
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>supacloud-lite</ID><DisplayName>supacloud-lite</DisplayName></Owner><Buckets>${buckets}</Buckets></ListAllMyBucketsResult>`, { 'x-amz-request-id': requestId })
  }

  private async bucketOperation(req: Request, url: URL, bucket: string, method: string, body: Uint8Array, requestId: string): Promise<Response> {
    const existing = await this.db.query<{ id: string }>(`select id from storage.buckets where id = $1`, [bucket])
    if (method === 'PUT') {
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) s3Error(400, 'InvalidBucketName', 'The specified bucket is not valid')
      if (existing.rows.length === 0) {
        await this.db.query(`insert into storage.buckets (id, name, public) values ($1, $1, false)`, [bucket])
      }
      return new Response(null, { status: 200, headers: this.headers(requestId) })
    }
    if (existing.rows.length === 0) s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist')
    if (method === 'HEAD') return new Response(null, { status: 200, headers: this.headers(requestId) })
    if (method === 'DELETE') {
      const objects = await this.db.query<{ count: number }>(`select count(*)::int as count from storage.objects where bucket_id = $1`, [bucket])
      if ((objects.rows[0]?.count ?? 0) > 0) s3Error(409, 'BucketNotEmpty', 'The bucket you tried to delete is not empty')
      await this.multipartState(async (query) => {
        const parts = await query<{ driver_key: string }>(
          `select p.driver_key from storage.s3_multipart_parts p join storage.s3_multipart_uploads u using (upload_id) where u.bucket_id = $1`,
          [bucket],
        )
        await this.driver.deleteMany(parts.rows.map((part) => part.driver_key))
        await query(`delete from storage.s3_multipart_uploads where bucket_id = $1`, [bucket])
        await query(`delete from storage.buckets where id = $1`, [bucket])
      })
      return new Response(null, { status: 204, headers: this.headers(requestId) })
    }
    if (method === 'GET' && url.searchParams.get('list-type') === '2') return this.listObjects(url, bucket, requestId)
    if (method === 'POST' && url.searchParams.has('delete')) return this.deleteObjects(body, bucket, requestId)
    s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource')
  }

  private headers(requestId: string, extra: Record<string, string> = {}): Headers {
    return new Headers({ 'x-amz-request-id': requestId, ...extra })
  }

  private async listObjects(url: URL, bucket: string, requestId: string): Promise<Response> {
    const prefix = url.searchParams.get('prefix') ?? ''
    const delimiter = url.searchParams.get('delimiter') ?? ''
    const maxKeys = Math.min(Math.max(Number(url.searchParams.get('max-keys') ?? 1000) || 1000, 0), 1000)
    const token = url.searchParams.get('continuation-token')
    const startAfter = url.searchParams.get('start-after') ?? ''
    const after = token ? Buffer.from(token, 'base64url').toString('utf8') : startAfter
    const rows = await this.db.query<S3ObjectRow>(
      `select * from storage.objects where bucket_id = $1 and name like $2 escape '\\' and name > $3 order by name limit $4`,
      [bucket, `${escapeLikePrefix(prefix)}%`, after, maxKeys + 1],
    )
    const contents: string[] = []
    const common = new Set<string>()
    let lastKey = ''
    for (const row of rows.rows.slice(0, maxKeys)) {
      const relative = row.name.slice(prefix.length)
      const slash = relative.indexOf(delimiter || '\0')
      if (delimiter && slash >= 0) common.add(prefix + relative.slice(0, slash + delimiter.length))
      else contents.push(this.objectEntry(row))
      lastKey = row.name
    }
    const truncated = rows.rows.length > maxKeys
    const prefixes = [...common].sort().map((value) => `<CommonPrefixes><Prefix>${xmlEscape(value)}</Prefix></CommonPrefixes>`).join('')
    const next = truncated && lastKey ? `<NextContinuationToken>${Buffer.from(lastKey).toString('base64url')}</NextContinuationToken>` : ''
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${contents.length + common.size}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${next}${contents.join('')}${prefixes}</ListBucketResult>`, { 'x-amz-request-id': requestId })
  }

  private objectEntry(row: S3ObjectRow): string {
    const meta = row.metadata ?? {}
    return `<Contents><Key>${xmlEscape(row.name)}</Key><LastModified>${iso(row.updated_at)}</LastModified>` +
      `<ETag>&quot;${xmlEscape(String(meta.eTag ?? ''))}&quot;</ETag><Size>${Number(meta.size ?? 0)}</Size>` +
      `<StorageClass>STANDARD</StorageClass></Contents>`
  }

  private async deleteObjects(body: Uint8Array, bucket: string, requestId: string): Promise<Response> {
    const document = s3XmlDocument(body)
    const root = document['Delete']
    if (!xmlRecord(root) || !Array.isArray(root['Object']) || root['Object'].length === 0 || root['Object'].length > 1000) {
      s3Error(400, 'MalformedXML', 'A delete document must specify between 1 and 1000 objects')
    }
    const keys = root['Object'].map((object: unknown) => {
      if (!xmlRecord(object) || typeof object['Key'] !== 'string') s3Error(400, 'MalformedXML', 'Each object requires one key')
      assertObjectKey(object['Key'])
      return object['Key']
    })
    for (const key of keys) await this.deleteObject(bucket, key)
    const deleted = keys.map((key) => `<Deleted><Key>${xmlEscape(key)}</Key></Deleted>`).join('')
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deleted}</DeleteResult>`, { 'x-amz-request-id': requestId })
  }

  private async objectOperation(req: Request, url: URL, bucket: string, key: string, method: string, body: Uint8Array, requestId: string): Promise<Response> {
    const uploadId = url.searchParams.get('uploadId')
    if (url.searchParams.has('uploads') || uploadId) {
      return this.multipartMutex.run(async () => {
        await this.drainStagedCleanup()
        await this.expireMultipart()
        if (method === 'POST' && url.searchParams.has('uploads')) return this.createMultipart(bucket, key, req, requestId)
        if (method === 'PUT' && uploadId) return this.uploadPart(bucket, key, uploadId, url, body, requestId)
        if (method === 'POST' && uploadId) return this.completeMultipart(bucket, key, uploadId, body, requestId)
        if (method === 'DELETE' && uploadId) return this.abortMultipart(bucket, key, uploadId, requestId)
        return s3Error(405, 'MethodNotAllowed', 'This multipart operation is not supported')
      })
    }
    const copySource = req.headers.get('x-amz-copy-source')
    if (method === 'PUT' && copySource) return this.copyObject(bucket, key, copySource, req, requestId)
    if (method === 'PUT') {
      await this.putObject(bucket, key, body, req.headers)
      return new Response(null, { status: 200, headers: this.headers(requestId, { etag: `"${await sha256Hex(body)}"` }) })
    }
    const row = await this.findObject(bucket, key)
    if (method === 'HEAD' || method === 'GET') {
      if (!row) s3Error(404, 'NoSuchKey', 'The specified key does not exist.')
      const bytes = await this.driver.get(this.driverKey(row))
      if (!bytes) s3Error(404, 'NoSuchKey', 'The specified key does not exist.')
      const headers = this.objectHeaders(row, bytes.length)
      headers.set('x-amz-request-id', requestId)
      const range = req.headers.get('range')
      if (range) {
        const { start, end } = objectRange(range, bytes.length)
        const slice = bytes.slice(start, end + 1)
        headers.set('content-range', `bytes ${start}-${end}/${bytes.length}`)
        headers.set('content-length', String(slice.length))
        return new Response(method === 'HEAD' ? null : (slice as BodyInit), { status: 206, headers })
      }
      return new Response(method === 'HEAD' ? null : (bytes as BodyInit), { status: 200, headers })
    }
    if (method === 'DELETE') {
      await this.deleteObject(bucket, key)
      return new Response(null, { status: 204, headers: this.headers(requestId) })
    }
    s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource')
  }

  private objectHeaders(row: S3ObjectRow, size: number): Headers {
    const meta = row.metadata ?? {}
    return new Headers({
      'content-type': String(meta.mimetype ?? 'application/octet-stream'),
      'content-length': String(size),
      'cache-control': String(meta.cacheControl ?? 'no-cache'),
      etag: `"${String(meta.eTag ?? '')}"`,
      'last-modified': headerDate(String(meta.lastModified ?? row.updated_at ?? Date.now())),
      'accept-ranges': 'bytes',
    })
  }

  private async findObject(bucket: string, key: string): Promise<S3ObjectRow | undefined> {
    const result = await this.db.query<S3ObjectRow>(`select * from storage.objects where bucket_id = $1 and name = $2`, [bucket, key])
    return result.rows[0]
  }

  private async putObject(bucket: string, key: string, body: Uint8Array, headers: Headers, metadata?: Record<string, unknown>): Promise<void> {
    const bucketRow = await this.loadBucket(bucket)
    if (!bucketRow) s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist')
    const contentType = headers.get('content-type') ?? String(metadata?.mimetype ?? 'application/octet-stream')
    this.assertObjectPolicy(bucketRow, body.length, contentType)
    // Reuse the Storage API's version prefix so normal /storage/v1 downloads
    // and S3 writes read the same immutable object payload.
    const version = `v2-${crypto.randomUUID()}`
    const driverKey = `.supacloud-lite/objects/${version}`
    const now = new Date().toISOString()
    const meta = {
      ...metadata,
      size: body.length,
      mimetype: contentType,
      cacheControl: headers.get('cache-control') ?? 'no-cache',
      eTag: await sha256Hex(body),
      lastModified: now,
    }
    const existing = await this.findObject(bucket, key)
    try {
      await this.driver.put(driverKey, body)
      await this.db.query(
        `insert into storage.objects (id, bucket_id, name, owner_id, metadata, version)
         values ($1, $2, $3, NULL, $4::jsonb, $5)
         on conflict (bucket_id, name) do update
         set metadata = excluded.metadata, version = excluded.version, updated_at = now()`,
        [crypto.randomUUID(), bucket, key, JSON.stringify(meta), version],
      )
    } catch (error) {
      await this.discardFailedStage(driverKey, error)
    }
    if (existing) {
      await this.driver.delete(this.driverKey(existing)).catch(() => {})
    }
  }

  private async deleteObject(bucket: string, key: string): Promise<void> {
    const row = await this.findObject(bucket, key)
    if (!row) return
    await this.db.query(`delete from storage.objects where bucket_id = $1 and name = $2`, [bucket, key])
    await this.driver.delete(this.driverKey(row)).catch(() => {})
  }

  private async copyObject(bucket: string, key: string, rawSource: string, req: Request, requestId: string): Promise<Response> {
    const source = decodeURIComponent(rawSource).replace(/^\/+/, '').split('/')
    const sourceBucket = source.shift()!
    const sourceKey = source.join('/')
    this.assertBucketScope(sourceBucket)
    assertObjectKey(sourceKey)
    const row = await this.findObject(sourceBucket, sourceKey)
    if (!row) s3Error(404, 'NoSuchKey', 'The specified key does not exist.')
    const bytes = await this.driver.get(this.driverKey(row))
    if (!bytes) s3Error(404, 'NoSuchKey', 'The specified key does not exist.')
    const metadata = req.headers.get('x-amz-metadata-directive')?.toUpperCase() === 'REPLACE' ? {} : row.metadata ?? {}
    await this.putObject(bucket, key, bytes, req.headers, metadata)
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><LastModified>${new Date().toISOString()}</LastModified><ETag>&quot;${xmlEscape(String((row.metadata ?? {}).eTag ?? ''))}&quot;</ETag></CopyObjectResult>`, { 'x-amz-request-id': requestId })
  }

  private driverKey(row: S3ObjectRow): string {
    return row.version?.startsWith('v2-')
      ? `.supacloud-lite/objects/${row.version}`
      : `${row.bucket_id}/${row.name}`
  }

  private async createMultipart(bucket: string, key: string, req: Request, requestId: string): Promise<Response> {
    const bucketRow = await this.loadBucket(bucket)
    if (!bucketRow) s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist')
    const contentType = req.headers.get('content-type') ?? 'application/octet-stream'
    this.assertMimeType(bucketRow, contentType)
    const uploadId = crypto.randomUUID()
    await this.multipartState(async (query) => {
      const uploads = await query<{ count: number }>('select count(*)::int as count from storage.s3_multipart_uploads')
      if (uploads.rows[0]!.count >= MAX_ACTIVE_UPLOADS) s3Error(503, 'SlowDown', 'Too many active multipart uploads')
      await query(
        `insert into storage.s3_multipart_uploads (upload_id, bucket_id, name, metadata) values ($1, $2, $3, $4::jsonb)`,
        [uploadId, bucket, key, JSON.stringify({ mimetype: contentType })],
      )
    })
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`, { 'x-amz-request-id': requestId })
  }

  private async uploadPart(bucket: string, key: string, uploadId: string, url: URL, body: Uint8Array, requestId: string): Promise<Response> {
    const partNumber = Number(url.searchParams.get('partNumber'))
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) s3Error(400, 'InvalidArgument', 'partNumber is invalid')
    const bucketRow = await this.loadBucket(bucket)
    if (!bucketRow) s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist')
    const etag = await sha256Hex(body)
    const driverKey = `s3-multipart/${uploadId}/${partNumber}/${crypto.randomUUID()}`
    let staged = false
    let previousKey: string | undefined
    try {
      previousKey = await this.multipartState(async (query) => {
        const upload = await query(`select 1 from storage.s3_multipart_uploads where upload_id = $1 and bucket_id = $2 and name = $3`, [uploadId, bucket, key])
        if (upload.rows.length === 0) s3Error(404, 'NoSuchUpload', 'The specified upload does not exist.')
        const previous = await query<MultipartPart>('select * from storage.s3_multipart_parts where upload_id = $1 and part_number = $2', [uploadId, partNumber])
        const replaced = previous.rows[0]
        const sizes = await query<{ total: string; upload_total: string; count: number }>(
          `select coalesce(sum(size), 0)::text as total, count(*)::int as count,
            coalesce(sum(size) filter (where upload_id = $1), 0)::text as upload_total from storage.s3_multipart_parts`,
          [uploadId],
        )
        const totals = sizes.rows[0]!
        const added = body.length - Number(replaced?.size ?? 0)
        this.assertObjectPolicy(bucketRow, Number(totals.upload_total) + added, undefined)
        if (Number(totals.total) + added > MAX_STAGED_BYTES || (!replaced && totals.count >= MAX_STAGED_PARTS)) {
          s3Error(503, 'SlowDown', 'The multipart staging budget is exhausted')
        }
        staged = true
        await this.driver.put(driverKey, body)
        await query(
          `insert into storage.s3_multipart_parts (upload_id, part_number, etag, size, driver_key)
           values ($1, $2, $3, $4, $5)
           on conflict (upload_id, part_number) do update set etag = excluded.etag, size = excluded.size, driver_key = excluded.driver_key`,
          [uploadId, partNumber, etag, body.length, driverKey],
        )
        if (replaced) await query('insert into storage.s3_staged_cleanup (driver_key) values ($1) on conflict do nothing', [replaced.driver_key])
        return replaced?.driver_key
      })
    } catch (error) {
      if (staged) await this.discardFailedStage(driverKey, error)
      throw error
    }
    if (previousKey) await this.drainStagedCleanup()
    return new Response(null, { status: 200, headers: this.headers(requestId, { etag: `"${etag}"` }) })
  }

  private async completeMultipart(bucket: string, key: string, uploadId: string, body: Uint8Array, requestId: string): Promise<Response> {
    const upload = await this.db.query<{ metadata: Record<string, unknown> }>(`select metadata from storage.s3_multipart_uploads where upload_id = $1 and bucket_id = $2 and name = $3`, [uploadId, bucket, key])
    if (upload.rows.length === 0) s3Error(404, 'NoSuchUpload', 'The specified upload does not exist.')
    const requested = completeParts(body)
    const parts = await this.db.query<MultipartPart>(`select part_number, etag, size, driver_key from storage.s3_multipart_parts where upload_id = $1 order by part_number`, [uploadId])
    if (parts.rows.length === 0) s3Error(400, 'InvalidPart', 'One or more of the specified parts could not be found')
    const selected = selectedParts(requested, parts.rows)
    const total = selected.reduce((size, part) => size + Number(part.size), 0)
    const bucketRow = await this.loadBucket(bucket)
    if (!bucketRow) s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist')
    this.assertObjectPolicy(bucketRow, total, String(upload.rows[0]!.metadata.mimetype ?? 'application/octet-stream'))
    const data = new Uint8Array(total)
    let offset = 0
    for (const part of selected) {
      const bytes = await this.driver.get(part.driver_key)
      if (!bytes || bytes.length !== Number(part.size)) s3Error(400, 'InvalidPart', 'The stored part does not match its declared size')
      data.set(bytes, offset)
      offset += bytes.length
    }
    await this.putObject(bucket, key, data, new Headers({ 'content-type': String(upload.rows[0]!.metadata.mimetype ?? 'application/octet-stream') }), upload.rows[0]!.metadata)
    await this.abortMultipart(bucket, key, uploadId, requestId)
    const etag = await sha256Hex(data)
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Location>/storage/v1/s3/${xmlEscape(bucket)}/${xmlEscape(key)}</Location><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>&quot;${etag}&quot;</ETag></CompleteMultipartUploadResult>`, { 'x-amz-request-id': requestId })
  }

  private async abortMultipart(bucket: string, key: string, uploadId: string, requestId: string): Promise<Response> {
    await this.multipartState(async (query) => {
      const upload = await query(
        `select 1 from storage.s3_multipart_uploads where upload_id = $1 and bucket_id = $2 and name = $3`,
        [uploadId, bucket, key],
      )
      if (upload.rows.length === 0) s3Error(404, 'NoSuchUpload', 'The specified upload does not exist.')
      const parts = await query<MultipartPart>(
        `select part_number, etag, size, driver_key from storage.s3_multipart_parts where upload_id = $1`,
        [uploadId],
      )
      await this.driver.deleteMany(parts.rows.map((part) => part.driver_key))
      await query(`delete from storage.s3_multipart_uploads where upload_id = $1 and bucket_id = $2 and name = $3`, [uploadId, bucket, key])
    })
    return new Response(null, { status: 204, headers: this.headers(requestId) })
  }

  private async loadBucket(bucket: string): Promise<S3BucketRow | undefined> {
    const result = await this.db.query<S3BucketRow>(
      `select id, name, created_at, file_size_limit, allowed_mime_types from storage.buckets where id = $1`,
      [bucket],
    )
    return result.rows[0]
  }

  private multipartState<T>(run: (query: Querier) => Promise<T>): Promise<T> {
    return this.db.transaction(async (query) => {
      await query('lock table storage.s3_multipart_uploads, storage.s3_multipart_parts in exclusive mode')
      return run(query)
    })
  }

  private async expireMultipart(): Promise<void> {
    await this.multipartState(async (query) => {
      const parts = await query<{ driver_key: string }>(
        `select p.driver_key from storage.s3_multipart_parts p join storage.s3_multipart_uploads u using (upload_id)
         where u.created_at < now() - interval '24 hours'`,
      )
      await this.driver.deleteMany(parts.rows.map((part) => part.driver_key))
      await query(`delete from storage.s3_multipart_uploads where created_at < now() - interval '24 hours'`)
    })
  }

  private async discardFailedStage(key: string, error: unknown): Promise<never> {
    try {
      await this.driver.delete(key)
    } catch (cleanupError) {
      await this.db.query('insert into storage.s3_staged_cleanup (driver_key) values ($1) on conflict do nothing', [key])
      throw new AggregateError([error, cleanupError], 'Failed storage write and staged-byte cleanup')
    }
    throw error
  }

  private async drainStagedCleanup(): Promise<void> {
    const pending = await this.db.query<{ driver_key: string }>('select driver_key from storage.s3_staged_cleanup')
    for (const staged of pending.rows) {
      await this.driver.delete(staged.driver_key)
      await this.db.query('delete from storage.s3_staged_cleanup where driver_key = $1', [staged.driver_key])
    }
  }

  private assertObjectPolicy(bucket: S3BucketRow, size: number, contentType: string | undefined): void {
    const limit = Math.min(MAX_OBJECT_BYTES, Number(bucket.file_size_limit ?? this.defaultFileSizeLimit))
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
      s3Error(413, 'EntityTooLarge', 'The object exceeded the bucket file size limit')
    }
    if (contentType) this.assertMimeType(bucket, contentType)
  }

  private assertMimeType(bucket: S3BucketRow, contentType: string): void {
    if (invalidMimeType(bucket, contentType)) s3Error(415, 'InvalidRequest', 'The content type is not allowed for this bucket')
  }
}

function objectRange(range: string, size: number): { start: number; end: number } {
  // Boundaries: explicit/open-ended/suffix ranges, zero/empty objects and unsafe integers.
  const match = range.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (!match[1] && !match[2]) || size === 0) s3Error(416, 'InvalidRange', 'The requested range is not satisfiable')
  const first = Number(match[1])
  const last = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) s3Error(416, 'InvalidRange', 'The requested range is not satisfiable')
  const start = match[1] ? first : Math.max(size - last, 0)
  const end = match[1] ? Math.min(last, size - 1) : size - 1
  if ((!match[1] && last === 0) || start >= size || end < start) s3Error(416, 'InvalidRange', 'The requested range is not satisfiable')
  return { start, end }
}

function assertObjectKey(key: string): void {
  const invalid = invalidObjectKey(key)
  if (invalid) s3Error(400, 'InvalidArgument', invalid)
}

function escapeLikePrefix(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

interface RequestedPart {
  partNumber: number
  etag: string
}

function completeParts(body: Uint8Array): RequestedPart[] {
  const document = s3XmlDocument(body)
  const root = document['CompleteMultipartUpload']
  if (!xmlRecord(root) || Object.keys(root).some((name) => name !== 'Part')) s3Error(400, 'MalformedXML', 'A complete multipart upload document is required')
  const parts = root['Part']
  if (!Array.isArray(parts) || parts.length === 0) s3Error(400, 'MalformedXML', 'The parts document is invalid')
  if (parts.length > 10000) s3Error(400, 'InvalidRequest', 'Too many multipart parts')
  return parts.map((part: unknown) => {
    if (!xmlRecord(part) || Object.keys(part).length !== 2 || typeof part['PartNumber'] !== 'string' || typeof part['ETag'] !== 'string') {
      s3Error(400, 'MalformedXML', 'Each part requires one PartNumber and ETag')
    }
    if (!/^\d+$/.test(part['PartNumber'])) s3Error(400, 'InvalidPart', 'The part number is invalid')
    return { partNumber: Number(part['PartNumber']), etag: part['ETag'].replace(/^"(.*)"$/, '$1').toLowerCase() }
  })
}

function xmlRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
}

function s3XmlDocument(body: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(body)
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) s3Error(400, 'MalformedXML', 'The XML document is invalid')
  const document: unknown = new XMLParser({
    parseTagValue: false,
    ignoreDeclaration: true,
    ignoreAttributes: true,
    isArray: (name) => name === 'Part' || name === 'Object',
  }).parse(text)
  if (!xmlRecord(document) || Object.keys(document).length !== 1) s3Error(400, 'MalformedXML', 'One XML root element is required')
  return document
}

function selectedParts(requested: RequestedPart[], stored: MultipartPart[]): MultipartPart[] {
  const byNumber = new Map(stored.map((part) => [part.part_number, part]))
  return requested.map((part, index) => {
    if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > 10000) s3Error(400, 'InvalidPart', 'The part number is invalid')
    if (index > 0 && part.partNumber <= requested[index - 1]!.partNumber) s3Error(400, 'InvalidPartOrder', 'Parts must be unique and in ascending order')
    const storedPart = byNumber.get(part.partNumber)
    if (!storedPart || storedPart.etag.toLowerCase() !== part.etag || !Number.isSafeInteger(Number(storedPart.size)) || Number(storedPart.size) < 0) {
      s3Error(400, 'InvalidPart', 'One or more of the specified parts could not be found')
    }
    return storedPart
  })
}
