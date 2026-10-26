/**
 * Inbound S3-compatible API (`/storage/v1/s3`) for Lite.
 *
 * This is a protocol adapter, not the outbound S3StorageDriver: AWS SDKs sign
 * requests with SigV4 and expect XML responses, while Lite's normal Storage API
 * uses JWT/apikey and JSON. Both share storage.buckets, storage.objects and the
 * configured StorageDriver for bytes.
 */
import type { Database, Querier } from '../db/database.js'
import type { StorageDriver } from '../types.js'

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

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60
const MAX_SINGLE_PUT_BYTES = 64 * 1024 * 1024

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
}

interface MultipartPart {
  part_number: number
  etag: string
  size: number
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

  if (payloadHash !== 'UNSIGNED-PAYLOAD') {
    if (payloadHash.startsWith('STREAMING-')) {
      s3Error(501, 'NotImplemented', 'Streaming SigV4 payloads are not supported')
    }
    const actual = await sha256Hex(body)
    if (!constantTimeEqual(actual, payloadHash.toLowerCase())) {
      s3Error(400, 'XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 does not match the request body')
    }
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
}

/** Storage-backed inbound S3 API. Only path-style addressing is supported. */
export class S3Handler {
  private constructor(
    private readonly db: Database,
    private readonly driver: StorageDriver,
    private readonly options: S3RequestCredentials,
  ) {}

  static async create(db: Database, driver: StorageDriver, options: S3EndpointOptions): Promise<S3Handler> {
    const handler = new S3Handler(db, driver, {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region ?? 'us-east-1',
      bucketScope: options.bucketScope ?? [],
    })
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
    `)
    return handler
  }

  async handle(req: Request, url: URL): Promise<Response> {
    const requestId = crypto.randomUUID()
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? new Uint8Array() : new Uint8Array(await req.arrayBuffer())
      if (body.byteLength > MAX_SINGLE_PUT_BYTES) {
        s3Error(413, 'EntityTooLarge', 'The object exceeded the maximum allowed size')
      }
      await verifyS3Signature(req, url, body, this.options)
      return await this.route(req, url, body, requestId)
    } catch (error) {
      if (error instanceof S3Error) return xmlError(error, requestId)
      return xmlError(new S3Error(500, 'InternalError', 'We encountered an internal error. Please try again.'), requestId)
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
      await this.db.query(`delete from storage.buckets where id = $1`, [bucket])
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
      `select * from storage.objects where bucket_id = $1 and name like $2 and name > $3 order by name limit $4`,
      [bucket, `${prefix}%`, after, maxKeys + 1],
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
    const text = new TextDecoder().decode(body)
    const keys = [...text.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => xmlUnescape(match[1]!))
    if (keys.length === 0) s3Error(400, 'MalformedXML', 'The XML you provided was not well-formed')
    for (const key of keys) await this.deleteObject(bucket, key)
    const deleted = keys.map((key) => `<Deleted><Key>${xmlEscape(key)}</Key></Deleted>`).join('')
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deleted}</DeleteResult>`, { 'x-amz-request-id': requestId })
  }

