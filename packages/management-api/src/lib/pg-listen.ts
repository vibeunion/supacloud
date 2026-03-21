/**
 * @supacloud/pg-listen — Zero-dependency PostgreSQL LISTEN/NOTIFY
 *
 * Uses Bun.connect() raw TCP to speak PostgreSQL Wire Protocol v3.0 directly.
 * No npm dependencies. No Node.js polyfills.
 *
 * Features:
 *   - StartupMessage (v3.0 handshake)
 *   - MD5 / Cleartext password authentication
 *   - SimpleQuery for LISTEN commands
 *   - NotificationResponse (A) message parsing
 *   - Auto-reconnect (3s delay)
 *   - TCP chunking / partial message handling
 */

import { logger } from "../utils/logger";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PgListenerOptions {
  /** PostgreSQL connection URL (postgresql://user:pass@host:port/db) */
  url: string;
  /** Channels to LISTEN on */
  channels: string[];
  /** Callback when a notification is received */
  onNotification: (channel: string, payload: string) => void;
  /** Reconnect delay in ms (default: 3000) */
  reconnectDelay?: number;
  /** Application name for pg_stat_activity */
  applicationName?: string;
}

export interface PgListenerHandle {
  close(): void;
}

// ─── Wire Protocol Helpers (exported for testing) ───────────────────────────

/** Build a PG v3.0 StartupMessage */
export function buildStartupMessage(
  user: string,
  database: string,
  applicationName: string = "supacloud-listener"
): Buffer {
  // Format: length(4) + version(4) + params + \0
  const params = `user\0${user}\0database\0${database}\0application_name\0${applicationName}\0\0`;
  const paramsBytes = Buffer.from(params, "utf-8");
  const len = 4 + 4 + paramsBytes.length;
  const buf = Buffer.alloc(len);
  buf.writeInt32BE(len, 0);
  buf.writeInt32BE(196608, 4); // version 3.0 = 196608
  paramsBytes.copy(buf, 8);
  return buf;
}

/** Build a PasswordMessage (cleartext or MD5 hash) */
export function buildPasswordMessage(password: string): Buffer {
  const passBytes = Buffer.from(password + "\0", "utf-8");
  const len = 4 + passBytes.length;
  const buf = Buffer.alloc(1 + len);
  buf[0] = 0x70; // 'p'
  buf.writeInt32BE(len, 1);
  passBytes.copy(buf, 5);
  return buf;
}

/** Build a SimpleQuery message */
export function buildQuery(sql: string): Buffer {
  const sqlBytes = Buffer.from(sql + "\0", "utf-8");
  const len = 4 + sqlBytes.length;
  const buf = Buffer.alloc(1 + len);
  buf[0] = 0x51; // 'Q'
  buf.writeInt32BE(len, 1);
  sqlBytes.copy(buf, 5);
  return buf;
}

/** Compute MD5 password hash: md5(md5(password + user) + salt) */
export function computeMd5Password(
  user: string,
  password: string,
  salt: Buffer
): string {
  const hasher1 = new Bun.CryptoHasher("md5");
  hasher1.update(password);
  hasher1.update(user);
  const innerHex = hasher1.digest("hex");

  const hasher2 = new Bun.CryptoHasher("md5");
  hasher2.update(innerHex);
  hasher2.update(salt);
  return "md5" + hasher2.digest("hex");
}

/**
 * Parse a NotificationResponse (A) message body.
 * Body format: pid(4) + channel\0 + payload\0
 */
export function parseNotification(body: Buffer): {
  pid: number;
  channel: string;
  payload: string;
} | null {
  if (body.length < 6) return null;
  const pid = body.readInt32BE(0);
  let offset = 4;
  const channelEnd = body.indexOf(0, offset);
  if (channelEnd === -1) return null;
  const channel = body.subarray(offset, channelEnd).toString("utf-8");
  offset = channelEnd + 1;
  const payloadEnd = body.indexOf(0, offset);
  if (payloadEnd === -1) return null;
  const payload = body.subarray(offset, payloadEnd).toString("utf-8");
  return { pid, channel, payload };
}

/**
 * Parse complete PG messages from a buffer, handling partial/chunked data.
 * Returns: [parsed messages, remaining buffer]
 */
export function parseMessages(
  data: Buffer
): [Array<{ type: string; body: Buffer }>, Buffer] {
  const messages: Array<{ type: string; body: Buffer }> = [];
  let offset = 0;

  while (offset < data.length) {
    // Need at least 5 bytes: type(1) + length(4)
    if (data.length - offset < 5) break;

    const type = String.fromCharCode(data[offset]);
    const bodyLen = data.readInt32BE(offset + 1); // includes self (4 bytes) but not type byte
    const totalLen = 1 + bodyLen;

    // Not enough data for complete message
    if (data.length - offset < totalLen) break;

    const body = data.subarray(offset + 5, offset + totalLen);
    messages.push({ type, body });
    offset += totalLen;
  }

  const remaining = offset < data.length ? data.subarray(offset) : Buffer.alloc(0);
  return [messages, remaining];
}

// ─── Connection URL Parser ──────────────────────────────────────────────────

