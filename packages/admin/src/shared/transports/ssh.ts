/**
 * SupaCloud admin SSH transport layer.
 *
 * When SupaCloud is not yet installed, execute ops tasks on target server via SSH.
 * Includes command auditing, allowlist enforcement, and connection pooling.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
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
    rename: (sourcePath: string, destinationPath: string, cb: (err?: Error | null) => void) => void;
    unlink: (remotePath: string, cb: (err?: Error | null) => void) => void;
    end: () => void;
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

export class SshCommandOutcomeUnknownError extends Error {
    readonly code = "OUTCOME_UNKNOWN";

    constructor(message: string) {
        super(message);
        this.name = "SshCommandOutcomeUnknownError";
    }
}

export interface SshTransportOptions {
    clientFactory?: () => Client;
}

export type SshUploadOptions = {
    mode?: number;
    timeoutMs?: number;
};

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONFIGURABLE_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TEXT_UPLOAD_TIMEOUT_MS = 60_000;

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
                    reject(new SshCommandOutcomeUnknownError(
                        `SSH command timed out after ${timeoutMs}ms; remote outcome is unknown`,
                    ));
                }, timeoutMs);

                try {
                    conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
                        if (err) {
                            clearTimeout(timer);
                            connectionReusable = false;
                            return reject(err);
                        }
                        stream
                            .on("close", (code?: number | null) => {
                                clearTimeout(timer);
                                if (code === undefined) {
                                    connectionReusable = false;
                                    reject(new SshCommandOutcomeUnknownError(
                                        "SSH command stream closed without a terminal status; remote outcome is unknown",
                                    ));
                                    return;
                                }
                                resolve({
                                    success: code === 0,
                                    stdout: stdout.finalize(),
                                    stderr: stderr.finalize(),
                                    code: code ?? 128,
                                    stdoutTruncated: stdout.truncated,
                                    stderrTruncated: stderr.truncated,
                                });
                            })
                            .on("error", () => {
                                clearTimeout(timer);
                                connectionReusable = false;
                                reject(new SshCommandOutcomeUnknownError(
                                    "SSH command stream failed after dispatch; remote outcome is unknown",
                                ));
                            })
                            .on("data", (data: Buffer) => {
                                stdout.append(data);
                            })
                            .stderr.on("data", (data: Buffer) => {
                                stderr.append(data);
                            });
                    });
                } catch (error: unknown) {
                    clearTimeout(timer);
                    connectionReusable = false;
                    reject(error);
                }
            });
        } finally {
            if (connectionReusable) this.pool.release(conn);
            else this.pool.discard(conn);
        }
    }

    async upload(localPath: string, remotePath: string, options: SshUploadOptions = {}): Promise<void> {
        const mode = normalizeUploadMode(options.mode);
        const timeoutMs = normalizeUploadTimeout(options.timeoutMs, DEFAULT_UPLOAD_TIMEOUT_MS);
        const partialPath = `${remotePath}.part-${randomUUID()}`;
        auditCommand(`upload ${remotePath} (local content redacted)`, this.config.host, false);
        await this.runSftpOperation(timeoutMs, async (sftp) => {
            try {
                await sftpFastPut(sftp, localPath, partialPath);
                await sftpChmod(sftp, partialPath, mode);
                await sftpRename(sftp, partialPath, remotePath);
            } catch (error: unknown) {
                await removePartialUpload(sftp, partialPath, error);
            }
        });
    }

    async uploadText(remotePath: string, content: string, mode = 0o600): Promise<void> {
        auditCommand(`upload ${remotePath} (${Buffer.byteLength(content)} bytes; content redacted)`, this.config.host, false);
        const normalizedMode = normalizeUploadMode(mode);
        const partialPath = `${remotePath}.part-${randomUUID()}`;
        await this.runSftpOperation(DEFAULT_TEXT_UPLOAD_TIMEOUT_MS, async (sftp) => {
            try {
                await sftpWriteFile(sftp, partialPath, content, normalizedMode);
                await sftpChmod(sftp, partialPath, normalizedMode);
                await sftpRename(sftp, partialPath, remotePath);
            } catch (error: unknown) {
                await removePartialUpload(sftp, partialPath, error);
            }
        });
    }

    private async runSftpOperation(timeoutMs: number, operation: (sftp: SftpClient) => Promise<void>): Promise<void> {
        const conn = await this.pool.acquire();
        let connectionReusable = true;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
            const operationPromise = openSftp(conn).then(async (sftp) => {
                await operation(sftp);
                sftp.end();
            });
            await Promise.race([
                operationPromise,
                new Promise<never>((_resolve, reject) => { timeoutHandle = setTimeout(() => {
                    connectionReusable = false;
                    reject(new Error(`SFTP upload timed out after ${timeoutMs}ms`));
                }, timeoutMs); }),
            ]);
        } catch (error: unknown) {
            connectionReusable = false;
            throw error;
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (connectionReusable) this.pool.release(conn);
            else this.pool.discard(conn);
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

function normalizeUploadMode(mode = 0o600): number {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error("Upload mode must be an octal permission between 000 and 777");
    return mode;
}

function normalizeUploadTimeout(timeoutMs: number | undefined, fallback: number): number {
    const resolved = timeoutMs ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 60 * 60_000) {
        throw new Error("Upload timeout must be between 1ms and 1 hour");
    }
    return resolved;
}

function openSftp(conn: Client): Promise<SftpClient> {
    return new Promise((resolve, reject) => {
        conn.sftp((error: Error | undefined, sftp: SftpClient) => error ? reject(error) : resolve(sftp));
    });
}

function sftpFastPut(sftp: SftpClient, localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (error) => error ? reject(error) : resolve());
    });
}

function sftpWriteFile(sftp: SftpClient, remotePath: string, content: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.writeFile(remotePath, content, { mode }, (error) => error ? reject(error) : resolve());
    });
}

function sftpChmod(sftp: SftpClient, remotePath: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.chmod(remotePath, mode, (error) => error ? reject(error) : resolve());
    });
}

function sftpRename(sftp: SftpClient, sourcePath: string, destinationPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.rename(sourcePath, destinationPath, (error) => error ? reject(error) : resolve());
    });
}

function sftpUnlink(sftp: SftpClient, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.unlink(remotePath, (error) => error ? reject(error) : resolve());
    });
}

async function removePartialUpload(sftp: SftpClient, partialPath: string, uploadError: unknown): Promise<never> {
    try {
        await sftpUnlink(sftp, partialPath);
    } catch (cleanupError: unknown) {
        if ((cleanupError as { code?: number }).code === 2) throw uploadError;
        throw new AggregateError([uploadError, cleanupError], `SFTP upload failed and partial cleanup did not complete: ${partialPath}`);
    }
    throw uploadError;
}
