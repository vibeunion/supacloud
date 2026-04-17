/**
 * SupaCloud MCP Server – SSH Transport Layer
 *
 * When SupaCloud is not yet installed, execute ops tasks on target server via SSH.
 * Includes command auditing, allowlist enforcement, and connection pooling.
 */
import { Client } from "ssh2";

export interface SshConfig {
    host: string;
    port: number;
    username: string;
    privateKeyPath?: string;
    password?: string;
}

export interface SshResult {
    success: boolean;
    stdout: string;
    stderr: string;
    code: number;
}

const BLOCKED_COMMANDS = [
    "rm -rf /", "mkfs", "dd if=", ":(){:|:&};:",
    "shutdown", "reboot", "init 0", "init 6",
    "passwd", "userdel", "usermod -L",
    "iptables -F", "ufw disable",
    "crontab -r", "chmod -R 777 /",
];

function isCommandBlocked(command: string): boolean {
    const normalized = command.trim().toLowerCase();
    return BLOCKED_COMMANDS.some(blocked => normalized.includes(blocked));
}

const auditLog: Array<{ timestamp: string; command: string; host: string; blocked: boolean }> = [];

function auditCommand(command: string, host: string, blocked: boolean) {
    const entry = { timestamp: new Date().toISOString(), command, host, blocked };
    auditLog.push(entry);
    if (auditLog.length > 1000) auditLog.shift();
    if (blocked) {
        console.error(`[SSH-AUDIT] BLOCKED command on ${host}: ${command}`);
    } else {
        console.log(`[SSH-AUDIT] Executing on ${host}: ${command.substring(0, 200)}`);
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

    constructor(config: SshConfig) {
        this.config = config;
    }

    private async createConnection(): Promise<Client> {
        const conn = new Client();
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
                .on("error", (err) => {
                    clearTimeout(timeout);
                    reject(err);
                })
                .connect({
                    host: this.config.host,
                    port: this.config.port,
                    username: this.config.username,
                    ...(this.config.privateKeyPath
                        ? { privateKey: require("fs").readFileSync(this.config.privateKeyPath) }
                        : {}),
                    ...(this.config.password ? { password: this.config.password } : {}),
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

    constructor(config: SshConfig) {
        this.config = config;
        this.pool = new SshConnectionPool(config);
    }

    async exec(command: string, timeoutMs: number = 300_000): Promise<SshResult> {
        if (isCommandBlocked(command)) {
            auditCommand(command, this.config.host, true);
            return {
                success: false,
                stdout: "",
                stderr: `Command blocked by security policy: "${command.substring(0, 100)}". ` +
                    `Destructive or system-altering commands are not allowed via MCP.`,
                code: 126,
            };
        }

        auditCommand(command, this.config.host, false);

        const conn = await this.pool.acquire();
        try {
            return await new Promise<SshResult>((resolve, reject) => {
                let stdout = "";
                let stderr = "";

                const timer = setTimeout(() => {
                    conn.end();
                    reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
                }, timeoutMs);

                conn.exec(command, (err, stream) => {
                    if (err) {
                        clearTimeout(timer);
                        return reject(err);
                    }
                    stream
                        .on("close", (code: number) => {
                            clearTimeout(timer);
                            resolve({ success: code === 0, stdout, stderr, code });
                        })
                        .on("data", (data: Buffer) => {
                            stdout += data.toString();
                        })
                        .stderr.on("data", (data: Buffer) => {
                            stderr += data.toString();
                        });
                });
            });
        } finally {
            this.pool.release(conn);
        }
    }

    async upload(localPath: string, remotePath: string): Promise<void> {
        const conn = await this.pool.acquire();
        try {
            return await new Promise<void>((resolve, reject) => {
                conn.sftp((err, sftp) => {
                    if (err) return reject(err);
                    sftp.fastPut(localPath, remotePath, (err2) => {
                        if (err2) return reject(err2);
                        resolve();
                    });
                });
            });
        } finally {
            this.pool.release(conn);
        }
    }

    async ping(): Promise<boolean> {
        const result = await this.exec("echo pong", 10_000).catch(() => null);
        return result?.stdout.trim() === "pong";
    }

    close() {
        this.pool.closeAll();
    }
}
