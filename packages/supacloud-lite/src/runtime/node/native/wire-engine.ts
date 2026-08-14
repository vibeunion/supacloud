import type { DbEngine, EngineResults, EngineTx, EngineUnsubscribe } from '../../db/engine.js'
import { Mutex } from '../../db/engine.js'
import type { PgWireClient } from './wire.js'

export interface WireEngineOptions {
  connect: () => Promise<PgWireClient>
  onClose?: () => Promise<void> | void
}

export async function buildWireEngine(options: WireEngineOptions): Promise<DbEngine> {
  const queryClient = await options.connect()
  let listenerClient: PgWireClient
  try {
    listenerClient = await options.connect()
  } catch (error) {
    await queryClient.close().catch(() => {})
    throw error
  }

  const queryMutex = new Mutex()
  const listenerMutex = new Mutex()
  const listeners = new Map<string, Set<(payload: string) => void>>()
  listenerClient.onNotification = (channel, payload) => {
    for (const listener of listeners.get(channel) ?? []) listener(payload)
  }

  const transactionClient: EngineTx = {
    async query<T>(sql: string, params?: unknown[]): Promise<EngineResults<T>> {
      const queryResult = await queryClient.query<T>(sql, normalizeParams(params))
      return { rows: queryResult.rows, affectedRows: queryResult.affectedRows }
    },
    async exec(sql: string): Promise<void> {
      await queryClient.exec(sql)
    },
  }

  let closePromise: Promise<void> | null = null
  return {
    query<T>(sql: string, params?: unknown[]): Promise<EngineResults<T>> {
      return queryMutex.run(() => transactionClient.query<T>(sql, params))
    },
    exec(sql: string): Promise<void> {
      return queryMutex.run(() => transactionClient.exec(sql))
    },
    transaction<T>(callback: (transaction: EngineTx) => Promise<T>): Promise<T> {
      return queryMutex.run(async () => {
        await queryClient.exec('begin')
        try {
          const response = await callback(transactionClient)
          await queryClient.exec('commit')
          return response
        } catch (error) {
          await queryClient.exec('rollback').catch(() => {})
          throw error
        }
      })
    },
    async listen(channel: string, listener: (payload: string) => void): Promise<EngineUnsubscribe> {
      return listenerMutex.run(async () => {
        let channelListeners = listeners.get(channel)
        if (!channelListeners) {
          channelListeners = new Set()
          await listenerClient.exec(`listen "${channel.replaceAll('"', '""')}"`)
          listeners.set(channel, channelListeners)
        }
        channelListeners.add(listener)
        return () => {
          channelListeners.delete(listener)
        }
      })
    },
    close(): Promise<void> {
      closePromise ??= closeWireEngine(queryClient, listenerClient, options.onClose)
      return closePromise
    },
  }
}

async function closeWireEngine(
  queryClient: PgWireClient,
  listenerClient: PgWireClient,
  onClose?: () => Promise<void> | void
): Promise<void> {
  const closeResults = await Promise.allSettled([queryClient.close(), listenerClient.close()])
  let engineCleanupError: unknown
  try {
    await onClose?.()
  } catch (error) {
    engineCleanupError = error
  }
  const connectionErrors = closeResults.flatMap((closeResult) => closeResult.status === 'rejected' ? [closeResult.reason] : [])
  if (engineCleanupError !== undefined) connectionErrors.push(engineCleanupError)
  if (connectionErrors.length > 0) throw new AggregateError(connectionErrors, 'native database cleanup failed')
}

export function normalizeParams(params?: unknown[]): unknown[] | undefined {
  return params?.map((parameter) => {
    if (parameter === null || parameter === undefined) return null
    if (Array.isArray(parameter)) return toPgArrayLiteral(parameter)
    if (parameter instanceof Date) return parameter.toISOString()
    if (typeof parameter === 'object') return JSON.stringify(parameter)
    return parameter
  })
}

function toPgArrayLiteral(array: unknown[]): string {
  const encoded = array.map((element): string => {
    if (element === null || element === undefined) return 'NULL'
    if (Array.isArray(element)) return toPgArrayLiteral(element)
    if (typeof element === 'number' || typeof element === 'boolean') return String(element)
    const text = typeof element === 'object' ? JSON.stringify(element) : String(element)
    return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  })
  return `{${encoded.join(',')}}`
}
