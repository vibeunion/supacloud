import { expect, test } from 'bun:test'
import { CronService } from '../src/vendor/tinbase/cron/service.js'
import type { Database } from '../src/vendor/tinbase/db/database.js'
import { NetService } from '../src/vendor/tinbase/net/service.js'
import { RetentionService } from '../src/vendor/tinbase/retention/service.js'

test('waits for a public net tick while later interval ticks are skipped', async () => {
  const queryGate = createGatedDatabase()
  const service = new NetService(queryGate.database, fetch, 1)

  const tickPromise = service.tick()
  service.start()
  try {
    await queryGate.queryStarted
    expect(service.tick()).toBe(tickPromise)
    await Bun.sleep(50)
    expect(queryGate.queryCalls()).toBe(1)
    expect(queryGate.maxConcurrentQueries()).toBe(1)

    let stopFinished = false
    const stopPromise = service.stop().then(() => {
      stopFinished = true
    })
    await Bun.sleep(10)
    expect(stopFinished).toBeFalse()

    queryGate.releaseQuery()
    await Promise.all([tickPromise, stopPromise])
    const stoppedQueryCalls = queryGate.queryCalls()
    await Bun.sleep(10)
    expect(queryGate.queryCalls()).toBe(stoppedQueryCalls)
  } finally {
    queryGate.releaseQuery()
    await service.stop()
  }
})

test('retries cron after a job-list failure and drains the active tick during stop', async () => {
  const queryGate = createGatedDatabase(1)
  const service = new CronService(queryGate.database, 1)

  service.start()
  try {
    await Bun.sleep(50)
    await queryGate.queryStarted
    expect(queryGate.queryCalls()).toBe(2)
    expect(queryGate.maxConcurrentQueries()).toBe(1)

    let stopFinished = false
    const stopPromise = service.stop().then(() => {
      stopFinished = true
    })
    await Bun.sleep(10)
    expect(stopFinished).toBeFalse()

    queryGate.releaseQuery()
    await stopPromise
    const stoppedQueryCalls = queryGate.queryCalls()
    await Bun.sleep(10)
    expect(queryGate.queryCalls()).toBe(stoppedQueryCalls)
  } finally {
    queryGate.releaseQuery()
    await service.stop()
  }
})

test('waits for a public due-job cron tick while interval ticks are skipped', async () => {
  const queryGate = createGatedCronDatabase()
  const service = new CronService(queryGate.database, 1, () => new Date(2_000))

  const tickPromise = service.tick()
  service.start()
  try {
    await queryGate.commandStarted
    expect(service.tick()).toBe(tickPromise)
    await Bun.sleep(50)
    expect(queryGate.jobListCalls()).toBe(1)
    expect(queryGate.commandCalls()).toBe(1)
    expect(queryGate.maxConcurrentQueries()).toBe(1)

    let stopFinished = false
    const stopPromise = service.stop().then(() => {
      stopFinished = true
    })
    await Bun.sleep(10)
    expect(stopFinished).toBeFalse()

    queryGate.releaseCommand()
    await Promise.all([tickPromise, stopPromise])
    const stoppedQueryCalls = queryGate.queryCalls()
    await Bun.sleep(10)
    expect(queryGate.queryCalls()).toBe(stoppedQueryCalls)
  } finally {
    queryGate.releaseCommand()
    await service.stop()
  }
})

test('waits for a public retention sweep while interval sweeps are skipped', async () => {
  const queryGate = createGatedDatabase()
  const service = new RetentionService(queryGate.database, {
    intervalMs: 1,
    auditLogDays: 0,
    refreshTokenDays: 0,
  })

  const sweepPromise = service.sweep()
  service.start()
  try {
    await queryGate.queryStarted
    expect(service.sweep()).toBe(sweepPromise)
    await Bun.sleep(50)
    expect(queryGate.queryCalls()).toBe(1)
    expect(queryGate.maxConcurrentQueries()).toBe(1)

    let stopFinished = false
    const stopPromise = service.stop().then(() => {
      stopFinished = true
    })
    await Bun.sleep(10)
    expect(stopFinished).toBeFalse()

    queryGate.releaseQuery()
    await Promise.all([sweepPromise, stopPromise])
    const stoppedQueryCalls = queryGate.queryCalls()
    await Bun.sleep(10)
    expect(queryGate.queryCalls()).toBe(stoppedQueryCalls)
  } finally {
    queryGate.releaseQuery()
    await service.stop()
  }
})

test('releases retention single-flight state after an unexpected failure', async () => {
  let clockCalls = 0
  const database = { query: async () => ({ rows: [], affectedRows: 0 }) } as unknown as Database
  const service = new RetentionService(database, { auditLogDays: 0, refreshTokenDays: 0 }, () => {
    clockCalls += 1
    if (clockCalls === 1) throw new Error('planned clock failure')
    return new Date(0)
  })

  await expect(service.sweep()).rejects.toThrow('planned clock failure')
  await service.sweep()
  expect(clockCalls).toBe(2)
})

