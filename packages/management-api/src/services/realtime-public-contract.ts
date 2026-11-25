/**
 * Published Realtime contract for `@supabase/supabase-js`.
 *
 * The client connects to `wss://<project-api-host>/realtime/v1/websocket`.
 * Caddy forwards that path to Management API. Management API accepts the
 * upgrade and proxies the socket to the Realtime gateway
 * (`REALTIME_ADMIN_URL`, default `http://127.0.0.1:4000`), rewriting
 * `/realtime/v1` to `/socket`. The default gateway is the Rust
 * `supacloud-realtime-gateway`. It owns channel join, postgres changes,
 * broadcast, and presence.
 *
 * `SUPACLOUD_REALTIME_ENGINE=container` is the explicit rollback to the Elixir
 * Realtime container on the same port. The installer does not start that
 * container unless the variable is set. If the upstream socket closes or
 * errors, the client socket closes. There is no LISTEN/NOTIFY failover.
 */

export const PUBLIC_REALTIME_CLIENT_PATH = "/realtime/v1/websocket";
export const PUBLIC_REALTIME_SOCKET_OWNER = "rust-realtime-gateway" as const;

/** Rewrite a public `/realtime/v1` path onto the configured Realtime origin. */
export function publicRealtimeUpstream(adminUrl: string, pathname: string, search: string): string {
  if (!pathname.startsWith("/realtime/v1")) {
    throw new Error("Public Realtime proxy only accepts /realtime/v1");
  }
  if (!/^https?:\/\//.test(adminUrl)) {
    throw new Error("REALTIME_ADMIN_URL must be an http(s) origin");
  }
  const wsBase = adminUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const wsPath = pathname.replace(/^\/realtime\/v1/, "/socket");
  return `${wsBase}${wsPath}${search}`;
}
