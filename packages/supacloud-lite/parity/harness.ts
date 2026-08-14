import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createBackend, type SupaCloudLiteBackend } from '../src/runtime/index.js'
import { createTemporaryNativeEngine } from '../src/runtime/node/db-diff.js'
import { failureObservation, PARITY_SCENARIOS } from './scenarios.js'
import { stableValue, type ParityContext, type ParityObservation } from './contract.js'

const schema = await readFile(join(import.meta.dir, 'schema.sql'), 'utf8')
const argumentsList = process.argv.slice(2)
const engine = optionValue('--engine') ?? 'pglite'
const compare = argumentsList.includes('--compare')
const jsonOutput = argumentsList.includes('--json')
const runId = (process.env.SUPACLOUD_LITE_PARITY_RUN_ID ?? crypto.randomUUID().replaceAll('-', '').slice(0, 12)).toLowerCase()

interface ScenarioRecord {
  observation: ParityObservation
  pass: boolean
}

async function runScenarios(context: ParityContext): Promise<Record<string, ScenarioRecord>> {
  const records: Record<string, ScenarioRecord> = {}
  for (const scenario of PARITY_SCENARIOS) {
    try {
      const observation = await scenario.run(context)
      records[scenario.name] = { observation: stableValue(observation) as ParityObservation, pass: scenario.expect(observation) }
    } catch (error) {
      records[scenario.name] = { observation: failureObservation(error), pass: false }
    }
  }
  return records
}

function clients(url: string, anonKey: string, serviceKey: string, fetchImplementation?: typeof fetch) {
  const clientOptions = {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(fetchImplementation ? { global: { fetch: fetchImplementation } } : {}),
  }
  return {
    anon: createClient(url, anonKey, clientOptions),
    service: createClient(url, serviceKey, clientOptions),
  }
}

interface ParityTarget {
  url: string
  anon: SupabaseClient
  service: SupabaseClient
  serviceKey: string
  fetchImplementation: typeof fetch
}

function parityContext(target: ParityTarget): ParityContext {
  return {
    anon: target.anon,
    service: target.service,
    runId,
    request: (path, init) => target.fetchImplementation(`${target.url}${path}`, {
      ...init,
      headers: { apikey: target.serviceKey, authorization: `Bearer ${target.serviceKey}`, ...init?.headers },
    }),
  }
}

async function createLite(): Promise<{ backend: SupaCloudLiteBackend }> {
  if (engine === 'pglite') {
    return { backend: await createBackend({ migrations: [{ name: '20260814000000_parity', sql: schema }] }) }
  }
  if (engine !== 'native') throw new Error(`unknown parity engine: ${engine}`)
  const nativeEngine = await createTemporaryNativeEngine()
  try {
    return {
      backend: await createBackend({ engine: nativeEngine, migrations: [{ name: '20260814000000_parity', sql: schema }] }),
    }
  } catch (error) {
    try {
      await nativeEngine.close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'native parity startup cleanup failed')
    }
    throw error
  }
}

async function verifyReferenceSchema(service: SupabaseClient): Promise<void> {
  const response = await service.rpc('parity_schema_version')
  if (response.error || response.data !== 'supacloud-lite-parity-v1') {
    throw new Error('reference Supabase is missing parity/schema.sql or has a different schema version')
  }
}

function printScore(records: Record<string, ScenarioRecord>, label: string): number {
  const failed = Object.values(records).filter((record) => !record.pass).length
  if (jsonOutput) return failed
  console.log(`\n${label}`)
  for (const scenario of PARITY_SCENARIOS) {
    console.log(`  ${records[scenario.name]!.pass ? '✓' : '✗'} [${scenario.module}] ${scenario.name}`)
  }
  console.log(`  ${PARITY_SCENARIOS.length - failed}/${PARITY_SCENARIOS.length} passed`)
  return failed
}

function optionValue(option: string): string | undefined {
  const index = argumentsList.indexOf(option)
  return index === -1 ? undefined : argumentsList[index + 1]
}

const lite = await createLite()
let exitCode = 0
try {
  const fetchLite: typeof fetch = (input, init) => lite.backend.fetch(new Request(input, init))
  const liteClients = clients('http://localhost:54321', lite.backend.anonKey, lite.backend.serviceRoleKey, fetchLite)
  const appliedMigrations = await lite.backend.db.listAppliedMigrations()
  if (appliedMigrations.some((migration) => migration.version === '20260814000000')) {
    const liteRecords = await runScenarios(
      parityContext({
        url: 'http://localhost:54321',
        anon: liteClients.anon,
        service: liteClients.service,
        serviceKey: lite.backend.serviceRoleKey,
        fetchImplementation: fetchLite,
      })
    )
    exitCode = printScore(liteRecords, `SupaCloud Lite parity (${engine})`)

    if (compare) {
      const referenceUrl = process.env.SUPABASE_URL
      const referenceAnonKey = process.env.SUPABASE_ANON_KEY
      const referenceServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!referenceUrl || !referenceAnonKey || !referenceServiceKey) {
        throw new Error('--compare requires SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY')
      }
      const referenceClients = clients(referenceUrl, referenceAnonKey, referenceServiceKey)
      await verifyReferenceSchema(referenceClients.service)
      const referenceRecords = await runScenarios(
        parityContext({
          url: referenceUrl,
          anon: referenceClients.anon,
          service: referenceClients.service,
          serviceKey: referenceServiceKey,
          fetchImplementation: fetch,
        })
      )
      let mismatches = 0
      for (const scenario of PARITY_SCENARIOS) {
        const liteObservation = JSON.stringify(liteRecords[scenario.name]!.observation)
        const referenceObservation = JSON.stringify(referenceRecords[scenario.name]!.observation)
        if (liteObservation !== referenceObservation) {
          mismatches++
          if (!jsonOutput) {
            console.log(`  ≠ [${scenario.module}] ${scenario.name}`)
            console.log(`      lite:      ${liteObservation}`)
            console.log(`      reference: ${referenceObservation}`)
          }
        }
      }
      exitCode += mismatches
    }

    if (jsonOutput) console.log(JSON.stringify({ engine, runId, records: liteRecords }, null, 2))
  } else {
    throw new Error('parity migration was not recorded')
  }
} finally {
  await lite.backend.close()
}

process.exit(exitCode === 0 ? 0 : 1)
