import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveS3EndpointOptions } from '../src/project-runtime.js'
import { testTimeout } from './helpers/timeouts.js'

const cliPath = resolve(import.meta.dir, '../src/cli.ts')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function projectDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'supacloud-lite-s3-endpoint-cli-'))
  temporaryDirectories.push(directory)
  return directory
}

async function runCli(
  directory: string,
  command: string[],
  options: { stdin?: string; env?: Record<string, string | undefined> } = {},
) {
  const bunExecutable = Bun.which('bun')
  if (!bunExecutable) throw new Error('Bun is required to run the Lite CLI test')
  const cliProcess = Bun.spawn({
    cmd: [bunExecutable, cliPath, ...command, '--project-dir', directory],
    cwd: directory,
    env: { ...isolatedEnvironment(), ...options.env },
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    cliProcess.exited,
    new Response(cliProcess.stdout).text(),
    new Response(cliProcess.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function isolatedEnvironment(): Record<string, string | undefined> {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (name.startsWith('SUPACLOUD_LITE_S3_ENDPOINT_')) delete environment[name]
  }
  delete environment.SUPACLOUD_LITE_STORAGE_BACKEND
  return environment
}

describe('inbound S3-compatible endpoint CLI surface', () => {
  test('flags override the environment and require a complete key pair', () => {
    const environment = {
      SUPACLOUD_LITE_S3_ENDPOINT_ACCESS_KEY_ID: 'env-access',
      SUPACLOUD_LITE_S3_ENDPOINT_SECRET_ACCESS_KEY: 'env-secret',
      SUPACLOUD_LITE_S3_ENDPOINT_REGION: 'eu-west-1',
    }
    expect(resolveS3EndpointOptions(environment)).toEqual({
      accessKeyId: 'env-access',
      secretAccessKey: 'env-secret',
      region: 'eu-west-1',
    })
    expect(resolveS3EndpointOptions(environment, {
      accessKeyId: 'flag-access',
      bucketScope: ['tasks'],
      region: 'ap-east-1',
    })).toEqual({
      accessKeyId: 'flag-access',
      secretAccessKey: 'env-secret',
      region: 'ap-east-1',
      bucketScope: ['tasks'],
    })
    expect(() => resolveS3EndpointOptions({}, { accessKeyId: 'only-access' })).toThrow(
      'SUPACLOUD_LITE_S3_ENDPOINT_ACCESS_KEY_ID and SUPACLOUD_LITE_S3_ENDPOINT_SECRET_ACCESS_KEY must be set together',
    )
    expect(resolveS3EndpointOptions({})).toBeUndefined()
  })

  test('doctor reports the endpoint without leaking the secret', async () => {
    const directory = await projectDir()
    const doctor = await runCli(directory, [
      'doctor', '--json', '--s3-endpoint', '--s3-endpoint-region', 'ap-east-1',
      '--s3-endpoint-buckets', 'fa-task-inputs,fa-artifacts',
    ])
    expect(doctor.exitCode).toBe(0)
    expect(doctor.stderr).toBe('')
    const report = JSON.parse(doctor.stdout) as {
      s3_endpoint: { status: string; region: string; buckets: string[] }
    }
    expect(report.s3_endpoint).toEqual({
      status: 'enabled',
      region: 'ap-east-1',
      buckets: ['fa-task-inputs', 'fa-artifacts'],
    })
    expect(doctor.stdout).not.toContain('secret')
  }, testTimeout(30_000))

  test('doctor keeps the endpoint disabled when no flag or environment enables it', async () => {
    const directory = await projectDir()
    const doctor = await runCli(directory, ['doctor', '--json'])
    expect(doctor.exitCode).toBe(0)
    expect((JSON.parse(doctor.stdout) as { s3_endpoint: unknown }).s3_endpoint).toEqual({
      status: 'disabled',
      region: 'us-east-1',
      buckets: [],
    })
  }, testTimeout(30_000))

  test('rejects an incomplete key pair and an empty stdin secret', async () => {
    const directory = await projectDir()
    const incomplete = await runCli(directory, [
      'doctor', '--json', '--s3-endpoint-access-key-id', 'only-access',
    ])
    expect(incomplete.exitCode).not.toBe(0)
    expect(incomplete.stderr).toContain('must be set together')

    const emptySecret = await runCli(directory, [
      'start', '--s3-endpoint-access-key-id', 'access', '--s3-endpoint-secret-access-key-stdin',
    ])
    expect(emptySecret.exitCode).not.toBe(0)
    expect(emptySecret.stderr).toContain('received an empty secret')
  }, testTimeout(30_000))

  test('prints the generated secret exactly once and never in doctor output', async () => {
    const directory = await projectDir()
    const server = Bun.spawn({
      cmd: [Bun.which('bun')!, cliPath, 'start', '--memory', '--port', '0', '--s3-endpoint', '--project-dir', directory],
      cwd: directory,
      env: isolatedEnvironment(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const banner = await readBanner(server)
      const secret = /Generated S3 secret access key[^\n]*\n\s+([0-9a-f]{48})/.exec(banner)?.[1]
      expect(secret).toBeTruthy()
      expect(banner.split(secret!).length - 1).toBe(1)
      expect(banner).toContain('S3 endpoint:')
      expect(banner).toContain('/storage/v1/s3')
      expect(banner).toContain('access key lite-')
    } finally {
      server.kill()
      await server.exited
    }

    const doctor = await runCli(directory, ['doctor', '--json', '--s3-endpoint'], { env: { SUPACLOUD_LITE_S3_ENDPOINT_REGION: 'eu-central-1' } })
    expect(doctor.exitCode).toBe(0)
    expect((JSON.parse(doctor.stdout) as { s3_endpoint: { status: string; region: string; buckets: string[] } }).s3_endpoint)
      .toEqual({ status: 'enabled', region: 'eu-central-1', buckets: [] })
    expect(doctor.stdout).not.toContain('secret')
  }, testTimeout(60_000))

  test('serves S3-compatible requests when credentials come only from the environment', async () => {
    const directory = await projectDir()
    const accessKeyId = 'env-access'
    const secretAccessKey = 'env-secret-value'
    const server = Bun.spawn({
      cmd: [Bun.which('bun')!, cliPath, 'start', '--memory', '--port', '0', '--project-dir', directory],
      cwd: directory,
      env: {
        ...isolatedEnvironment(),
        SUPACLOUD_LITE_S3_ENDPOINT_ACCESS_KEY_ID: accessKeyId,
        SUPACLOUD_LITE_S3_ENDPOINT_SECRET_ACCESS_KEY: secretAccessKey,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const banner = await readBanner(server)
      const url = /API URL: (http:\/\/\S+)/.exec(banner)?.[1]
      expect(url).toBeTruthy()
      // 环境变量模式不生成凭据，因此不会打印一次性 secret。
      expect(banner).not.toContain('Generated S3 secret access key')
      const response = await signedRequest(`${url}/storage/v1/s3`, 'GET', '/', new Uint8Array(), accessKeyId, secretAccessKey)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('<ListAllMyBucketsResult')
    } finally {
      server.kill()
      await server.exited
    }
  }, testTimeout(60_000))

  test('serves S3-compatible requests signed with the CLI-provided credentials', async () => {
    const directory = await projectDir()
    const accessKeyId = 'cli-access'
    const secretAccessKey = 'cli-secret-value'
    const server = Bun.spawn({
      cmd: [
        Bun.which('bun')!, cliPath, 'start', '--memory', '--port', '0',
        '--s3-endpoint-access-key-id', accessKeyId,
        '--s3-endpoint-secret-access-key-stdin', '--s3-endpoint-region', 'us-east-1',
        '--project-dir', directory,
      ],
      cwd: directory,
      env: isolatedEnvironment(),
      stdin: new TextEncoder().encode(`${secretAccessKey}\n`),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const url = await readStartedUrl(server)
      expect(url).not.toBeNull()
      const endpoint = `${url}/storage/v1/s3`
      const response = await signedRequest(endpoint, 'GET', '/', new Uint8Array(), accessKeyId, secretAccessKey)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('<ListAllMyBucketsResult')
    } finally {
      server.kill()
      await server.exited
    }
  }, testTimeout(60_000))
})

async function readBanner(server: ReturnType<typeof Bun.spawn>): Promise<string> {
  const deadline = Date.now() + 45_000
  let buffered = ''
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    if (/services: disabled|Run "supacloud-lite keys"/.test(buffered)) return buffered
  }
  return buffered
}

async function readStartedUrl(server: ReturnType<typeof Bun.spawn>): Promise<string | null> {
  const deadline = Date.now() + 45_000
  let buffered = ''
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const match = /API URL: (http:\/\/\S+)/.exec(buffered)
    if (match) return match[1]!
  }
  return null
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function signedRequest(
  endpoint: string,
  method: string,
  path: string,
  body: Uint8Array,
  accessKeyId: string,
  secretAccessKey: string,
): Promise<Response> {
  const url = new URL(`${endpoint}${path}`)
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const dateStamp = amzDate.slice(0, 8)
  const region = 'us-east-1'
  const payloadHash = sha256(body)
  const host = url.host
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalUri = url.pathname.split('/').map((part) => encode(decodeURIComponent(part))).join('/')
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${region}/s3/aws4_request`
  const signingKey = [dateStamp, region, 's3', 'aws4_request'].reduce<Buffer | string>(
    (key, part) => createHmac('sha256', key).update(part).digest(),
    `AWS4${secretAccessKey}`,
  )
  const signature = createHmac('sha256', signingKey)
    .update(`AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`)
    .digest('hex')
  return fetch(url, {
    method,
    headers: {
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  })
}