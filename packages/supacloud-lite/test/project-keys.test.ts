import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createProjectBackend } from '../src/project-runtime.js'
import { withWindowsSubprocessRef } from '../scripts/subprocess.js'

const cliPath = resolve(import.meta.dir, '../src/cli.ts')

interface ProjectKeys {
  anonKey: string
  serviceRoleKey: string
}

test('keeps CLI and runtime keys stable for one project across restarts', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-stable-keys-'))
  try {
    const cliKeys = await readCliKeys(projectDir)
    await Bun.sleep(2_100)
    const firstRuntimeKeys = await readRuntimeKeys(projectDir)
    expect(cliKeys.anonKey === firstRuntimeKeys.anonKey).toBe(true)
    expect(cliKeys.serviceRoleKey === firstRuntimeKeys.serviceRoleKey).toBe(true)

    await Bun.sleep(2_100)
    const restartedRuntimeKeys = await readRuntimeKeys(projectDir)
    expect(firstRuntimeKeys.anonKey === restartedRuntimeKeys.anonKey).toBe(true)
    expect(firstRuntimeKeys.serviceRoleKey === restartedRuntimeKeys.serviceRoleKey).toBe(true)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
}, 30_000)

async function readCliKeys(projectDir: string): Promise<ProjectKeys> {
  const bunExecutable = Bun.which('bun')
  if (!bunExecutable) throw new Error('Bun is required to run the Lite CLI test')
  const cliProcess = Bun.spawn({
    cmd: [bunExecutable, cliPath, 'keys', '--service-role', '--project-dir', projectDir],
    cwd: projectDir,
    env: withoutProjectRuntimeOverrides(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, standardOutput, standardError] = await withWindowsSubprocessRef(() => Promise.all([
    cliProcess.exited,
    new Response(cliProcess.stdout).text(),
    new Response(cliProcess.stderr).text(),
  ]))
  expect(exitCode).toBe(0)
  expect(standardError).toBe('')
  return parseProjectKeys(standardOutput)
}

async function readRuntimeKeys(projectDir: string): Promise<ProjectKeys> {
  const project = await createProjectBackend({
    projectDir,
    ...isolatedProjectRuntimePaths(projectDir),
    includeFunctions: false,
    includeWebhooks: false,
    startRuntimeServices: false,
  })
  try {
    return { anonKey: project.backend.anonKey, serviceRoleKey: project.backend.serviceRoleKey }
  } finally {
    await project.backend.close()
  }
}

function isolatedProjectRuntimePaths(projectDir: string): { stateDir: string; dataDir: string; storageDir: string } {
  const stateDir = join(projectDir, '.supacloud-lite')
  return { stateDir, dataDir: join(stateDir, 'db'), storageDir: join(stateDir, 'storage') }
}

function parseProjectKeys(standardOutput: string): ProjectKeys {
  const anonKey = standardOutput.match(/anon key:\n([^\n]+)/)?.[1]
  const serviceRoleKey = standardOutput.match(/service_role key:\n([^\n]+)/)?.[1]
  if (!anonKey || !serviceRoleKey) throw new Error('Lite CLI did not return both project key labels')
  return { anonKey, serviceRoleKey }
}

function withoutProjectRuntimeOverrides(): Record<string, string | undefined> {
  const environment = { ...process.env }
  delete environment.SUPACLOUD_LITE_JWT_SECRET
  delete environment.SUPACLOUD_LITE_VAULT_KEY
  delete environment.SUPACLOUD_LITE_STATE_DIR
  delete environment.SUPACLOUD_LITE_DATA_DIR
  delete environment.SUPACLOUD_LITE_STORAGE_DIR
  return environment
}