  private async objectOperation(req: Request, url: URL, bucket: string, key: string, method: string, body: Uint8Array, requestId: string): Promise<Response> {
    const uploadId = url.searchParams.get('uploadId')
    if (method === 'POST' && url.searchParams.has('uploads')) return this.createMultipart(bucket, key, req, requestId)
    if (method === 'PUT' && uploadId) return this.uploadPart(bucket, key, uploadId, url, body, requestId)
    if (method === 'POST' && uploadId) return this.completeMultipart(bucket, key, uploadId, body, requestId)
    if (method === 'DELETE' && uploadId) return this.abortMultipart(uploadId, requestId)
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
        const match = range.match(/^bytes=(\d*)-(\d*)$/)
        if (!match) s3Error(416, 'InvalidRange', 'The requested range is not satisfiable')
        const start = match[1] ? Number(match[1]) : 0
        const end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1
        if (start >= bytes.length || end < start) s3Error(416, 'InvalidRange', 'The requested range is not satisfiable')
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
    const bucketRow = await this.db.query<{ id: string }>(`select id from storage.buckets where id = $1`, [bucket])
    if (bucketRow.rows.length === 0) s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist')
    // Reuse the Storage API's version prefix so normal /storage/v1 downloads
    // and S3 writes read the same immutable object payload.
    const version = `v2-${crypto.randomUUID()}`
    const driverKey = `.supacloud-lite/objects/${version}`
    await this.driver.put(driverKey, body)
    const now = new Date().toISOString()
    const meta = {
      size: body.length,
      mimetype: headers.get('content-type') ?? 'application/octet-stream',
      cacheControl: headers.get('cache-control') ?? 'no-cache',
      eTag: await sha256Hex(body),
      lastModified: now,
      ...metadata,
    }
    const existing = await this.findObject(bucket, key)
    await this.db.query(
      `insert into storage.objects (id, bucket_id, name, owner_id, metadata, version)
       values ($1, $2, $3, NULL, $4::jsonb, $5)
       on conflict (bucket_id, name) do update
       set metadata = excluded.metadata, version = excluded.version, updated_at = now()`,
      [crypto.randomUUID(), bucket, key, JSON.stringify(meta), version],
    )
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
    const row = await this.findObject(sourceBucket, sourceKey)
    if (!row) s3Error(404, 'NoSuchKey', 'The specified key does not exist.')
    const bytes = await this.driver.get(this.driverKey(row))
    if (!bytes) s3Error(404, 'NoSuchKey', 'The specified key does not exist.')
    const metadata = req.headers.get('x-amz-metadata-directive')?.toUpperCase() === 'REPLACE' ? {} : row.metadata ?? {}
    await this.putObject(bucket, key, bytes, req.headers, { ...metadata, mimetype: req.headers.get('content-type') ?? metadata.mimetype })
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><LastModified>${new Date().toISOString()}</LastModified><ETag>&quot;${xmlEscape(String((row.metadata ?? {}).eTag ?? ''))}&quot;</ETag></CopyObjectResult>`, { 'x-amz-request-id': requestId })
  }

  private driverKey(row: S3ObjectRow): string {
    return row.version?.startsWith('v2-')
      ? `.supacloud-lite/objects/${row.version}`
      : `${row.bucket_id}/${row.name}`
  }

  private async createMultipart(bucket: string, key: string, req: Request, requestId: string): Promise<Response> {
    const bucketRow = await this.db.query(`select id from storage.buckets where id = $1`, [bucket])
    if (bucketRow.rows.length === 0) s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist')
    const uploadId = crypto.randomUUID()
    await this.db.query(
      `insert into storage.s3_multipart_uploads (upload_id, bucket_id, name, metadata) values ($1, $2, $3, $4::jsonb)`,
      [uploadId, bucket, key, JSON.stringify({ mimetype: req.headers.get('content-type') ?? 'application/octet-stream' })],
    )
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`, { 'x-amz-request-id': requestId })
  }

  private async uploadPart(bucket: string, key: string, uploadId: string, url: URL, body: Uint8Array, requestId: string): Promise<Response> {
    const partNumber = Number(url.searchParams.get('partNumber'))
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) s3Error(400, 'InvalidArgument', 'partNumber is invalid')
    const upload = await this.db.query(`select 1 from storage.s3_multipart_uploads where upload_id = $1 and bucket_id = $2 and name = $3`, [uploadId, bucket, key])
    if (upload.rows.length === 0) s3Error(404, 'NoSuchUpload', 'The specified upload does not exist.')
    const etag = await sha256Hex(body)
    const driverKey = `s3-multipart/${uploadId}/${partNumber}`
    await this.driver.put(driverKey, body)
    await this.db.query(
      `insert into storage.s3_multipart_parts (upload_id, part_number, etag, size, driver_key)
       values ($1, $2, $3, $4, $5)
       on conflict (upload_id, part_number) do update set etag = excluded.etag, size = excluded.size, driver_key = excluded.driver_key`,
      [uploadId, partNumber, etag, body.length, driverKey],
    )
    return new Response(null, { status: 200, headers: this.headers(requestId, { etag: `"${etag}"` }) })
  }

  private async completeMultipart(bucket: string, key: string, uploadId: string, body: Uint8Array, requestId: string): Promise<Response> {
    const upload = await this.db.query<{ metadata: Record<string, unknown> }>(`select metadata from storage.s3_multipart_uploads where upload_id = $1 and bucket_id = $2 and name = $3`, [uploadId, bucket, key])
    if (upload.rows.length === 0) s3Error(404, 'NoSuchUpload', 'The specified upload does not exist.')
    const text = new TextDecoder().decode(body)
    const requested = [...text.matchAll(/<Part>[\s\S]*?<PartNumber>(\d+)<\/PartNumber>[\s\S]*?<ETag>&quot;([^&]+)&quot;<\/ETag>[\s\S]*?<\/Part>|<Part>[\s\S]*?<PartNumber>(\d+)<\/PartNumber>[\s\S]*?<ETag>"([^"]+)"<\/ETag>[\s\S]*?<\/Part>/g)]
      .map((match) => ({ partNumber: Number(match[1] ?? match[3]), etag: (match[2] ?? match[4] ?? '').toLowerCase() }))
    const parts = await this.db.query<MultipartPart>(`select part_number, etag, size, driver_key from storage.s3_multipart_parts where upload_id = $1 order by part_number`, [uploadId])
    if (parts.rows.length === 0) s3Error(400, 'InvalidPart', 'One or more of the specified parts could not be found')
    const selected = requested.length > 0 ? requested : parts.rows.map((part) => ({ partNumber: part.part_number, etag: part.etag }))
    let total = 0
    const chunks: Uint8Array[] = []
    for (const requestedPart of selected) {
      const part = parts.rows.find((candidate) => candidate.part_number === requestedPart.partNumber)
      if (!part || part.etag.toLowerCase() !== requestedPart.etag) s3Error(400, 'InvalidPart', 'One or more of the specified parts could not be found')
      const bytes = await this.driver.get(part.driver_key)
      if (!bytes) s3Error(400, 'InvalidPart', 'One or more of the specified parts could not be found')
      chunks.push(bytes)
      total += bytes.length
    }
    const data = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length }
    await this.putObject(bucket, key, data, new Headers({ 'content-type': String(upload.rows[0]!.metadata.mimetype ?? 'application/octet-stream') }), upload.rows[0]!.metadata)
    await this.db.query(`delete from storage.s3_multipart_uploads where upload_id = $1`, [uploadId])
    await Promise.all(parts.rows.map((part) => this.driver.delete(part.driver_key).catch(() => {})))
    const etag = await sha256Hex(data)
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Location>/storage/v1/s3/${xmlEscape(bucket)}/${xmlEscape(key)}</Location><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>&quot;${etag}&quot;</ETag></CompleteMultipartUploadResult>`, { 'x-amz-request-id': requestId })
  }

  private async abortMultipart(uploadId: string, requestId: string): Promise<Response> {
    const parts = await this.db.query<MultipartPart>(`select part_number, etag, size, driver_key from storage.s3_multipart_parts where upload_id = $1`, [uploadId])
    await this.db.query(`delete from storage.s3_multipart_uploads where upload_id = $1`, [uploadId])
    await Promise.all(parts.rows.map((part) => this.driver.delete(part.driver_key).catch(() => {})))
    return new Response(null, { status: 204, headers: this.headers(requestId) })
  }
}

function xmlUnescape(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')
}
