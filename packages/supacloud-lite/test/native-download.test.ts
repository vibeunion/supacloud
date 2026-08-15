import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as createTar } from 'tar'
import {
  ensurePostgres,
  isNativeEngineSupported,
  resolvePostgresDownloadUrl,
} from '../src/runtime/node/native/engine.js'

const temporaryDirectories: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
const originalMirror = process.env.SUPACLOUD_LITE_POSTGRES_MIRROR

afterEach(async () => {
  if (originalMirror === undefined) delete process.env.SUPACLOUD_LITE_POSTGRES_MIRROR
  else process.env.SUPACLOUD_LITE_POSTGRES_MIRROR = originalMirror
  for (const server of servers.splice(0)) server.stop(true)
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('native PostgreSQL download mirror', () => {
  test('keeps the default URL and validates mirror prefixes without reflecting credentials', () => {
    const upstream = 'https://github.com/theseus-rs/postgresql-binaries/releases/download/17.7.0/archive.tar.gz'
    expect(resolvePostgresDownloadUrl(upstream, '')).toBe(upstream)
    expect(resolvePostgresDownloadUrl(upstream, 'https://mirror.example/proxy/')).toBe(
      `https://mirror.example/proxy/${upstream}`
    )
    expect(() => resolvePostgresDownloadUrl(upstream, 'http://mirror.example')).toThrow(
      'must be an absolute HTTPS URL or a loopback HTTP URL'
    )
    expect(() => resolvePostgresDownloadUrl(upstream, 'https://user:secret@mirror.example')).toThrow(
      'must not contain credentials'
    )
    expect(() => resolvePostgresDownloadUrl(upstream, 'https://mirror.example/?token=secret')).toThrow(
      'must not contain a query or fragment'
    )
    expect(() => resolvePostgresDownloadUrl(upstream, 'https://mirror.example/?')).toThrow(
      'must not contain a query or fragment'
    )
    expect(() => resolvePostgresDownloadUrl(upstream, 'https://mirror.example/#')).toThrow(
      'must not contain a query or fragment'
    )
  })

  test.skipIf(!isNativeEngineSupported())(
    'retries a mirrored archive and fetches its checksum through the same mirror',
    async () => {
      const testRoot = await mkdtemp(join(tmpdir(), 'supacloud-lite-native-download-'))
      temporaryDirectories.push(testRoot)
      const archivePayload = join(testRoot, 'payload', 'postgresql')
      await mkdir(join(archivePayload, 'bin'), { recursive: true })
      await mkdir(join(archivePayload, 'share'), { recursive: true })
      await writeFile(join(archivePayload, 'bin', 'postgres'), 'fixture')
      await writeFile(join(archivePayload, 'share', 'postgres.bki'), 'fixture')
      const archive = join(testRoot, 'postgres.tar.gz')
      await createTar({ cwd: join(testRoot, 'payload'), file: archive, gzip: true }, ['postgresql'])
      const archiveBytes = await readFile(archive)
      const digest = createHash('sha256').update(archiveBytes).digest('hex')
      let archiveAttempts = 0
      let checksumRequests = 0
      const mirrorServer = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
          const requestPath = new URL(request.url).pathname
          if (requestPath.endsWith('.tar.gz.sha256')) {
            checksumRequests += 1
            return new Response(`${digest}  postgres.tar.gz\n`)
          }
          if (requestPath.endsWith('.tar.gz')) {
            archiveAttempts += 1
            return archiveAttempts < 3 ? new Response('retry', { status: 503 }) : new Response(archiveBytes)
          }
          return new Response('not found', { status: 404 })
        },
      })
      servers.push(mirrorServer)
      process.env.SUPACLOUD_LITE_POSTGRES_MIRROR = `http://127.0.0.1:${mirrorServer.port}`

      const installed = await ensurePostgres('99.0.0', join(testRoot, 'cache'))

      expect(await readFile(join(installed, 'bin', 'postgres'), 'utf8')).toBe('fixture')
      expect(await readFile(join(installed, 'share', 'postgres.bki'), 'utf8')).toBe('fixture')
      expect(archiveAttempts).toBe(3)
      expect(checksumRequests).toBe(1)
    },
  )
})
