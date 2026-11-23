/**
 * Process entrypoint for one project's Data API.
 *
 * The environment contract lives in `dataplane.ts` (`readDataPlaneConfig`);
 * this file only binds a TCP listener and handles shutdown.
 *
 *   DATA_PLANE_DATABASE_URL | PGRST_DB_URI        required
 *   DATA_PLANE_JWT_SECRET   | PGRST_JWT_SECRET    required
 *   DATA_PLANE_PORT         | PGRST_SERVER_PORT   default 3000
 *   DATA_PLANE_HOST                               default 127.0.0.1
 *   DATA_PLANE_SCHEMAS      | PGRST_DB_SCHEMAS    default public
 *   DATA_PLANE_MAX_ROWS     | PGRST_DB_MAX_ROWS   default unlimited
 *   DATA_PLANE_PROJECT_REF                        default unknown
 *
 * This process serves `/rest/v1` and `/health` only. Auth, storage, functions
 * and realtime stay on their own endpoints.
 */

import { SQL } from 'bun'
import { createBunSqlEngine } from './runtime/db/bun-sql-engine.js'
import { createDataPlane, readDataPlaneConfig, type DataPlane, type DataPlaneConfig } from './dataplane.js'

export interface DataPlaneServer {
  port: number
  stop(): Promise<void>
}

/** Bind one project's data plane to a TCP listener. */
export async function serveDataPlane(config: DataPlaneConfig): Promise<DataPlaneServer> {
  const pool = new SQL({
    url: config.databaseUrl,
    max: 10,
    idleTimeout: 30,
    maxLifetime: 3_600,
    connectionTimeout: 10,
  })
  const engine = createBunSqlEngine({
    pool,
    // A dedicated LISTEN connection managed by Bun; it re-subscribes on
    // reconnect, which a pooled query connection cannot do.
    listen: async (channel, onPayload) => {
      const subscription = await pool.listen(channel, (payload) => onPayload(payload))
      return () => subscription.unlisten()
    },
  })
  const plane: DataPlane = await createDataPlane({
    engine,
    jwtSecret: config.jwtSecret,
    exposedSchemas: config.exposedSchemas,
    projectRef: config.projectRef,
    ...(config.maxRows === undefined ? {} : { maxRows: config.maxRows }),
  })

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: (request: Request) => plane.fetch(request),
  })

  return {
    port: server.port ?? config.port,
    async stop(): Promise<void> {
      await server.stop(true)
      await plane.close()
    },
  }
}

if (import.meta.main) {
  const config = readDataPlaneConfig()
  const server = await serveDataPlane(config)
  console.log(`supacloud-dataplane listening on ${config.host}:${server.port} (project ${config.projectRef})`)

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    console.log(`supacloud-dataplane received ${signal}; draining`)
    await server.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  process.on('SIGINT', () => { void shutdown('SIGINT') })
}