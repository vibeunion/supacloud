/**
 * Published Realtime contract for `@supabase/supabase-js`.
 *
 * The client connects to `wss://<project-api-host>/realtime/v1/websocket`.
 * Caddy forwards that path to Management API. Management API accepts the
 * upgrade and proxies the socket to the Elixir Realtime process
 * (`REALTIME_ADMIN_URL`, default `http://127.0.0.1:4000`), rewriting
 * `/realtime/v1` to `/socket`. Elixir owns channel join, postgres changes,
 * broadcast, and presence.
 *
 * If the Elixir socket closes or errors, the client socket closes. This path
 * does not subscribe to `RealtimeBunService` and does not fail over to
 * PostgreSQL LISTEN/NOTIFY.
 *
 * `RealtimeBunService` is a separate in-process LISTEN/NOTIFY subscriber.
 * It is not mounted on `/realtime/v1`. Do not attach it to this proxy:
 * the client would observe two change streams for one join.
 */

export const PUBLIC_REALTIME_CLIENT_PATH = "/realtime/v1/websocket";
export const PUBLIC_REALTIME_SOCKET_OWNER = "elixir-realtime" as const;

/** Rewrite a public `/realtime/v1` path onto the configured Elixir origin. */
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
