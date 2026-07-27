/**
 * Bun-native server: Bun.serve with first-class WebSockets. Used automatically
 * when the CLI runs under Bun (including single-binary builds) - same backend,
 * same RealtimeSocketLike contract as the node:http path.
 */
import type { SupaliteBackendShape } from './server-shared.js'

export interface ServeOptions {
  port?: number
  host?: string
}

export interface RunningServer {
  server: Bun.Server<WsData>
  port: number
  url: string
  close: () => Promise<void>
}

/** Per-connection state Bun carries through the websocket lifecycle callbacks. */
interface WsData {
  vsn: string
  /** Realtime session, created on `open` and driven by `message`/`close`. */
  session?: { onMessage: (data: string | Uint8Array) => void; onClose: () => void }
}

/** Bun equivalent of {@link import('./server.js').serve}; same backend contract. */
export async function serveBun(backend: SupaliteBackendShape, opts: ServeOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1'

  const server = Bun.serve<WsData>({
    port: opts.port ?? 54321,
    hostname: host,
    async fetch(req: Request, srv: any) {
      const url = new URL(req.url)
      if (url.pathname.startsWith('/realtime/v1') && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const ok = srv.upgrade(req, { data: { vsn: url.searchParams.get('vsn') ?? '1.0.0' } })
        if (ok) return undefined
        return new Response('upgrade failed', { status: 400 })
      }
      // Expose the connecting client's address for rate limiting, stripping any
      // client-supplied value first so the header can't be forged - the node:http
      // server does the same from req.socket.remoteAddress. Without this, a
      // spoofed x-supacloud-lite-remote-addr rotated per request defeats the limiter.
      const headers = new Headers(req.headers)
      headers.delete('x-supacloud-lite-remote-addr')
      const ip = srv.requestIP(req)?.address
      if (ip) headers.set('x-supacloud-lite-remote-addr', ip)
      return backend.fetch(new Request(req, { headers }))
    },
    websocket: {
      open(ws: { data: WsData; send(d: string | Uint8Array): void; close(c?: number, r?: string): void }) {
        const session = backend.realtime.connect(
          {
            send: (data) => ws.send(data),
            close: (code, reason) => ws.close(code, reason),
          },
          { vsn: ws.data.vsn }
        )
        ws.data.session = session
      },
      message(ws: { data: WsData }, message: string | Uint8Array) {
        ws.data.session?.onMessage(typeof message === 'string' ? message : new Uint8Array(message))
      },
      close(ws: { data: WsData }) {
        ws.data.session?.onClose()
      },
    },
  })

  return {
    server,
    port: server.port ?? opts.port ?? 54321,
    url: `http://${host}:${server.port ?? opts.port ?? 54321}`,
    close: async () => {
      server.stop(true)
    },
  }
}
