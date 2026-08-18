import type { ImageTransformOptions, ImageTransformResult } from './image-transform.js'

const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_CACHE_ENTRIES = 128
const OBJECT_VERSION_PREFIX = 'v2-'

interface CachedTransform {
  transform: Extract<ImageTransformResult, { ok: true }>
  size: number
}

class Semaphore {
  private active = 0
  private waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await operation()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.active -= 1
  }
}

const globalImageTransformSemaphore = new Semaphore(1)

export function imageTransformCacheKey(version: string | null, options: ImageTransformOptions): string | null {
  if (!version?.startsWith(OBJECT_VERSION_PREFIX)) return null
  return [
    version,
    options.width ?? '',
    options.height ?? '',
    options.resize,
    options.quality ?? '',
    options.format,
  ].join('\0')
}

export class ImageTransformCache {
  private readonly entries = new Map<string, CachedTransform>()
  private readonly inFlight = new Map<string, Promise<ImageTransformResult>>()
  private cachedBytes = 0

  constructor(
    private readonly maxBytes = DEFAULT_MAX_CACHE_BYTES,
    private readonly maxEntries = DEFAULT_MAX_CACHE_ENTRIES
  ) {}

  async getOrTransform(
    key: string | null,
    operation: () => Promise<ImageTransformResult>
  ): Promise<ImageTransformResult> {
    if (key === null) return globalImageTransformSemaphore.run(operation)

    const cached = this.entries.get(key)
    if (cached) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return cached.transform
    }

    const pending = this.inFlight.get(key)
    if (pending) return pending

    const transform = globalImageTransformSemaphore.run(operation)
    this.inFlight.set(key, transform)
    try {
      const transformResult = await transform
      if (transformResult.ok) this.store(key, transformResult)
      return transformResult
    } finally {
      this.inFlight.delete(key)
    }
  }

  private store(key: string, transform: Extract<ImageTransformResult, { ok: true }>): void {
    const size = transform.bytes.byteLength
    if (size > this.maxBytes || this.maxEntries === 0) return

    const previous = this.entries.get(key)
    if (previous) {
      this.cachedBytes -= previous.size
      this.entries.delete(key)
    }
    this.entries.set(key, { transform, size })
    this.cachedBytes += size

    while (this.entries.size > this.maxEntries || this.cachedBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      const oldest = this.entries.get(oldestKey)!
      this.entries.delete(oldestKey)
      this.cachedBytes -= oldest.size
    }
  }
}
