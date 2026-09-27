import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }

const packageDir = resolve(import.meta.dir, '..')
const packDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-pack-'))
const consumerDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-consumer-'))
const noBunPath = await mkdtemp(join(tmpdir(), 'supacloud-lite-no-bun-'))

try {
  if (packageJson.bin['supacloud-lite'] !== 'dist/launcher.cjs') {
    throw new Error('package bin must point to the Node launcher')
  }
  await access(join(packageDir, 'dist', 'cli.js'))
  await access(join(packageDir, 'dist', 'launcher.cjs'))

  const packOutput = await runCommand(npmPackCommand(packDir), packageDir)
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
  await runCommand(npmCommand(['install', '--ignore-scripts', '--no-audit', '--no-fund', archive]), consumerDir)
  await runCommand(npmCommand(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', 'typescript@5.9.3']), consumerDir)
  const installedPackage = join(consumerDir, 'node_modules', '@supacloud', 'lite', 'dist')
  const installedCli = join(installedPackage, 'cli.js')
  const installedLauncher = join(installedPackage, 'launcher.cjs')
  await access(installedCli)
  await access(installedLauncher)
  const version = (await runCommand(npxCommand(['--no-install', 'supacloud-lite', 'version']), consumerDir)).trim()
  if (version !== packageJson.version) throw new Error(`unexpected CLI version: ${version}`)
  const noBunEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: noBunPath,
  }
  if (process.platform === 'win32') noBunEnvironment['Path'] = noBunPath
  const missingBunOutput = await runCommandExpectingFailure([process.execPath, installedLauncher, 'version'], consumerDir, noBunEnvironment)
  if (!missingBunOutput.includes('Bun executable not found on PATH')) {
    throw new Error(`launcher did not explain a missing Bun executable:\n${missingBunOutput}`)
  }

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
  const installedTsc = join(consumerDir, 'node_modules', 'typescript', 'bin', 'tsc')
  await runCommand([process.execPath, installedTsc, '--noEmit', '-p', 'tsconfig.json'], consumerDir)
  process.stdout.write(await runCommand(['bun', 'run', smokePath], consumerDir))
} finally {
  await Promise.all([
    rm(packDir, { recursive: true, force: true }),
    rm(consumerDir, { recursive: true, force: true }),
    rm(noBunPath, { recursive: true, force: true }),
  ])
}

function npmPackCommand(packDir: string): string[] {
  return npmCommand(['pack', '--json', '--pack-destination', packDir])
}

function npmCommand(args: string[]): string[] {
  if (process.platform !== 'win32') return ['npm', ...args]
  return npmCliCommand('npm-cli.js', args)
}

function npxCommand(args: string[]): string[] {
  if (process.platform !== 'win32') return ['npx', ...args]
  return npmCliCommand('npx-cli.js', args)
}

function npmCliCommand(script: string, args: string[]): string[] {
  const node = Bun.which('node')
  const npm = Bun.which('npm')
  if (!node || !npm) throw new Error('Windows package smoke requires node and npm on PATH')
  return [node, join(dirname(npm), 'node_modules', 'npm', 'bin', script), ...args]
}

async function runCommand(command: string[], cwd: string, env = process.env): Promise<string> {
  const execution = await executeCommand(command, cwd, env)
  if (execution.exitCode !== 0) throw new Error(`${command.join(' ')} failed (${execution.exitCode})\n${execution.stdout}\n${execution.stderr}`)
  return execution.stdout
}

async function runCommandExpectingFailure(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const execution = await executeCommand(command, cwd, env)
  if (execution.exitCode === 0) throw new Error(`${command.join(' ')} unexpectedly succeeded`)
  return `${execution.stdout}\n${execution.stderr}`
}

async function executeCommand(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandExecution> {
  const processHandle = Bun.spawn({ cmd: command, cwd, stdout: 'pipe', stderr: 'pipe', env })
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

interface CommandExecution {
  exitCode: number
  stdout: string
  stderr: string
}
