import type { StorageDriver } from '../types.js'

export interface S3StorageDriverOptions {
  bucket?: string
  prefix?: string
  endpoint?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  virtualHostedStyle?: boolean
  partSize?: number
  queueSize?: number
  retry?: number
  requestPayer?: boolean
}

export interface S3StorageFileLike {
  exists(): Promise<boolean>
  bytes(): Promise<Uint8Array>
  write(data: Uint8Array): Promise<unknown>
  delete(): Promise<void>
}

export interface S3StorageClientLike {
  file(path: string): S3StorageFileLike
}

function normalizePath(value: string, label: string, allowEmpty: boolean): string {
  if (value.includes('\0')) {
    throw new TypeError(`${label} must not contain null bytes`)
  }

  const path = value.replaceAll('\\', '/')
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
    throw new RangeError(`${label} must not be absolute`)
  }

  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) {
        throw new RangeError(`${label} must not escape its root`)
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  const normalized = segments.join('/')
  if (!normalized && !allowEmpty) {
    throw new TypeError(`${label} must not be empty`)
  }
  return normalized
}

function normalizePrefix(prefix: string | undefined): string {
  const normalized = normalizePath(prefix ?? '', 'prefix', true)
  return normalized ? `${normalized}/` : ''
}

function normalizeKey(key: string): string {
  return normalizePath(key, 'key', false)
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const candidate = error as {
    code?: unknown
    name?: unknown
    status?: unknown
    statusCode?: unknown
  }
  return (
    candidate.status === 404 ||
    candidate.statusCode === 404 ||
    candidate.code === 'ENOENT' ||
    candidate.code === 'NoSuchKey' ||
    candidate.code === 'NotFound' ||
    candidate.name === 'NotFound'
  )
}

export class S3StorageDriver implements StorageDriver {
  readonly cleanupFailureMode = 'propagate' as const
  private readonly client: S3StorageClientLike
  private readonly prefix: string

  constructor(options: S3StorageDriverOptions = {}, client?: S3StorageClientLike) {
    const { prefix, ...clientOptions } = options
    this.prefix = normalizePrefix(prefix)
    this.client = client ?? new Bun.S3Client(clientOptions)
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    await this.client.file(this.objectKey(key)).write(data)
  }

  async get(key: string): Promise<Uint8Array | null> {
    const file = this.client.file(this.objectKey(key))
    if (!(await file.exists())) return null

    try {
      return await file.bytes()
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
  }

  /** Return Bun's lazy S3 blob; custom clients fall back to their byte API. */
  async getBlob(key: string): Promise<Blob | null> {
    const file = this.client.file(this.objectKey(key))
    if (!(await file.exists())) return null
    if (typeof (file as Partial<Blob>).arrayBuffer === 'function') return file as unknown as Blob

    try {
      const bytes = Uint8Array.from(await file.bytes())
      return new Blob([bytes.buffer])
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.file(this.objectKey(key)).delete()
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.delete(key)
    }
  }

  private objectKey(key: string): string {
    return `${this.prefix}${normalizeKey(key)}`
  }
}
