/** Bun bcrypt hashing with PBKDF2 verification retained for pre-release Lite databases. */

const ITERATIONS = 100_000

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256
  )
  return new Uint8Array(bits)
}

/** Hash a password using bcrypt so imported GoTrue-compatible password rows remain usable. */
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 })
}

/**
 * Verify a password against a stored `pbkdf2$…` hash, re-deriving with the
 * salt/iterations embedded in it. Returns false for any malformed hash.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (/^\$2[aby]\$/.test(stored)) {
    try {
      return await Bun.password.verify(password, stored)
    } catch {
      return false
    }
  }
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = parseInt(parts[1], 10)
  const salt = fromHex(parts[2])
  const expected = parts[3]
  const hash = await derive(password, salt, iterations)
  const actual = toHex(hash)
  if (actual.length !== expected.length) return false
  // SECURITY: constant-time compare over the full hash to avoid leaking a
  // match prefix via timing.
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}
