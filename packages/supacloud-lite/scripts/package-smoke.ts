import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }

const packageDir = resolve(import.meta.dir, '..')
const packDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-pack-'))
const consumerDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-consumer-'))

try {
  const packOutput = await run(npmPackCommand(packDir), packageDir)
  const jsonStart = packOutput.lastIndexOf('[\n  {')
  if (jsonStart === -1) throw new Error(`npm pack did not emit JSON:\n${packOutput}`)
  const packed = JSON.parse(packOutput.slice(jsonStart)) as {
    filename: string
  }[]
  const archive = join(packDir, packed[0]!.filename)
  await writeFile(
    join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'supacloud-lite-consumer', private: true, type: 'module' })
  )
  await run(['bun', 'add', archive], consumerDir)
  await run(['bun', 'add', '--dev', 'typescript@5.9.3'], consumerDir)
  const installedCli = join(consumerDir, 'node_modules', '@supacloud', 'lite', 'dist', 'cli.js')
  const version = (await run([process.execPath, installedCli, 'version'], consumerDir)).trim()
  if (version !== packageJson.version) throw new Error(`unexpected CLI version: ${version}`)

  const smokePath = join(consumerDir, 'smoke.ts')
  await writeFile(
    smokePath,
    `import { createLiteBackend, SUPACLOUD_LITE_VERSION } from '@supacloud/lite'
const backend = await createLiteBackend({ jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), log: () => {} })
const response = await backend.fetch(new Request('http://local/health'))
const body = await response.json()
if (body.name !== 'supacloud-lite') throw new Error(JSON.stringify(body))
if (SUPACLOUD_LITE_VERSION !== '${packageJson.version}') throw new Error('version mismatch')
await backend.close()
console.log('package-smoke-ok')
`
  )
  await writeFile(
    join(consumerDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        lib: ['ES2022', 'DOM'],
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: false,
        types: [],
        noEmit: true,
      },
      include: ['smoke.ts'],
    })
  )
  await run(['bunx', 'tsc', '--noEmit', '-p', 'tsconfig.json'], consumerDir)
  process.stdout.write(await run(['bun', 'run', smokePath], consumerDir))
} finally {
  await Promise.all([
    rm(packDir, { recursive: true, force: true }),
    rm(consumerDir, { recursive: true, force: true }),
  ])
}

function npmPackCommand(packDir: string): string[] {
  const args = ['pack', '--json', '--pack-destination', packDir]
  if (process.platform !== 'win32') return ['npm', ...args]

  const node = Bun.which('node')
  const npm = Bun.which('npm')
  if (!node || !npm) throw new Error('Windows package smoke requires node and npm on PATH')
  return [node, join(dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args]
}

async function run(command: string[], cwd: string): Promise<string> {
  const processHandle = Bun.spawn({ cmd: command, cwd, stdout: 'pipe', stderr: 'pipe', env: process.env })
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`${command.join(' ')} failed (${exitCode})\n${stdout}\n${stderr}`)
  return stdout
}
