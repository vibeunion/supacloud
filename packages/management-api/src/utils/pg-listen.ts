/**
 * @veo-ai/pg-listen — 零依赖 PostgreSQL LISTEN/NOTIFY 客户端
 *
 * 使用 Bun.connect() 原生 TCP 直接实现 PostgreSQL Wire Protocol，
 * 仅覆盖 StartupMessage / MD5认证 / SimpleQuery / NotificationResponse。
 * 完全不引入任何第三方依赖。
 */
import { createHash } from "crypto";

// ---- 类型 ----

interface PgConnectOptions {
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
}

export type NotifyHandler = (channel: string, payload: string) => void;

export interface PgListenerHandle {
	close(): void;
}

// ---- DSN 解析 ----

function parseDSN(url: string): PgConnectOptions {
	const u = new URL(url);
	return {
		host: u.hostname,
		port: Number(u.port) || 5432,
		database: u.pathname.slice(1),
		user: decodeURIComponent(u.username),
		password: decodeURIComponent(u.password)
	};
}

// ---- 字节工具 ----

function allocBuffer(size: number): DataView {
	return new DataView(new ArrayBuffer(size));
}

function encodeString(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const total = parts.reduce((acc, p) => acc + p.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

// ---- PostgreSQL Wire Protocol 消息构造 ----

function buildStartupMessage(user: string, database: string): Uint8Array {
	const params = encodeString(`user\0${user}\0database\0${database}\0\0`);
	const totalLen = 8 + params.length;
	const header = allocBuffer(8);
	header.setInt32(0, totalLen);
	header.setInt32(4, 196608); // 协议版本 3.0
	return concatBytes(new Uint8Array(header.buffer), params);
}

function buildMD5AuthResponse(user: string, password: string, salt: Uint8Array): Uint8Array {
	const inner = createHash("md5").update(password + user).digest("hex");
	const outer = "md5" + createHash("md5").update(inner).update(salt).digest("hex");
	const payload = encodeString(outer + "\0");
	const totalLen = 4 + payload.length;
	const header = allocBuffer(5);
	header.setUint8(0, 0x70); // 'p'
	header.setInt32(1, totalLen);
	return concatBytes(new Uint8Array(header.buffer), payload);
}

function buildCleartextAuthResponse(password: string): Uint8Array {
	const payload = encodeString(password + "\0");
	const totalLen = 4 + payload.length;
	const header = allocBuffer(5);
	header.setUint8(0, 0x70);
	header.setInt32(1, totalLen);
	return concatBytes(new Uint8Array(header.buffer), payload);
}

function buildSimpleQuery(sqlText: string): Uint8Array {
	const payload = encodeString(sqlText + "\0");
	const totalLen = 4 + payload.length;
	const header = allocBuffer(5);
	header.setUint8(0, 0x51); // 'Q'
	header.setInt32(1, totalLen);
	return concatBytes(new Uint8Array(header.buffer), payload);
}

// ---- 读取工具 ----

function readInt32BE(buf: Uint8Array, offset: number): number {
	return new DataView(buf.buffer, buf.byteOffset).getInt32(offset);
}

function indexOfZero(buf: Uint8Array, from: number): number {
	for (let i = from; i < buf.length; i++) {
		if (buf[i] === 0) return i;
	}
	return -1;
}

function sliceToString(buf: Uint8Array, start: number, end: number): string {
	return new TextDecoder().decode(buf.subarray(start, end));
}

// ---- 认证类型 ----
const AUTH_OK = 0;
const AUTH_CLEARTEXT = 3;
const AUTH_MD5 = 5;

// ---- 主入口 ----

export function createPgListener(
	databaseUrl: string,
	channels: string[],
	onNotify: NotifyHandler
): PgListenerHandle {
	const opts = parseDSN(databaseUrl);
	let listenSent = false;
	let closed = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let pending = new Uint8Array(0);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function processMessages(socket: any) {
		while (pending.length >= 5) {
			const msgType = pending[0]!;
			const msgLen = readInt32BE(pending, 1);
			const totalLen = 1 + msgLen;

			if (pending.length < totalLen) break; // 分包，等下一次 data

			const body = pending.subarray(5, totalLen);

			switch (msgType) {
				case 0x52: {
					// 'R' — Authentication
					const authType = readInt32BE(body, 0);
					if (authType === AUTH_MD5) {
						const salt = body.subarray(4, 8);
						socket.write(buildMD5AuthResponse(opts.user, opts.password, salt));
					} else if (authType === AUTH_CLEARTEXT) {
						socket.write(buildCleartextAuthResponse(opts.password));
					}
					break;
				}

				case 0x5a: {
					// 'Z' — ReadyForQuery
					if (!listenSent) {
						const sql = channels.map((ch) => `LISTEN ${ch}`).join("; ");
						socket.write(buildSimpleQuery(sql));
						listenSent = true;
						console.log(`[pg-listen] 已连接并订阅: ${channels.join(", ")}`);
					}
					break;
				}

				case 0x41: {
					// 'A' — NotificationResponse ★
					// pid(4) + channel(CString) + payload(CString)
					let pos = 4;
					const chEnd = indexOfZero(body, pos);
					if (chEnd < 0) break;
					const channel = sliceToString(body, pos, chEnd);
					pos = chEnd + 1;
					const plEnd = indexOfZero(body, pos);
					if (plEnd < 0) break;
					const payload = sliceToString(body, pos, plEnd);

					try {
						onNotify(channel, payload);
					} catch (err) {
						console.error(`[pg-listen] 通知回调异常 (channel=${channel}):`, err);
					}
					break;
				}

				case 0x45: {
					// 'E' — ErrorResponse
					const text = sliceToString(body, 0, body.length).replace(/\0/g, " | ");
					console.error(`[pg-listen] PostgreSQL 错误: ${text}`);
					break;
				}
				// 其他消息 ('S','K','T','C','D','N') 直接忽略
			}

			pending = pending.subarray(totalLen);
		}
	}

	function connect() {
		if (closed) return;
		listenSent = false;
		pending = new Uint8Array(0);

		Bun.connect({
			hostname: opts.host,
			port: opts.port,
			socket: {
				open(socket: any) {
					socket.write(buildStartupMessage(opts.user, opts.database));
				},
				data(socket: any, rawData: any) {
					const chunk = new Uint8Array(rawData instanceof ArrayBuffer ? rawData : rawData.buffer ?? rawData);
					pending = concatBytes(pending, chunk);
					processMessages(socket);
				},
				error(_socket: any, err: any) {
					console.error("[pg-listen] 连接错误:", err);
				},
				close() {
					if (closed) return;
					console.log("[pg-listen] 连接已断开，3 秒后重连...");
					reconnectTimer = setTimeout(connect, 3000);
				}
			}
		}).catch((err) => {
			console.error("[pg-listen] 建立连接失败:", err);
			if (!closed) {
				reconnectTimer = setTimeout(connect, 3000);
			}
		});
	}

	connect();

	return {
		close() {
			closed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
		}
	};
}
