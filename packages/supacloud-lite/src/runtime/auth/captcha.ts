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
  svg: string
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

function randomSignedOffset(): number {
  const byte = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0
  return (byte % 17) - 8
}

export function createCaptchaChallenge(): CaptchaChallenge {
  const answer = randomAnswer()
  const id = crypto.randomUUID()
  const characters = [...answer].map((character, index) => {
    const x = 18 + index * 34
    const y = 11
    const rotation = randomSignedOffset()
    const glyph = CAPTCHA_GLYPHS[character] ?? CAPTCHA_GLYPHS['2']
    const pixels = glyph.flatMap((row, rowIndex) => [...row].flatMap((pixel, columnIndex) => (
      pixel === '1'
        ? [`<rect x="${x + columnIndex * 4}" y="${y + rowIndex * 4}" width="3" height="3"/>`]
        : []
    ))).join('')
    return `<g class="captcha-glyph" transform="rotate(${rotation} ${x + 10} ${y + 14})">${pixels}</g>`
  }).join('')
  const lines = Array.from({ length: 6 }, (_, index) => {
    const y = 12 + index * 9
    const end = 20 + (index * 29) % 120
    return `<path d="M${index * 31},${y} C${end},${y - 8} ${70 + index * 12},${y + 15} 178,${y + 2}" />`
  }).join('')
  const dots = Array.from({ length: 24 }, (_, index) => {
    const x = 8 + (index * 47) % 178
    const y = 8 + (index * 23) % 46
    return `<circle cx="${x}" cy="${y}" r="${index % 3 === 0 ? 1.5 : 1}" />`
  }).join('')
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="190" height="56" viewBox="0 0 190 56" role="img" aria-label="CAPTCHA">',
    '<rect width="190" height="56" rx="6" fill="#f8fafc"/>',
    `<g fill="none" stroke="#94a3b8" stroke-width="1" opacity=".65">${lines}</g>`,
    `<g fill="#334155" opacity=".45">${dots}</g>`,
    `<g fill="#0f172a">${characters}</g>`,
    '</svg>',
  ].join('')
  return { id, answer, svg }
}

export function captchaImageDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function parseCaptchaToken(token: string): { id: string; answer: string } | null {
  const separator = token.indexOf('.')
  if (separator <= 0 || separator === token.length - 1) return null
  const id = token.slice(0, separator)
  const answer = token.slice(separator + 1).trim().toUpperCase()
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/.test(answer)) return null
  return { id, answer }
}
