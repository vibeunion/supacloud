import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'
import { verifyJwt } from '../src/runtime/jwt.js'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const JWT_SECRET = 'web3-auth-secret'.repeat(4)

function base58(value: Uint8Array): string {
  const digits = [0]
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
  return `${'1'.repeat(leadingZeros)}${digits.reverse().map((digit) => ALPHABET[digit]).join('')}`
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

describe('Web3 auth compatibility', () => {
  let db: Database
  let auth: AuthHandler
  let privateKey: CryptoKey
  let address: string

  beforeAll(async () => {
    db = await Database.create()
    const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
    privateKey = keys.privateKey
    const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
    address = base58(Buffer.from(publicJwk.x!, 'base64url'))
    auth = new AuthHandler(db, {
      jwtSecret: JWT_SECRET,
      apiUrl: 'https://lite.example.test',
      siteUrl: 'https://app.example.test',
      jwtExpiry: 3600,
      mailer: new InboxMailer(),
      rateLimiter: null,
    })
  })

  afterAll(async () => {
    await auth.stop()
    await db.close()
  })

  async function request(message: string, signature: string): Promise<Response> {
    const url = new URL('https://lite.example.test/auth/v1/token?grant_type=web3')
    return auth.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'solana', message, signature }),
    }), { role: 'anon', claims: null }, url)
  }

  async function signedMessage(overrides: string[] = []): Promise<{ message: string; signature: string }> {
    const message = [
      'lite.example.test wants you to sign in with your Solana account:',
      address,
      '',
      'Sign in to SupaCloud Lite',
      '',
      'Version: 1',
      'URI: https://lite.example.test/login',
      `Issued At: ${new Date().toISOString()}`,
      ...overrides,
    ].join('\n')
    const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(message)))
    return { message, signature: base64url(signature) }
  }

  test('verifies a SIWS signature and creates a session', async () => {
    const response = await request(...Object.values(await signedMessage()) as [string, string])
    expect(response.status).toBe(200)
    const body = await response.json() as { access_token: string; user: { identities: Array<{ provider: string; id: string }> } }
    expect(body.user.identities).toEqual([expect.objectContaining({ provider: 'solana', id: address })])
    expect(await verifyJwt(body.access_token, JWT_SECRET)).toMatchObject({
      amr: [{ method: 'web3', timestamp: expect.any(Number) }],
    })
  })

  test('rejects forged and expired SIWS credentials', async () => {
    const valid = await signedMessage()
    const forged = base64url(new Uint8Array(await crypto.subtle.sign(
      'Ed25519',
      privateKey,
      new TextEncoder().encode(`${valid.message}!`),
    )))
    expect((await request(valid.message, forged)).status).toBe(400)

    const expired = await signedMessage([`Expiration Time: ${new Date(Date.now() - 60_000).toISOString()}`])
    expect((await request(expired.message, expired.signature)).status).toBe(400)
  })

  test('rejects non-canonical Solana addresses', async () => {
    const nonCanonicalAddress = `1${address}`
    const message = [
      'lite.example.test wants you to sign in with your Solana account:',
      nonCanonicalAddress,
      '',
      'Version: 1',
      'URI: https://lite.example.test/login',
      `Issued At: ${new Date().toISOString()}`,
    ].join('\n')
    const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(message)))
    expect((await request(message, base64url(signature))).status).toBe(400)
  })
})
