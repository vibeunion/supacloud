export type ImageTransformResize = 'contain' | 'fill'
export type ImageTransformFormat = 'origin' | 'jpeg' | 'png' | 'webp'

export interface ImageTransformOptions {
  width?: number
  height?: number
  resize: ImageTransformResize
  quality?: number
  format: ImageTransformFormat
}

export interface ImageTransformRequestOptions {
  width?: number
  height?: number
  resize?: ImageTransformResize | 'cover'
  quality?: number
  format?: ImageTransformFormat
}

export interface ImageTransformError {
  ok: false
  status: 400 | 413 | 415 | 422
  error: string
  message: string
}

export type ImageTransformParseResult =
  | { ok: true; value: ImageTransformOptions }
  | ImageTransformError

export type ImageTransformResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | ImageTransformError

const IMAGE_FORMAT_CONTENT_TYPES: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  gif: 'image/gif',
}
const MAX_TRANSFORM_DIMENSION = 2500
const MAX_TRANSFORM_BYTES = 25 * 1024 * 1024
const MAX_TRANSFORM_PIXELS = 50_000_000

function invalid(message: string): ImageTransformError {
  return { ok: false, status: 400, error: 'InvalidTransformation', message }
}

function unsupported(message: string): ImageTransformError {
  return { ok: false, status: 422, error: 'TransformationNotSupported', message }
}

