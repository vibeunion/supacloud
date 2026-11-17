export const CAPTCHA_GLYPHS: Record<string, readonly string[]> = {
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  J: ['00001', '00001', '00001', '00001', '10001', '10001', '01110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
}

const CAPTCHA_ALPHABET = Object.keys(CAPTCHA_GLYPHS).join('')

export type CaptchaChallenge = {
  id: string
  answer: string
  image: string
}

function randomAnswer(length = 5): string {
  let answer = ''
  while (answer.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2))
    for (const byte of bytes) {
      if (byte >= 240) continue
      answer += CAPTCHA_ALPHABET[byte % CAPTCHA_ALPHABET.length]
      if (answer.length === length) return answer
    }
  }
  return answer
}

function randomRange(min: number, max: number): number {
  const byte = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0
  return min + (byte % (max - min + 1))
}

function setPixel(pixels: Uint8Array, width: number, x: number, y: number, color: readonly [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= width || y >= pixels.length / (width * 4)) return
  const offset = (y * width + x) * 4
  pixels[offset] = color[0]
  pixels[offset + 1] = color[1]
  pixels[offset + 2] = color[2]
  pixels[offset + 3] = color[3]
}

function drawRect(
  pixels: Uint8Array,
  width: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  color: readonly [number, number, number, number],
): void {
  for (let row = 0; row < rectHeight; row += 1) {
    for (let column = 0; column < rectWidth; column += 1) {
      setPixel(pixels, width, x + column, y + row, color)
    }
  }
}

function drawLine(
  pixels: Uint8Array,
  width: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  color: readonly [number, number, number, number],
): void {
  const distance = Math.max(Math.abs(endX - startX), Math.abs(endY - startY))
  for (let step = 0; step <= distance; step += 1) {
    const progress = distance === 0 ? 0 : step / distance
    setPixel(
      pixels,
      width,
      Math.round(startX + (endX - startX) * progress),
      Math.round(startY + (endY - startY) * progress),
      color,
    )
  }
}

function adler32(bytes: Uint8Array): number {
  let sumA = 1
  let sumB = 0
  for (const byte of bytes) {
    sumA = (sumA + byte) % 65521
    sumB = (sumB + sumA) % 65521
  }
  return ((sumB << 16) | sumA) >>> 0
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0)))
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = ascii(type)
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes)
  body.set(data, typeBytes.length)
  const result = new Uint8Array(12 + data.length)
  const view = new DataView(result.buffer)
  view.setUint32(0, data.length)
  result.set(body, 4)
  view.setUint32(8 + data.length, crc32(body))
  return result
}

function zlibStore(bytes: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = []
  let offset = 0
  do {
    const length = Math.min(65_535, bytes.length - offset)
    const block = new Uint8Array(5 + length)
    block[0] = offset + length >= bytes.length ? 1 : 0
    block[1] = length & 0xff
    block[2] = length >>> 8
    block[3] = (~length) & 0xff
    block[4] = (~length) >>> 8
    block.set(bytes.subarray(offset, offset + length), 5)
    blocks.push(block)
    offset += length
  } while (offset < bytes.length)
  const result = new Uint8Array(2 + blocks.reduce((total, block) => total + block.length, 0) + 4)
  result[0] = 0x78
  result[1] = 0x01
  let cursor = 2
  for (const block of blocks) {
    result.set(block, cursor)
    cursor += block.length
  }
  new DataView(result.buffer).setUint32(cursor, adler32(bytes))
  return result
}

function encodePng(width: number, height: number, pixels: Uint8Array): string {
  const scanlines = new Uint8Array(height * (width * 4 + 1))
  for (let row = 0; row < height; row += 1) {
    const sourceStart = row * width * 4
    const targetStart = row * (width * 4 + 1)
    scanlines[targetStart] = 0
    scanlines.set(pixels.subarray(sourceStart, sourceStart + width * 4), targetStart + 1)
  }
  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width)
  headerView.setUint32(4, height)
  header[8] = 8
  header[9] = 6
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const bytes = [signature, pngChunk('IHDR', header), pngChunk('IDAT', zlibStore(scanlines)), pngChunk('IEND', new Uint8Array())]
  const output = new Uint8Array(bytes.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of bytes) {
    output.set(part, offset)
    offset += part.length
  }
  let binary = ''
  for (const byte of output) binary += String.fromCharCode(byte)
  return `data:image/png;base64,${btoa(binary)}`
}

function renderCaptcha(answer: string): string {
  const width = 190
  const height = 56
  const pixels = new Uint8Array(width * height * 4)
  const background: readonly [number, number, number, number] = [248, 250, 252, 255]
  const noise: readonly [number, number, number, number] = [148, 163, 184, 120]
  const dot: readonly [number, number, number, number] = [51, 65, 85, 105]
  const foreground: readonly [number, number, number, number] = [15, 23, 42, 255]
  for (let row = 0; row < height; row += 1) drawRect(pixels, width, 0, row, width, 1, background)
  for (let index = 0; index < 7; index += 1) {
    drawLine(pixels, width, randomRange(0, 30), randomRange(5, 50), randomRange(160, 189), randomRange(5, 50), noise)
  }
  for (let index = 0; index < 32; index += 1) {
    drawRect(pixels, width, randomRange(3, 186), randomRange(4, 51), randomRange(1, 2), randomRange(1, 2), dot)
  }
  for (const [index, character] of [...answer].entries()) {
    const glyph = CAPTCHA_GLYPHS[character] ?? CAPTCHA_GLYPHS['2']
    const originX = 15 + index * 35
    const originY = 10
    const cellSize = 3
    for (const [rowIndex, row] of glyph.entries()) {
      for (const [columnIndex, pixel] of [...row].entries()) {
        if (pixel !== '1') continue
        drawRect(
          pixels,
          width,
          Math.round(originX + columnIndex * (cellSize + 1)),
          Math.round(originY + rowIndex * (cellSize + 1)),
          cellSize,
          cellSize,
          foreground,
        )
      }
    }
  }
  return encodePng(width, height, pixels)
}

export function createCaptchaChallenge(): CaptchaChallenge {
  const answer = randomAnswer()
  return { id: crypto.randomUUID(), answer, image: renderCaptcha(answer) }
}

export function parseCaptchaToken(token: string): { id: string; answer: string } | null {
  const separator = token.indexOf('.')
  if (separator <= 0 || separator === token.length - 1) return null
  const id = token.slice(0, separator)
  const answer = token.slice(separator + 1).trim().toUpperCase()
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/.test(answer)) return null
  return { id, answer }
}
