/**
 * `bun:ffi` binding for the embeddable SupaCloud Realtime core.
 *
 * The core is a small `cdylib` that owns only the Phoenix protocol state
 * machine: frame codec, `postgres_changes` matching, presence bookkeeping and
 * channel/broadcast transitions. It never opens a socket or a database, so the
 * Bun host keeps PGlite and RLS authority while sharing the exact same contract
 * as the standalone Rust gateway.
 *
 * The ABI is JSON-in / JSON-out over opaque handles:
 *
 * ```ts
 * const core = loadRealtimeCore(path)
 * core.call({ op: 'frame', connection_id: 'c1', frame: ['1','1','phoenix','heartbeat',{}] })
 * core.close()
 * ```
 */
import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from 'bun:ffi'

/** A frame the host must serialize and send to one client socket. */
export interface CoreFrame {
  connection_id: string
  frame: unknown
}

/** Work the Bun host must perform because it owns the database. */
export type CoreEffect =
  | {
      type: 'authorize'
      request_id: string
      connection_id: string
      topic: string
      join_ref: string | null
    }
  | {
      type: 'broadcast'
      topic: string
      event: string
      payload: unknown
      private: boolean
    }

/** Response envelope returned by `sc_realtime_core_handle`. */
export interface CoreResponse {
  frames: CoreFrame[]
  effects: CoreEffect[]
  errors: string[]
}

/** Commands accepted by the core. */
export type CoreRequest =
  | { op: 'frame'; connection_id: string; frame: unknown }
  | {
      op: 'authorize_result'
      connection_id: string
      request_id: string
      read: boolean
      write: boolean
      /** Optional denial reason surfaced to the client. */
      reason?: string
    }
  | {
      op: 'authorize'
      connection_id: string
      topic: string
      write: boolean
    }
  | { op: 'cdc'; event: Record<string, unknown> }
  | { op: 'presence_state'; connection_id: string; topic: string }
  | { op: 'disconnect'; connection_id: string }

export interface RealtimeCore {
  /** ABI version reported by the loaded library. */
  readonly abiVersion: number
  /** Execute one command and decode the JSON response. */
  call(request: CoreRequest): CoreResponse
  /** Release the native session. Safe to call more than once. */
  close(): void
}

/** Raised when the embedded core cannot be loaded or speaks another ABI. */
export class RealtimeCoreUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RealtimeCoreUnavailableError'
  }
}

export const REALTIME_CORE_ABI_VERSION = 1

const symbols = {
  sc_realtime_core_abi_version: { args: [], returns: FFIType.u32 },
  sc_realtime_core_new: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
  sc_realtime_core_handle: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.ptr,
  },
  sc_realtime_core_free: { args: [FFIType.ptr], returns: FFIType.void },
  sc_realtime_core_buffer_data: { args: [FFIType.ptr], returns: FFIType.ptr },
  sc_realtime_core_buffer_len: { args: [FFIType.ptr], returns: FFIType.u64 },
  sc_realtime_core_buffer_free: { args: [FFIType.ptr], returns: FFIType.void },
  sc_realtime_core_last_error: { args: [], returns: FFIType.ptr },
} as const

/** Platform-specific file name of the core library. */
export function realtimeCoreLibraryName(
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'darwin') return 'libsupacloud_realtime_core.dylib'
  if (platform === 'win32') return 'supacloud_realtime_core.dll'
  return 'libsupacloud_realtime_core.so'
}

/**
 * Hand-written shape of the loaded symbols. Bun's generic `dlopen` inference
 * collapses to `never` for this symbol map, so the boundary is typed here and
 * cast once at the load site.
 */
interface CoreSymbols {
  sc_realtime_core_abi_version(): number
  sc_realtime_core_new(config: Pointer | null, len: number | bigint): Pointer | null
  sc_realtime_core_handle(
    session: Pointer,
    request: Pointer,
    len: number | bigint
  ): Pointer | null
  sc_realtime_core_free(session: Pointer): void
  sc_realtime_core_buffer_data(buffer: Pointer): Pointer
  sc_realtime_core_buffer_len(buffer: Pointer): number | bigint
  sc_realtime_core_buffer_free(buffer: Pointer): void
  sc_realtime_core_last_error(): Pointer
}

interface LoadedCoreLibrary {
  symbols: CoreSymbols
  close(): void
}

function readOwnedBuffer(ffi: CoreSymbols, pointer: Pointer | null): string {
  if (!pointer) return ''
  const data = ffi.sc_realtime_core_buffer_data(pointer)
  const length = Number(ffi.sc_realtime_core_buffer_len(pointer))
  try {
    if (!data || length === 0) return ''
    return new TextDecoder().decode(
      new Uint8Array(toArrayBuffer(data, 0, length))
    )
  } finally {
    ffi.sc_realtime_core_buffer_free(pointer)
  }
}

/**
 * Load the core from an explicit path.
 *
 * Callers are expected to resolve a verified path first (standalone extraction
 * or a local build dir); this function never searches the C library path, so a
 * stray system-wide library cannot be picked up by accident.
 */
export function loadRealtimeCore(path: string): RealtimeCore {
  let library: LoadedCoreLibrary
  try {
    library = dlopen(path, symbols) as unknown as LoadedCoreLibrary
  } catch (error) {
    throw new RealtimeCoreUnavailableError(
      `failed to load realtime core at ${path}: ${(error as Error).message}`
    )
  }

  const ffi = library.symbols
  const abiVersion = Number(ffi.sc_realtime_core_abi_version())
  if (abiVersion !== REALTIME_CORE_ABI_VERSION) {
    library.close()
    throw new RealtimeCoreUnavailableError(
      `realtime core ABI ${abiVersion} does not match host ABI ${REALTIME_CORE_ABI_VERSION}`
    )
  }

  const session = ffi.sc_realtime_core_new(null, 0)
  if (!session) {
    const message =
      readOwnedBuffer(ffi, ffi.sc_realtime_core_last_error()) || 'unknown error'
    library.close()
    throw new RealtimeCoreUnavailableError(
      `failed to create realtime core session: ${message}`
    )
  }

  let released = false
  return {
    abiVersion,
    call(request: CoreRequest): CoreResponse {
      if (released) {
        throw new RealtimeCoreUnavailableError('realtime core session is closed')
      }
      const payload = Buffer.from(JSON.stringify(request), 'utf8')
      const reply = ffi.sc_realtime_core_handle(
        session,
        ptr(payload),
        BigInt(payload.byteLength)
      )
      if (!reply) {
        const message =
          readOwnedBuffer(ffi, ffi.sc_realtime_core_last_error()) ||
          'unknown error'
        throw new Error(`realtime core rejected request: ${message}`)
      }
      const json = readOwnedBuffer(ffi, reply)
      const decoded = JSON.parse(json) as CoreResponse
      return {
        frames: Array.isArray(decoded.frames) ? decoded.frames : [],
        effects: Array.isArray(decoded.effects) ? decoded.effects : [],
        errors: Array.isArray(decoded.errors) ? decoded.errors : [],
      }
    },
    close() {
      if (released) return
      released = true
      ffi.sc_realtime_core_free(session)
      library.close()
    },
  }
}