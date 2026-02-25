/**
 * SupaCloud MCP Server – SSH 传输层
 *
 * 在 SupaCloud 尚未安装时，通过 SSH 连接目标服务器执行运维操作。
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

    /** 执行远程命令并返回结果 */
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
                        ? { privateKey: Bun.file(this.config.privateKeyPath).stream() as any }
                        : {}),
                    ...(this.config.password ? { password: this.config.password } : {}),
                });
        });
    }

    /** 上传文件到远程主机 */
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
                        ? { privateKey: Bun.file(this.config.privateKeyPath).stream() as any }
                        : {}),
                    ...(this.config.password ? { password: this.config.password } : {}),
                });
        });
    }

    /** 快速检测主机是否可达 */
    async ping(): Promise<boolean> {
        const result = await this.exec("echo pong", 10_000).catch(() => null);
        return result?.stdout.trim() === "pong";
    }
}
