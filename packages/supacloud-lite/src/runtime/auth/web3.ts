const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const CLOCK_SKEW_SECONDS = 60

export interface SolanaSignInMessage {
  address: string
  domain: string
  uri: string
  issuedAt: number
  expirationTime?: number
  notBefore?: number
  nonce?: string
}

function decodeBase58(value: string): Uint8Array | null {
  if (!value) return null
  const bytes: number[] = []
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character)
    if (digit < 0) return null
    let carry = digit
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index]! * 58
      bytes[index] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let leadingZeros = 0
  while (leadingZeros < value.length && value[leadingZeros] === '1') leadingZeros += 1
  return new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes.reverse()])
}

function encodeBase58(value: Uint8Array): string {
  if (value.length === 0) return ''
  const digits: number[] = []
  for (const byte of value) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index]! * 256
      digits[index] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let leadingZeros = 0
  while (leadingZeros < value.length && value[leadingZeros] === 0) leadingZeros += 1
  return `${'1'.repeat(leadingZeros)}${digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join('')}`
}

function field(lines: string[], name: string): string | undefined {
  const prefix = `${name}: `
  const line = lines.find((entry) => entry.startsWith(prefix))
  return line?.slice(prefix.length)
}

function unixSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? Math.floor(time / 1000) : undefined
}

/** Parse and validate the non-cryptographic part of a Sign in with Solana message. */
export function parseSolanaSignInMessage(message: string): SolanaSignInMessage | null {
  if (!message || message.length > 16_384) return null
  const lines = message.split('\n')
  const header = lines[0]?.match(/^(.+) wants you to sign in with your Solana account:$/)
  const address = lines[1]?.trim()
  const uri = field(lines, 'URI')
  const version = field(lines, 'Version')
  const issuedAt = unixSeconds(field(lines, 'Issued At'))
  if (!header || !address || !uri || version !== '1' || issuedAt === undefined) return null
  const publicKey = decodeBase58(address)
  if (!publicKey || publicKey.length !== 32 || encodeBase58(publicKey) !== address) return null

  let parsedUri: URL
  try {
    parsedUri = new URL(uri)
  } catch {
    return null
  }
  if (parsedUri.host !== header[1]) return null

  const expirationTime = unixSeconds(field(lines, 'Expiration Time'))
  const notBefore = unixSeconds(field(lines, 'Not Before'))
  if (field(lines, 'Expiration Time') && expirationTime === undefined) return null
  if (field(lines, 'Not Before') && notBefore === undefined) return null

  const now = Math.floor(Date.now() / 1000)
  if (issuedAt > now + CLOCK_SKEW_SECONDS) return null
  if (expirationTime !== undefined && expirationTime <= now) return null
  if (notBefore !== undefined && notBefore > now + CLOCK_SKEW_SECONDS) return null

  return {
    address,
    domain: header[1]!,
    uri,
    issuedAt,
    ...(expirationTime === undefined ? {} : { expirationTime }),
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(field(lines, 'Nonce') === undefined ? {} : { nonce: field(lines, 'Nonce') }),
  }
}

/** Verify an auth-js Sign in with Solana payload and return its wallet address. */
export async function verifySolanaSignIn(message: string, signature: string): Promise<SolanaSignInMessage | null> {
  const parsed = parseSolanaSignInMessage(message)
  if (!parsed) return null
  const publicKey = decodeBase58(parsed.address)
  if (!publicKey) return null

  let signatureBytes: Uint8Array
  try {
    const normalized = signature.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    signatureBytes = Uint8Array.from(Buffer.from(padded, 'base64'))
  } catch {
    return null
  }
  if (signatureBytes.length !== 64) return null

  try {
    const publicKeyBuffer = Uint8Array.from(publicKey).buffer as ArrayBuffer
    const signatureBuffer = Uint8Array.from(signatureBytes).buffer as ArrayBuffer
    const messageBuffer = new TextEncoder().encode(message).buffer as ArrayBuffer
    const key = await crypto.subtle.importKey('raw', publicKeyBuffer, 'Ed25519', false, ['verify'])
    const valid = await crypto.subtle.verify(
      'Ed25519',
      key,
      signatureBuffer,
      messageBuffer,
    )
    return valid ? parsed : null
  } catch {
    return null
  }
}