function parseConnectionUrl(url: string): {
  hostname: string;
  port: number;
  database: string;
  username: string;
  password: string;
} {
  const match = url.match(
    /postgresql?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/([^?]+)/
  );
  if (!match) throw new Error(`Invalid PostgreSQL URL: ${url}`);
  const [, username, password, hostname, port, database] = match;
  return {
    hostname,
    port: parseInt(port, 10),
    database,
    username: decodeURIComponent(username),
    password: decodeURIComponent(password),
  };
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Create a PG LISTEN/NOTIFY listener using raw TCP.
 *
 * @example
 * ```ts
 * const listener = createPgListener({
 *   url: "postgresql://user:pass@localhost:5432/mydb",
 *   channels: ["task_pending", "task_completed"],
 *   onNotification: (channel, payload) => {
 *     logger.info(`Got ${channel}: ${payload}`);
 *   },
 * });
 *
 * // Later:
 * listener.close();
 * ```
 */
export function createPgListener(opts: PgListenerOptions): PgListenerHandle {
  const { url, channels, onNotification, applicationName } = opts;
  const reconnectDelay = opts.reconnectDelay ?? 3000;
  const connInfo = parseConnectionUrl(url);

  let closed = false;
  let socket: ReturnType<typeof Bun.connect> | null = null;
  let reconnectTimer: Timer | null = null;

  function connect() {
    if (closed) return;

    let buffer: Uint8Array = new Uint8Array(0);
    let authenticated = false;

    logger.info(
      `[PgListener] Connecting to ${connInfo.hostname}:${connInfo.port}/${connInfo.database}...`
    );

    socket = Bun.connect({
      hostname: connInfo.hostname,
      port: connInfo.port,

      socket: {
        open(sock) {
          // Send StartupMessage
          const msg = buildStartupMessage(
            connInfo.username,
            connInfo.database,
            applicationName ?? "supacloud-listener"
          );
          sock.write(msg);
        },

        data(sock, rawData) {
          // Append incoming data to buffer
          const incoming = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData as ArrayBuffer);
          const merged = new Uint8Array(buffer.length + incoming.length);
          merged.set(buffer);
          merged.set(incoming, buffer.length);
          const fullBuf = Buffer.from(merged.buffer, merged.byteOffset, merged.byteLength);

          // Parse complete messages
          const [messages, remaining] = parseMessages(fullBuf);
          buffer = new Uint8Array(remaining.buffer, remaining.byteOffset, remaining.byteLength);

          for (const msg of messages) {
            switch (msg.type) {
              case "R": {
                // Authentication
                if (msg.body.length < 4) break;
                const authType = msg.body.readInt32BE(0);

                if (authType === 0) {
                  // AuthenticationOk
                  authenticated = true;
                } else if (authType === 3) {
                  // CleartextPassword
                  sock.write(buildPasswordMessage(connInfo.password));
                } else if (authType === 5) {
                  // MD5Password
                  const salt = msg.body.subarray(4, 8);
                  const hash = computeMd5Password(
                    connInfo.username,
                    connInfo.password,
                    salt
                  );
                  sock.write(buildPasswordMessage(hash));
                } else {
                  logger.error(
                    `[PgListener] Unsupported auth type: ${authType}`
                  );
                  sock.end();
                }
                break;
              }

              case "Z": {
                // ReadyForQuery — send LISTEN commands
                if (authenticated && channels.length > 0) {
                  const listenSql = channels
                    .map((ch) => `LISTEN ${ch}`)
                    .join("; ");
                  sock.write(buildQuery(listenSql + ";"));
                  logger.info(
                    `[PgListener] Connected and listening on: ${channels.join(", ")}`
                  );
                  // Only send LISTEN once (on first ReadyForQuery after auth)
                  authenticated = false;
                }
                break;
              }

              case "A": {
                // NotificationResponse
                const notification = parseNotification(msg.body);
                if (notification) {
                  try {
                    onNotification(notification.channel, notification.payload);
                  } catch (err: unknown) {
                    logger.error(
                      `[PgListener] Notification handler error:`,
                      err as Error
                    );
                  }
                }
                break;
              }

              case "E": {
                // ErrorResponse — log it
                const errMsg = msg.body.toString("utf-8").replace(/\0/g, " | ");
                logger.error(`[PgListener] PG Error: ${errMsg}`);
                break;
              }

              // Ignore other message types (K=BackendKeyData, S=ParameterStatus, T=RowDescription, C=CommandComplete, etc.)
            }
          }
        },

        close() {
          logger.warn(`[PgListener] Connection closed.`);
          scheduleReconnect();
        },

        error(_sock, err) {
          logger.error(`[PgListener] Socket error: ${err instanceof Error ? err.message : String(err)}`);
          scheduleReconnect();
        },

        connectError(_sock, err) {
          logger.error(`[PgListener] Connect error: ${err instanceof Error ? err.message : String(err)}`);
          scheduleReconnect();
        },
      },
    });
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    logger.info(
      `[PgListener] Reconnecting in ${reconnectDelay / 1000}s...`
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
  }

  // Start initial connection
  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        // @ts-ignore - Bun.connect returns a socket with end()
        socket?.end?.();
      } catch (err: unknown) {
      // Ignore close errors
      logger.warn("[pg-listen] end failed silently", { error: err });
    }
      logger.info(`[PgListener] Closed.`);
    },
  };
}

// ─── Convenience wrapper (simplified API matching veo-ai style) ─────────────

/**
 * Convenience wrapper that matches the veo-ai/pg-listen API signature.
 *
 * @param url PostgreSQL connection URL
 * @param channels Channels to listen on
 * @param callback Notification handler
 */
export function createPgListenerSimple(
  url: string,
  channels: string[],
  callback: (channel: string, payload: string) => void
): PgListenerHandle {
  return createPgListener({
    url,
    channels,
    onNotification: callback,
  });
}
