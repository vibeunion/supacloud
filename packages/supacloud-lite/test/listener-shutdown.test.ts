import { expect, test } from 'bun:test'
import { Database as LiteDatabase } from '../src/runtime/db/database.js'
import type { DbEngine, EngineResults, EngineTx, EngineUnsubscribe } from '../src/runtime/db/engine.js'
import { createBackend } from '../src/runtime/index.js'
import { computeDbDiff, pullSchema } from '../src/runtime/node/db-diff.js'
import { RealtimeEngine } from '../src/runtime/realtime/engine.js'

test('utility backends do not attach database listeners', async () => {
  let listenCalls = 0
  const engine = createListenerEngine(async () => {
    listenCalls += 1
    return () => {}
  })
  const backend = await createBackend({ engine, startRuntimeServices: false, log: () => {} })

  expect(listenCalls).toBe(0)
  await backend.close()
  expect(listenCalls).toBe(0)
})

test('schema diff utilities keep shadow and live engines listener-free', async () => {
  const listenCalls = { diffShadow: 0, diffLive: 0, pullShadow: 0, pullLive: 0 }
  const createCountingEngine = (backendName: keyof typeof listenCalls) =>
    createListenerEngine(async () => {
      listenCalls[backendName] += 1
      return () => {}
    })

  await computeDbDiff({
    migrations: [],
    makeShadowEngine: async () => createCountingEngine('diffShadow'),
    liveEngine: createCountingEngine('diffLive'),
  })
  await pullSchema({
    migrations: [],
    makeShadowEngine: async () => createCountingEngine('pullShadow'),
    liveEngine: createCountingEngine('pullLive'),
  })

  expect(listenCalls).toEqual({ diffShadow: 0, diffLive: 0, pullShadow: 0, pullLive: 0 })
})

test('shares CDC LISTEN and awaits the final asynchronous unsubscribe', async () => {
  const unsubscribeGate = Promise.withResolvers<void>()
  let listenCalls = 0
  let unsubscribeCalls = 0
  const engine = createListenerEngine(async (channel) => {
    listenCalls += 1
    return async () => {
      expect(channel).toBe('supacloud_lite_cdc')
      unsubscribeCalls += 1
      await unsubscribeGate.promise
    }
  })
  const database = await LiteDatabase.create(engine)
  const firstStop = await database.onCdcEvent(() => {})
  const secondStop = await database.onCdcEvent(() => {})

  expect(listenCalls).toBe(1)
  await firstStop()
  expect(unsubscribeCalls).toBe(0)

  let stopped = false
  const stopPromise = secondStop().then(() => {
    stopped = true
  })
  await flushMicrotasks()
  expect(unsubscribeCalls).toBe(1)
  expect(stopped).toBeFalse()

  const restartPromise = database.onCdcEvent(() => {})
  await flushMicrotasks()
  expect(listenCalls).toBe(1)
  unsubscribeGate.resolve()
  await stopPromise
  const restartStop = await restartPromise
  expect(listenCalls).toBe(2)
  await restartStop()
  await database.close()
})

test('Realtime stop waits for both unsubscriptions and propagates the first error', async () => {
  const cdcGate = Promise.withResolvers<void>()
  const broadcastGate = Promise.withResolvers<void>()
  const cdcError = new Error('cdc unsubscribe failed')
  const broadcastError = new Error('broadcast unsubscribe failed')
  const unsubscribeCalls: string[] = []
  const engine = createListenerEngine(async (channel) => {
    if (channel === 'supacloud_lite_cdc') {
      return async () => {
        unsubscribeCalls.push(channel)
        await cdcGate.promise
      }
    }
    return async () => {
      unsubscribeCalls.push(channel)
      await broadcastGate.promise
    }
  })
  const database = await LiteDatabase.create(engine)
  const realtime = new RealtimeEngine(database)
  await realtime.start()

  let settled = false
  const stopPromise = realtime.stop().finally(() => {
    settled = true
  })
  await flushMicrotasks()
  expect(unsubscribeCalls.toSorted()).toEqual(['supacloud_lite_cdc', 'supacloud_lite_realtime_broadcast'])
  expect(settled).toBeFalse()

  cdcGate.reject(cdcError)
  await flushMicrotasks()
  expect(settled).toBeFalse()
  broadcastGate.reject(broadcastError)
  await expect(stopPromise).rejects.toBe(cdcError)
  expect(settled).toBeTrue()
})

function createListenerEngine(onListen: (channel: string) => Promise<EngineUnsubscribe>): DbEngine {
  return {
    minimalBootstrap: true,
    async query<T>(): Promise<EngineResults<T>> {
      return { rows: [] }
    },
    async exec(): Promise<void> {},
    async transaction<T>(fn: (tx: EngineTx) => Promise<T>): Promise<T> {
      return fn({
        async query<R>(): Promise<EngineResults<R>> {
          return { rows: [] }
        },
        async exec(): Promise<void> {},
      })
    },
    listen: onListen,
    async close(): Promise<void> {},
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