function parsePositiveInteger(value: string | null, name: string): number | undefined | ImageTransformError {
  if (value === null) return undefined
  if (!/^[1-9]\d*$/.test(value)) return invalid(`${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return invalid(`${name} is too large`)
  if (parsed > MAX_TRANSFORM_DIMENSION) return invalid(`${name} must be between 1 and ${MAX_TRANSFORM_DIMENSION}`)
  return parsed
}

function parseQuality(value: string | null): number | undefined | ImageTransformError {
  if (value === null) return undefined
  if (!/^\d+$/.test(value)) return invalid('quality must be an integer between 20 and 100')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 20 || parsed > 100) {
    return invalid('quality must be an integer between 20 and 100')
  }
  return parsed
}

/** Parse Supabase Storage image query parameters without decoding the source. */
export function parseImageTransform(query: URLSearchParams): ImageTransformParseResult {
  const width = parsePositiveInteger(query.get('width'), 'width')
  if (typeof width !== 'number' && width !== undefined) return width
  const height = parsePositiveInteger(query.get('height'), 'height')
  if (typeof height !== 'number' && height !== undefined) return height

  const resizeValue = query.get('resize')
  if (resizeValue === 'cover') return unsupported('resize=cover is not supported by Bun.Image in this runtime')
  if (resizeValue !== null && resizeValue !== 'contain' && resizeValue !== 'fill') {
    return invalid('resize must be one of contain or fill')
  }
  if (resizeValue === null && width !== undefined && height !== undefined) {
    return unsupported('resize defaults to cover when width and height are both set; specify contain or fill')
  }
  const resize: ImageTransformResize = resizeValue ?? 'contain'

  const formatValue = query.get('format')
  const format: ImageTransformFormat = formatValue === null ? 'origin' : (formatValue as ImageTransformFormat)
  if (format !== 'origin' && format !== 'jpeg' && format !== 'png' && format !== 'webp') {
    return invalid('format must be one of origin, jpeg, png, or webp')
  }

  const quality = parseQuality(query.get('quality'))
  if (typeof quality !== 'number' && quality !== undefined) return quality
  if (quality !== undefined && format === 'png') {
    return invalid('quality is supported only for jpeg and webp output')
  }

  return { ok: true, value: { width, height, resize, quality, format } }
}

/** Encode a transform object into the query shape used by render/image URLs. */
export function imageTransformToSearchParams(options?: ImageTransformRequestOptions): URLSearchParams {
  const query = new URLSearchParams()
  if (!options) return query
  if (options.width !== undefined) query.set('width', String(options.width))
  if (options.height !== undefined) query.set('height', String(options.height))
  if (options.resize !== undefined) query.set('resize', options.resize)
  if (options.quality !== undefined) query.set('quality', String(options.quality))
  if (options.format !== undefined) query.set('format', options.format)
  return query
}

function imageErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function mapImageError(error: unknown): ImageTransformError {
  const code = imageErrorCode(error)
  if (code === 'ERR_IMAGE_UNKNOWN_FORMAT' || code === 'ERR_IMAGE_DECODE_FAILED') {
    return {
      ok: false,
      status: 415,
      error: 'UnsupportedMediaType',
      message: 'The object is not a supported image',
    }
  }
  if (code === 'ERR_IMAGE_FORMAT_UNSUPPORTED') {
    return {
      ok: false,
      status: 415,
      error: 'UnsupportedImageFormat',
      message: 'The source or requested image format is not supported by this runtime',
    }
  }
  if (code === 'ERR_IMAGE_TOO_MANY_PIXELS') {
    return {
      ok: false,
      status: 422,
      error: 'ImageTooLarge',
      message: 'The image exceeds the maximum pixel count supported by this runtime',
    }
  }
  return {
    ok: false,
    status: 422,
    error: 'ImageTransformationFailed',
    message: 'The image could not be transformed',
  }
}

function applyResize(image: Bun.Image, metadata: Bun.Image.Metadata, options: ImageTransformOptions): void {
  if (options.width === undefined && options.height === undefined) return
  if (options.width !== undefined && options.height !== undefined) {
    image.resize(options.width, options.height, { fit: options.resize === 'contain' ? 'inside' : 'fill' })
    return
  }
  if (options.width !== undefined) {
    image.resize(options.width)
    return
  }
  const proportionalWidth = Math.max(1, Math.round((metadata.width * options.height!) / metadata.height))
  image.resize(proportionalWidth)
}

/** Decode, resize, and encode an image using the Bun.Image-compatible subset. */
export async function transformImage(bytes: Uint8Array, options: ImageTransformOptions): Promise<ImageTransformResult> {
  if (bytes.byteLength > MAX_TRANSFORM_BYTES) {
    return {
      ok: false,
      status: 413,
      error: 'ImageTooLarge',
      message: 'The source image exceeds the 25MB transformation limit',
    }
  }
  let metadata: Bun.Image.Metadata
  try {
    metadata = await new Bun.Image(bytes, { maxPixels: MAX_TRANSFORM_PIXELS }).metadata()
  } catch (error) {
    return mapImageError(error)
  }

  const outputFormat = options.format === 'origin' ? metadata.format : options.format
  if (options.quality !== undefined && outputFormat !== 'jpeg' && outputFormat !== 'webp') {
    return invalid('quality is supported only for jpeg and webp output')
  }
  const contentType = IMAGE_FORMAT_CONTENT_TYPES[outputFormat]
  if (!contentType) {
    return {
      ok: false,
      status: 415,
      error: 'UnsupportedImageFormat',
      message: `The source format ${outputFormat} is not supported by this runtime`,
    }
  }

  const image = new Bun.Image(bytes, { maxPixels: MAX_TRANSFORM_PIXELS })
  applyResize(image, metadata, options)
  if (options.format === 'jpeg' || (options.format === 'origin' && outputFormat === 'jpeg' && options.quality !== undefined)) {
    image.jpeg(options.quality === undefined ? undefined : { quality: options.quality })
  } else if (options.format === 'png') {
    image.png()
  } else if (options.format === 'webp' || (options.format === 'origin' && outputFormat === 'webp' && options.quality !== undefined)) {
    image.webp(options.quality === undefined ? undefined : { quality: options.quality })
  }

  try {
    return { ok: true, bytes: await image.bytes(), contentType }
  } catch (error) {
    return mapImageError(error)
  }
}
