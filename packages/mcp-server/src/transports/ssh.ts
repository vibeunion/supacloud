/**
 * SupaCloud MCP Server – SSH Transport Layer
 *
 * When SupaCloud is not yet installed, execute ops tasks on target server via SSH.
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

export class SshTransport {
    private config: SshConfig;

    constructor(config: SshConfig) {
        this.config = config;
    }

    /** Execute remote command and return result */
    async exec(command: string, timeoutMs: number = 300_000): Promise<SshResult> {
        return new Promise((resolve, reject) => {
            const conn = new Client();
            let stdout = "";
            let stderr = "";

            const timer = setTimeout(() => {
                conn.end();
                reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            conn
                .on("ready", () => {
                    conn.exec(command, (err, stream) => {
                        if (err) {
                            clearTimeout(timer);
                            conn.end();
                            return reject(err);
                        }
                        stream
                            .on("close", (code: number) => {
                                clearTimeout(timer);
                                conn.end();
                                resolve({ success: code === 0, stdout, stderr, code });
                            })
                            .on("data", (data: Buffer) => {
                                stdout += data.toString();
                            })
                            .stderr.on("data", (data: Buffer) => {
                                stderr += data.toString();
                            });
                    });
                })
                .on("error", (err) => {
                    clearTimeout(timer);
                    reject(err);
                })
                .connect({
                    host: this.config.host,
                    port: this.config.port,
                    username: this.config.username,
                    ...(this.config.privateKeyPath
                        ? { privateKey: Bun.file(this.config.privateKeyPath).stream() as unknown as Buffer }
                        : {}),
                    ...(this.config.password ? { password: this.config.password } : {}),
                });
        });
    }

    /** Upload file to remote host */
    async upload(localPath: string, remotePath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const conn = new Client();
            conn
                .on("ready", () => {
                    conn.sftp((err, sftp) => {
                        if (err) {
                            conn.end();
                            return reject(err);
                        }
                        sftp.fastPut(localPath, remotePath, (err2) => {
                            conn.end();
                            if (err2) return reject(err2);
                            resolve();
                        });
                    });
                })
                .on("error", reject)
                .connect({
                    host: this.config.host,
                    port: this.config.port,
                    username: this.config.username,
                    ...(this.config.privateKeyPath
                        ? { privateKey: Bun.file(this.config.privateKeyPath).stream() as unknown as Buffer }
                        : {}),
                    ...(this.config.password ? { password: this.config.password } : {}),
                });
        });
    }

    /** Quick check if host is reachable */
    async ping(): Promise<boolean> {
        const result = await this.exec("echo pong", 10_000).catch(() => null);
        return result?.stdout.trim() === "pong";
    }
}
