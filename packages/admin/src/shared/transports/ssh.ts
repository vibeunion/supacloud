/**
 * SupaCloud admin SSH transport layer.
 *
 * When SupaCloud is not yet installed, execute ops tasks on target server via SSH.
 * Includes command auditing, allowlist enforcement, and connection pooling.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, type ClientChannel } from "ssh2";
type SftpClient = {
    fastPut: (localPath: string, remotePath: string, cb: (err?: Error | null) => void) => void;
    writeFile: (
        remotePath: string,
        content: string | Buffer,
        options: { mode: number },
        cb: (err?: Error | null) => void,
    ) => void;
    chmod: (remotePath: string, mode: number, cb: (err?: Error | null) => void) => void;
};

export interface SshConfig {
    host: string;
    port: number;
    username: string;
    hostFingerprint: string;
    privateKeyPath?: string;
    password?: string;
    maxOutputBytes?: number;
}

export interface SshResult {
    success: boolean;
    stdout: string;
    stderr: string;
    code: number;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
}

export interface SshTransportOptions {
    clientFactory?: () => Client;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONFIGURABLE_OUTPUT_BYTES = 16 * 1024 * 1024;

export function normalizeSshHostFingerprint(value: string): string {
    const trimmed = value.trim();
    const match = trimmed.match(/^SHA256:([A-Za-z0-9+/]{43}=?)$/);
    if (!match) {
        throw new Error("SUPACLOUD_SSH_HOST_FINGERPRINT must use OpenSSH SHA256:<base64> format");
    }
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.length !== 32) {
        throw new Error("SUPACLOUD_SSH_HOST_FINGERPRINT must contain a 32-byte SHA256 digest");
    }
    return `SHA256:${match[1].replace(/=+$/, "")}`;
}

function createHostVerifier(fingerprint: string): (actualHash: string) => boolean {
    const expected = Buffer.from(normalizeSshHostFingerprint(fingerprint).slice("SHA256:".length), "base64");
    return (actualHash: string): boolean => {
        if (!/^[a-f0-9]{64}$/i.test(actualHash)) return false;
        const actual = Buffer.from(actualHash, "hex");
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    };
}

function normalizeMaxOutputBytes(value?: number): number {
    const resolved = value ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_CONFIGURABLE_OUTPUT_BYTES) {
        throw new Error(`maxOutputBytes must be an integer between 1 and ${MAX_CONFIGURABLE_OUTPUT_BYTES}`);
    }
    return resolved;
}

class BoundedOutputCollector {
    private readonly storage: Buffer;
    private bytes = 0;
    truncated = false;

    constructor(readonly limit: number) {
        this.storage = Buffer.allocUnsafe(limit);
    }

    append(data: Buffer | string): void {
        if (this.truncated) return;
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const remaining = this.limit - this.bytes;
        const copied = Math.min(buffer.length, Math.max(0, remaining));
        if (copied > 0) buffer.copy(this.storage, this.bytes, 0, copied);
        this.bytes += copied;
        this.truncated = buffer.length > copied;
    }

    finalize(): string {
        let output = this.storage.subarray(0, this.bytes).toString("utf8");
        if (this.truncated) {
            // Never retain an incomplete final line: it may contain a credential
            // split exactly at the byte limit and therefore evade normal redaction.
            const lastNewline = output.lastIndexOf("\n");
            output = lastNewline >= 0 ? output.slice(0, lastNewline + 1) : "";
        }
        const redacted = redactSshOutput(output);
        if (!this.truncated) return redacted;
        return `${redacted}${redacted && !redacted.endsWith("\n") ? "\n" : ""}[TRUNCATED: output exceeded ${this.limit}-byte limit]`;
    }
}

const BLOCKED_COMMANDS = [
    "rm -rf /", "mkfs", "dd if=", ":(){:|:&};:",
    "shutdown", "reboot", "init 0", "init 6",
    "passwd", "userdel", "usermod -L",
    "iptables -F", "ufw disable",
    "crontab -r", "chmod -R 777 /",
];

export function redactSshCommand(command: string): string {
    return command
        .replace(
            /(\b[A-Z0-9_]*(?:PASSWORD|PASS|SECRET|TOKEN|KEY|CREDENTIAL)[A-Z0-9_]*=)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
            "$1[REDACTED]",
        )
        .replace(
            /(Authorization\s*[:=]\s*)(['"]?)Bearer\s+[^'"\s;]+\2/gi,
            "$1$2Bearer [REDACTED]$2",
        )
        .replace(/(\b--(?:password|token|secret|api-key)\s+)(\S+)/gi, "$1[REDACTED]")
        .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1[REDACTED]@");
}

export function redactSshOutput(output: string): string {
    const redactedLines = output.replace(
        /^(\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASS|SECRET|TOKEN|KEY|CREDENTIAL|DB_URI|DATABASE_URL|DSN)[A-Z0-9_]*\s*=\s*).*$/gim,
        "$1[REDACTED]",
    );
    const redactedStructuredFields = redactedLines.replace(
        /((?:["']?(?:password|pass|secret|token|key|credential|db_uri|database_url|dsn)["']?)\s*:\s*)(?:"[^"]*"|'[^']*'|[^,}\]\r\n]+)/gi,
        "$1[REDACTED]",
    );
    return redactSshCommand(redactedStructuredFields);
}

function isCommandBlocked(command: string): boolean {
    const normalized = command.trim().toLowerCase();
    return BLOCKED_COMMANDS.some(blocked => normalized.includes(blocked));
}

const auditLog: Array<{ timestamp: string; command: string; host: string; blocked: boolean }> = [];

function auditCommand(command: string, host: string, blocked: boolean) {
    const safeCommand = redactSshCommand(command);
    const entry = { timestamp: new Date().toISOString(), command: safeCommand, host, blocked };
    auditLog.push(entry);
    if (auditLog.length > 1000) auditLog.shift();
    if (blocked) {
        console.error(`[SSH-AUDIT] BLOCKED command on ${host}: ${safeCommand}`);
    } else {
        console.log(`[SSH-AUDIT] Executing on ${host}: ${safeCommand.substring(0, 200)}`);
    }
}

export function getAuditLog(): typeof auditLog {
    return [...auditLog];
}

class SshConnectionPool {
    private pool: Client[] = [];
    private maxSize = 3;
    private config: SshConfig;
    private creating = 0;
    private clientFactory: () => Client;

    constructor(config: SshConfig, clientFactory: () => Client) {
        this.config = config;
        this.clientFactory = clientFactory;
    }

    private async createConnection(): Promise<Client> {
        const conn = this.clientFactory();
        return new Promise<Client>((resolve, reject) => {
            const timeout = setTimeout(() => {
                conn.end();
                reject(new Error("SSH connection timeout"));
            }, 15000);

            conn
                .on("ready", () => {
                    clearTimeout(timeout);
                    resolve(conn);
                })
                .on("error", (err: Error) => {
                    clearTimeout(timeout);
                    reject(err);
                })
                .connect({
                    host: this.config.host,
                    port: this.config.port,
                    username: this.config.username,
                    ...(this.config.privateKeyPath
                        ? { privateKey: readFileSync(this.config.privateKeyPath) }
                        : {}),
                    ...(this.config.password ? { password: this.config.password } : {}),
                    hostHash: "sha256",
                    hostVerifier: createHostVerifier(this.config.hostFingerprint),
                    readyTimeout: 15000,
                    keepaliveInterval: 30000,
                });
        });
    }

    async acquire(): Promise<Client> {
        if (this.pool.length > 0) {
            const conn = this.pool.pop()!;
            return conn;
        }
        if (this.creating < this.maxSize) {
            this.creating++;
            try {
                return await this.createConnection();
            } finally {
                this.creating--;
            }
        }
        return this.createConnection();
    }

    release(conn: Client) {
        if (this.pool.length < this.maxSize) {
            this.pool.push(conn);
        } else {
            try { conn.end(); } catch { /* ignore */ }
        }
    }

    discard(conn: Client) {
        try { conn.end(); } catch { /* ignore */ }
    }

    closeAll() {
        for (const conn of this.pool) {
            try { conn.end(); } catch { /* ignore */ }
        }
        this.pool = [];
    }
}

