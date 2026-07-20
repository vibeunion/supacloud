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
import { pbkdf2Sync, createHmac, createHash, randomBytes } from "crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PgListenerOptions {
  /** PostgreSQL connection URL (postgresql://user:pass@host:port/db) */
  url: string;
  /** Channels to LISTEN on */
  channels: string[];
  /** Callback when a notification is received */
  onNotification: (channel: string, payload: string) => void;
  /** Initial reconnect delay in ms (default: 3000). Doubles on each retry up to maxReconnectDelay. */
  reconnectDelay?: number;
  /** Maximum reconnect delay in ms (default: 300000 = 5 minutes) */
  maxReconnectDelay?: number;
  /** Keep the LISTEN TCP connection alive with a lightweight SELECT (default: 45000ms). Set 0 to disable. */
  keepaliveIntervalMs?: number;
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

/** SCRAM-SHA-256 Logic */
export function handleScramSha256(password: string, serverFirstMsg: string, scramClientFirstBare: string): string {
  const parts = serverFirstMsg.split(',');
  let r = '', sBase64 = '', iStr = '';
  for (const p of parts) {
      if (p.startsWith('r=')) r = p.substring(2);
      if (p.startsWith('s=')) sBase64 = p.substring(2);
      if (p.startsWith('i=')) iStr = p.substring(2);
  }
  const iterations = parseInt(iStr, 10);
  const salt = Buffer.from(sBase64, 'base64');

  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update("Client Key").digest();
  const storedKey = createHash('sha256').update(clientKey).digest();

  const authMessage = `${scramClientFirstBare},${serverFirstMsg},c=biws,r=${r}`;
  const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
  
  const clientProof = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) clientProof[i] = clientKey[i] ^ clientSignature[i];

  return `c=biws,r=${r},p=${clientProof.toString('base64')}`;
}

export function buildSASLInitialResponse(mechanism: string, clientFirstMessageBare: string): Buffer {
  const mechanismBytes = Buffer.from(mechanism + "\0", "utf8");
  const clientFirstMsg = `n,,${clientFirstMessageBare}`;
  const clientFirstMsgBytes = Buffer.from(clientFirstMsg, "utf8");

  const len = 4 + mechanismBytes.length + 4 + clientFirstMsgBytes.length;
  const buf = Buffer.alloc(1 + len);
  buf[0] = 0x70; // 'p'
  buf.writeInt32BE(len, 1);
  mechanismBytes.copy(buf, 5);
  buf.writeInt32BE(clientFirstMsgBytes.length, 5 + mechanismBytes.length);
  clientFirstMsgBytes.copy(buf, 5 + mechanismBytes.length + 4);
  return buf;
}

export function buildSASLResponse(clientFinalMessage: string): Buffer {
  const msgBytes = Buffer.from(clientFinalMessage, "utf8");
  const len = 4 + msgBytes.length;
  const buf = Buffer.alloc(1 + len);
  buf[0] = 0x70; // 'p'
  buf.writeInt32BE(len, 1);
  msgBytes.copy(buf, 5);
  return buf;
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
    /postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/([^?]+)/
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
  const maxReconnectDelay = opts.maxReconnectDelay ?? 300_000; // 5 minutes
  const keepaliveIntervalMs = opts.keepaliveIntervalMs ?? 45_000;
  const connInfo = parseConnectionUrl(url);

  let closed = false;
  let fatalError = false;
  let currentDelay = reconnectDelay;
  let socket: ReturnType<typeof Bun.connect> | null = null;
  let reconnectTimer: Timer | null = null;
  let keepaliveTimer: Timer | null = null;

  function clearKeepalive() {
    if (!keepaliveTimer) return;
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }

  function startKeepalive(sock: { write: (data: Buffer) => unknown }) {
    clearKeepalive();
    if (keepaliveIntervalMs <= 0) return;
    keepaliveTimer = setInterval(() => {
      try {
        sock.write(buildQuery("SELECT 1;"));
      } catch (err: unknown) {
        logger.warn("[PgListener] Keepalive query failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, keepaliveIntervalMs);
  }

  function connect() {
    if (closed || fatalError) return;

    clearKeepalive();
    let buffer: Uint8Array = new Uint8Array(0);
    let authenticated = false;
    let scramClientNonce = "";
    let scramClientFirstBare = "";

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
                } else if (authType === 10) {
                  // AuthenticationSASL
                  scramClientNonce = randomBytes(18).toString('base64');
                  scramClientFirstBare = `n=,r=${scramClientNonce}`;
                  sock.write(buildSASLInitialResponse("SCRAM-SHA-256", scramClientFirstBare));
                } else if (authType === 11) {
                  // AuthenticationSASLContinue
                  const serverFirstMsg = msg.body.subarray(4).toString("utf8");
                  const payload = handleScramSha256(connInfo.password, serverFirstMsg, scramClientFirstBare);
                  sock.write(buildSASLResponse(payload));
                } else if (authType === 12) {
                  // AuthenticationSASLFinal
                  // We can just ignore this message, AuthOk (0) will follow immediately.
                } else {
                  logger.error(
                    `[PgListener] Unsupported auth type: ${authType}. Connection failed.`
                  );
                  fatalError = true;
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
                  startKeepalive(sock);
                  // Reset backoff delay on successful connection
                  currentDelay = reconnectDelay;
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
          clearKeepalive();
          logger.warn(`[PgListener] Connection closed.`);
          scheduleReconnect();
        },

        error(_sock, err) {
          clearKeepalive();
          logger.error(`[PgListener] Socket error: ${err instanceof Error ? err.message : String(err)}`);
          scheduleReconnect();
        },

        connectError(_sock, err) {
          clearKeepalive();
          logger.error(`[PgListener] Connect error: ${err instanceof Error ? err.message : String(err)}`);
          scheduleReconnect();
        },
      },
    });
  }

  function scheduleReconnect() {
    if (closed || fatalError || reconnectTimer) return;
    logger.info(
      `[PgListener] Reconnecting in ${currentDelay / 1000}s...`
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, currentDelay);
    // Exponential backoff: double delay each attempt, capped at maxReconnectDelay
    currentDelay = Math.min(currentDelay * 2, maxReconnectDelay);
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
      clearKeepalive();
      try {
        // socket is the return value of Bun.connect — use type assertion for end()
        (socket as { end?: () => void })?.end?.();
      } catch (err: unknown) {
      // Ignore close errors
      logger.warn("[PgListen] Failed to close TCP connection during cleanup", { error: err });
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