for (const { name, create, hasBootSweep } of getBackgroundServices()) {
  test(`${name} ignores a queued interval callback after stop`, async () => {
    const intervals = installManualIntervals()
    const database = createCountingDatabase()
    const service = create(database.database)
    try {
      service.start()
      if (hasBootSweep) await (service as RetentionService).sweep()
      const oldCallback = intervals.callbackAt(0)

      await service.stop()
      const callsAfterStop = database.queryCalls()
      oldCallback()
      await flushMicrotasks()

      expect(database.queryCalls()).toBe(callsAfterStop)
    } finally {
      await service.stop()
      intervals.restore()
    }
  })

  test(`${name} ignores an old callback after restart when timer handles are reused`, async () => {
    const intervals = installManualIntervals()
    const database = createCountingDatabase()
    const service = create(database.database)
    try {
      service.start()
      if (hasBootSweep) await (service as RetentionService).sweep()
      const oldCallback = intervals.callbackAt(0)
      await service.stop()

      service.start()
      if (hasBootSweep) await (service as RetentionService).sweep()
      const newCallback = intervals.callbackAt(1)
      const callsBeforeCallbacks = database.queryCalls()

      oldCallback()
      await flushMicrotasks()
      expect(database.queryCalls()).toBe(callsBeforeCallbacks)

      newCallback()
      await flushMicrotasks()
      expect(database.queryCalls()).toBeGreaterThan(callsBeforeCallbacks)
    } finally {
      await service.stop()
      intervals.restore()
    }
  })
}

function getBackgroundServices(): Array<{
  name: string
  create: (database: Database) => { start(): void; stop(): Promise<void> }
  hasBootSweep: boolean
}> {
  return [
    { name: 'net', create: (database) => new NetService(database, fetch, 1), hasBootSweep: false },
    { name: 'cron', create: (database) => new CronService(database, 1), hasBootSweep: false },
    {
      name: 'retention',
      create: (database) => new RetentionService(database, { auditLogDays: 0, refreshTokenDays: 0 }),
      hasBootSweep: true,
    },
  ]
}

function createCountingDatabase() {
  let queryCalls = 0
  return {
    database: {
      async query() {
        queryCalls += 1
        return { rows: [], affectedRows: 0 }
      },
    } as unknown as Database,
    queryCalls: () => queryCalls,
  }
}

function installManualIntervals() {
  const setInterval = globalThis.setInterval
  const clearInterval = globalThis.clearInterval
  const callbacks: Array<() => void> = []
  const reusedHandle = {} as ReturnType<typeof setInterval>
  globalThis.setInterval = ((callback: () => void) => {
    callbacks.push(callback)
    return reusedHandle
  }) as typeof setInterval
  globalThis.clearInterval = (() => {}) as typeof clearInterval
  return {
    callbackAt: (index: number) => {
      const callback = callbacks[index]
      if (!callback) throw new Error(`missing interval callback ${index}`)
      return callback
    },
    restore: () => {
      globalThis.setInterval = setInterval
      globalThis.clearInterval = clearInterval
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function createGatedDatabase(failuresBeforeGate = 0) {
  const queryStarted = Promise.withResolvers<void>()
  const queryGate = Promise.withResolvers<void>()
  let queryCalls = 0
  let activeQueries = 0
  let maxConcurrentQueries = 0
  const database = {
    async query() {
      queryCalls += 1
      activeQueries += 1
      maxConcurrentQueries = Math.max(maxConcurrentQueries, activeQueries)
      try {
        if (queryCalls <= failuresBeforeGate) throw new Error('planned query failure')
        queryStarted.resolve()
        await queryGate.promise
        return { rows: [], affectedRows: 0 }
      } finally {
        activeQueries -= 1
      }
    },
  } as unknown as Database
  return {
    database,
    queryStarted: queryStarted.promise,
    releaseQuery: queryGate.resolve,
    queryCalls: () => queryCalls,
    maxConcurrentQueries: () => maxConcurrentQueries,
  }
}

function createGatedCronDatabase() {
  const commandStarted = Promise.withResolvers<void>()
  const commandGate = Promise.withResolvers<void>()
  let queryCalls = 0
  let jobListCalls = 0
  let commandCalls = 0
  let activeQueries = 0
  let maxConcurrentQueries = 0
  const database = {
    async query(sql: string) {
      queryCalls += 1
      activeQueries += 1
      maxConcurrentQueries = Math.max(maxConcurrentQueries, activeQueries)
      try {
        if (sql.startsWith('select jobid')) {
          jobListCalls += 1
          return { rows: [{ jobid: 1, schedule: '1 seconds', command: 'select 1', jobname: 'gate', active: true }] }
        }
        if (sql === 'select 1') {
          commandCalls += 1
          commandStarted.resolve()
          await commandGate.promise
        }
        return { rows: [], affectedRows: 0 }
      } finally {
        activeQueries -= 1
      }
    },
  } as unknown as Database
  return {
    database,
    commandStarted: commandStarted.promise,
    releaseCommand: commandGate.resolve,
    queryCalls: () => queryCalls,
    jobListCalls: () => jobListCalls,
    commandCalls: () => commandCalls,
    maxConcurrentQueries: () => maxConcurrentQueries,
  }
}