export class SshTransport {
    private config: SshConfig;
    private pool: SshConnectionPool;

    constructor(config: SshConfig, options: SshTransportOptions = {}) {
        this.config = {
            ...config,
            hostFingerprint: normalizeSshHostFingerprint(config.hostFingerprint || ""),
            maxOutputBytes: normalizeMaxOutputBytes(config.maxOutputBytes),
        };
        this.pool = new SshConnectionPool(this.config, options.clientFactory ?? (() => new Client()));
    }

    async exec(command: string, timeoutMs: number = 300_000): Promise<SshResult> {
        if (isCommandBlocked(command)) {
            auditCommand(command, this.config.host, true);
            const safeCommand = redactSshCommand(command);
            return {
                success: false,
                stdout: "",
                stderr: `Command blocked by security policy: "${safeCommand.substring(0, 100)}". ` +
                    `Destructive or system-altering commands are not allowed via supacloud-admin.`,
                code: 126,
            };
        }

        auditCommand(command, this.config.host, false);

        const conn = await this.pool.acquire();
        let connectionReusable = true;
        try {
            return await new Promise<SshResult>((resolve, reject) => {
                const outputLimit = this.config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
                const stdout = new BoundedOutputCollector(outputLimit);
                const stderr = new BoundedOutputCollector(outputLimit);

                const timer = setTimeout(() => {
                    connectionReusable = false;
                    this.pool.discard(conn);
                    reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
                }, timeoutMs);

                conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
                    if (err) {
                        clearTimeout(timer);
                        return reject(err);
                    }
                    stream
                        .on("close", (code: number) => {
                            clearTimeout(timer);
                            resolve({
                                success: code === 0,
                                stdout: stdout.finalize(),
                                stderr: stderr.finalize(),
                                code,
                                stdoutTruncated: stdout.truncated,
                                stderrTruncated: stderr.truncated,
                            });
                        })
                        .on("data", (data: Buffer) => {
                            stdout.append(data);
                        })
                        .stderr.on("data", (data: Buffer) => {
                            stderr.append(data);
                        });
                });
            });
        } finally {
            if (connectionReusable) this.pool.release(conn);
        }
    }

    async upload(localPath: string, remotePath: string): Promise<void> {
        const conn = await this.pool.acquire();
        try {
            return await new Promise<void>((resolve, reject) => {
                conn.sftp((err: Error | undefined, sftp: SftpClient) => {
                    if (err) return reject(err);
                    sftp.fastPut(localPath, remotePath, (err2: Error | null | undefined) => {
                        if (err2) return reject(err2);
                        resolve();
                    });
                });
            });
        } finally {
            this.pool.release(conn);
        }
    }

    async uploadText(remotePath: string, content: string, mode = 0o600): Promise<void> {
        auditCommand(`upload ${remotePath} (${Buffer.byteLength(content)} bytes; content redacted)`, this.config.host, false);
        const conn = await this.pool.acquire();
        try {
            await new Promise<void>((resolve, reject) => {
                conn.sftp((err: Error | undefined, sftp: SftpClient) => {
                    if (err) return reject(err);
                    sftp.writeFile(remotePath, content, { mode }, (writeError) => {
                        if (writeError) return reject(writeError);
                        sftp.chmod(remotePath, mode, (chmodError) => {
                            if (chmodError) return reject(chmodError);
                            resolve();
                        });
                    });
                });
            });
        } finally {
            this.pool.release(conn);
        }
    }

    async ping(): Promise<boolean> {
        const result = await this.exec("echo pong", 10_000);
        return result.success && result.stdout.trim() === "pong";
    }

    close() {
        this.pool.closeAll();
    }
}
