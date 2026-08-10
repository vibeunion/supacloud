import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAuditLog, redactSshOutput, SshTransport } from "./ssh";

const TEST_HOST_KEY = Buffer.from("supacloud-test-host-key");
const TEST_HOST_FINGERPRINT = `SHA256:${createHash("sha256").update(TEST_HOST_KEY).digest("base64").replace(/=+$/, "")}`;

class FakeSshClient extends EventEmitter {
    connectOptions: Record<string, unknown> | undefined;
    connectError: Error | undefined;
    stdout = Buffer.from("ok\n");
    stderrOutput = Buffer.alloc(0);
    stallCommand = false;
    endCalls = 0;
    activeChannels = 0;
    maxConcurrentChannels = Number.POSITIVE_INFINITY;
    peakActiveChannels = 0;
    sftpClient: FakeSftpClient | undefined;

    connect(options: Record<string, unknown>): this {
        this.connectOptions = options;
        queueMicrotask(() => this.connectError ? this.emit("error", this.connectError) : this.emit("ready"));
        return this;
    }

    exec(_command: string, callback: (error: Error | undefined, stream: EventEmitter & { stderr: EventEmitter }) => void): void {
        if (this.activeChannels >= this.maxConcurrentChannels) {
            callback(new Error("open failed: administratively prohibited: open failed"), undefined as never);
            return;
        }
        const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        stream.stderr = new EventEmitter();
        callback(undefined, stream);
        if (this.stallCommand) return;
        queueMicrotask(() => {
            if (this.stdout.length > 0) stream.emit("data", this.stdout);
            if (this.stderrOutput.length > 0) stream.stderr.emit("data", this.stderrOutput);
            stream.emit("close", 0);
        });
    }

    sftp(callback: (error: Error | undefined, sftp: FakeSftpClient) => void): void {
        if (!this.sftpClient) return callback(new Error("SFTP unavailable"), undefined as never);
        if (this.activeChannels >= this.maxConcurrentChannels) {
            callback(new Error("open failed: administratively prohibited: open failed"), undefined as never);
            return;
        }
        this.activeChannels += 1;
        this.peakActiveChannels = Math.max(this.peakActiveChannels, this.activeChannels);
        let channelOpen = true;
        this.sftpClient.onEnd = () => {
            if (!channelOpen) return;
            channelOpen = false;
            this.activeChannels -= 1;
        };
        callback(undefined, this.sftpClient);
    }

    end(): void {
        this.endCalls += 1;
    }
}

class FakeSftpClient {
    readonly operations: string[] = [];
    failChmod = false;
    hangFastPut = false;
    endCalls = 0;
    onEnd: (() => void) | undefined;

    fastPut(_localPath: string, remotePath: string, callback: (error?: Error | null) => void): void {
        this.operations.push(`put:${remotePath}`);
        if (!this.hangFastPut) queueMicrotask(() => callback());
    }

    writeFile(remotePath: string, _content: string | Buffer, options: { mode: number }, callback: (error?: Error | null) => void): void {
        this.operations.push(`write:${remotePath}:${options.mode}`);
        queueMicrotask(() => callback());
    }

    chmod(remotePath: string, mode: number, callback: (error?: Error | null) => void): void {
        this.operations.push(`chmod:${remotePath}:${mode}`);
        queueMicrotask(() => callback(this.failChmod ? new Error("chmod failed") : undefined));
    }

    rename(sourcePath: string, destinationPath: string, callback: (error?: Error | null) => void): void {
        this.operations.push(`rename:${sourcePath}:${destinationPath}`);
        queueMicrotask(() => callback());
    }

    unlink(remotePath: string, callback: (error?: Error | null) => void): void {
        this.operations.push(`unlink:${remotePath}`);
        queueMicrotask(() => callback());
    }

    end(): void {
        this.endCalls += 1;
        this.onEnd?.();
    }
}

describe("SshTransport audit safety", () => {
    test("ping propagates connection errors", async () => {
        const failedClient = new FakeSshClient();
        failedClient.connectError = new Error("authentication failed");
        const failedTransport = new SshTransport({
            host: "server.example.com",
            port: 22,
            username: "root",
            hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => failedClient as never });

        try {
            await expect(failedTransport.ping()).rejects.toThrow("authentication failed");
        } finally {
            failedTransport.close();
        }
    });

    test("ping rejects unexpected output", async () => {
        const unexpectedClient = new FakeSshClient();
        unexpectedClient.stdout = Buffer.from("not-pong\n");
        const unexpectedTransport = new SshTransport({
            host: "server.example.com",
            port: 22,
            username: "root",
            hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => unexpectedClient as never });

        try {
            expect(await unexpectedTransport.ping()).toBe(false);
        } finally {
            unexpectedTransport.close();
        }
    });

    test("redacts secrets from arbitrary command output", () => {
        const output = redactSshOutput([
            "POSTGRES_PASSWORD=database-password",
            "export PGRST_JWT_SECRET='jwt secret with spaces'",
            '{"token":"api-token","status":"ok"}',
            "DATABASE_URL=postgres://admin:url-password@localhost/postgres",
            "Authorization: Bearer bearer-token",
            "PUBLIC_DOMAIN=api.example.com",
        ].join("\n"));

        expect(output).not.toContain("database-password");
        expect(output).not.toContain("jwt secret with spaces");
        expect(output).not.toContain("api-token");
        expect(output).not.toContain("url-password");
        expect(output).not.toContain("bearer-token");
        expect(output).toContain("PUBLIC_DOMAIN=api.example.com");
        expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(5);
    });

    test("redacts secrets from blocked results, console output, and retained audit entries", async () => {
        const transport = new SshTransport({
            host: "127.0.0.1",
            port: 22,
            username: "root",
            hostFingerprint: TEST_HOST_FINGERPRINT,
        });
        const secret = "correct-horse-battery-staple";
        const messages: string[] = [];
        const originalError = console.error;
        console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "));

        try {
            const result = await transport.exec(`POSTGRES_PASSWORD=${secret} Authorization='Bearer top-secret-token' rm -rf /`);
            const auditEntry = getAuditLog().at(-1);

            expect(result.success).toBe(false);
            expect(result.stderr).not.toContain(secret);
            expect(result.stderr).not.toContain("top-secret-token");
            expect(auditEntry?.command).not.toContain(secret);
            expect(auditEntry?.command).not.toContain("top-secret-token");
            expect(messages.join("\n")).not.toContain(secret);
            expect(messages.join("\n")).not.toContain("top-secret-token");
            expect(auditEntry?.command).toContain("[REDACTED]");
        } finally {
            console.error = originalError;
            transport.close();
        }
    });

    test("requires and verifies an explicit SHA256 host fingerprint", async () => {
        expect(() => new SshTransport({
            host: "server.example.com",
            port: 22,
            username: "root",
        } as never)).toThrow("SUPACLOUD_SSH_HOST_FINGERPRINT");

        const client = new FakeSshClient();
        const transport = new SshTransport({
            host: "server.example.com",
            port: 22,
            username: "root",
            hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => client as never });

        try {
            await transport.exec("hostname");
            expect(client.connectOptions?.hostHash).toBe("sha256");
            const verifier = client.connectOptions?.hostVerifier as ((hash: string) => boolean);
            expect(verifier(createHash("sha256").update(TEST_HOST_KEY).digest("hex"))).toBe(true);
            expect(verifier(createHash("sha256").update("different-key").digest("hex"))).toBe(false);
        } finally {
            transport.close();
        }
    });

    test("discards a timed-out connection before the next cleanup command", async () => {
        const stalledClient = new FakeSshClient();
        stalledClient.stallCommand = true;
        const cleanupClient = new FakeSshClient();
        const clients = [stalledClient, cleanupClient];
        let clientIndex = 0;
        const transport = new SshTransport({
            host: "server.example.com",
            port: 22,
            username: "root",
            hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => clients[clientIndex++] as never });

        try {
            await expect(transport.exec("long-running-upgrade", 10)).rejects.toThrow(
                "SSH command timed out after 10ms",
            );
            expect(stalledClient.endCalls).toBe(1);

            const cleanup = await transport.exec("remove-upgrade-helper");
            expect(cleanup.success).toBe(true);
            expect(clientIndex).toBe(2);
            expect(cleanupClient.connectOptions?.host).toBe("server.example.com");
        } finally {
            transport.close();
        }
    });

    test("bounds stdout and stderr independently, marks truncation, and never retains discarded secrets", async () => {
        const client = new FakeSshClient();
        client.stdout = Buffer.from(`PUBLIC=ok\nTOKEN=visible-secret\n${"x".repeat(256)}\nTOKEN=discarded-secret`);
        client.stderrOutput = Buffer.from(`DATABASE_URL=postgres://admin:stderr-secret@localhost/db\n${"y".repeat(256)}\nPASSWORD=discarded-error-secret`);
        const transport = new SshTransport({
            host: "server.example.com",
            port: 22,
            username: "root",
            hostFingerprint: TEST_HOST_FINGERPRINT,
            maxOutputBytes: 96,
        }, { clientFactory: () => client as never });

        try {
            const result = await transport.exec("hostname");
            expect(result.stdoutTruncated).toBe(true);
            expect(result.stderrTruncated).toBe(true);
            expect(result.stdout).toContain("[TRUNCATED");
            expect(result.stderr).toContain("[TRUNCATED");
            expect(result.stdout).not.toContain("visible-secret");
            expect(result.stdout).not.toContain("discarded-secret");
            expect(result.stderr).not.toContain("stderr-secret");
            expect(result.stderr).not.toContain("discarded-error-secret");
        } finally {
            transport.close();
        }
    });

    test("uploads through a protected partial path before chmod and atomic rename", async () => {
        const fixtureDirectory = mkdtempSync(join(tmpdir(), "supacloud-sftp-upload-"));
        const localPath = join(fixtureDirectory, "artifact");
        writeFileSync(localPath, "release artifact");
        const client = new FakeSshClient();
        const sftp = new FakeSftpClient();
        client.sftpClient = sftp;
        const transport = new SshTransport({
            host: "server.example.com", port: 22, username: "root", hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => client as never });

        try {
            await transport.upload(localPath, "/tmp/release/artifact", { mode: 0o600, timeoutMs: 1_000 });
            expect(sftp.operations[0]).toMatch(/^put:\/tmp\/release\/artifact\.part-[0-9a-f-]+$/);
            const partialPath = sftp.operations[0]!.slice("put:".length);
            expect(sftp.operations).toEqual([
                `put:${partialPath}`,
                `chmod:${partialPath}:384`,
                `rename:${partialPath}:/tmp/release/artifact`,
            ]);
            expect(sftp.endCalls).toBe(1);
            expect(getAuditLog().at(-1)?.command).not.toContain(localPath);
        } finally {
            transport.close();
            rmSync(fixtureDirectory, { recursive: true, force: true });
        }
    });

    test("uploads generated scripts through the same protected atomic path", async () => {
        const client = new FakeSshClient();
        const sftp = new FakeSftpClient();
        client.sftpClient = sftp;
        const transport = new SshTransport({
            host: "server.example.com", port: 22, username: "ubuntu", hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => client as never });

        try {
            await transport.uploadText("/tmp/private/run.sh", "#!/bin/sh\nexit 0\n", 0o600);
            expect(sftp.operations[0]).toMatch(/^write:\/tmp\/private\/run\.sh\.part-[0-9a-f-]+:384$/);
            const partialPath = sftp.operations[0]!.slice("write:".length, -":384".length);
            expect(sftp.operations).toEqual([
                `write:${partialPath}:384`,
                `chmod:${partialPath}:384`,
                `rename:${partialPath}:/tmp/private/run.sh`,
            ]);
            expect(sftp.endCalls).toBe(1);
        } finally {
            transport.close();
        }
    });

    test("closes every SFTP upload channel before a later exec session", async () => {
        const fixtureDirectory = mkdtempSync(join(tmpdir(), "supacloud-sftp-channels-"));
        const localPath = join(fixtureDirectory, "artifact");
        writeFileSync(localPath, "release artifact");
        const client = new FakeSshClient();
        const sftp = new FakeSftpClient();
        client.sftpClient = sftp;
        client.maxConcurrentChannels = 10;
        const transport = new SshTransport({
            host: "server.example.com", port: 22, username: "root", hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => client as never });

        try {
            for (let uploadIndex = 0; uploadIndex < 10; uploadIndex += 1) {
                const remotePath = `/tmp/release/artifact-${uploadIndex}`;
                if (uploadIndex % 2 === 0) await transport.upload(localPath, remotePath);
                else await transport.uploadText(remotePath, "release artifact");
            }

            expect((await transport.exec("hostname")).success).toBe(true);
            expect(sftp.endCalls).toBe(10);
            expect(client.activeChannels).toBe(0);
            expect(client.peakActiveChannels).toBe(1);
        } finally {
            transport.close();
            rmSync(fixtureDirectory, { recursive: true, force: true });
        }
    });

    test("removes a partial upload and discards the connection after an SFTP error", async () => {
        const fixtureDirectory = mkdtempSync(join(tmpdir(), "supacloud-sftp-failure-"));
        const localPath = join(fixtureDirectory, "artifact");
        writeFileSync(localPath, "release artifact");
        const failedClient = new FakeSshClient();
        const failedSftp = new FakeSftpClient();
        failedSftp.failChmod = true;
        failedClient.sftpClient = failedSftp;
        const replacementClient = new FakeSshClient();
        const clients = [failedClient, replacementClient];
        const transport = new SshTransport({
            host: "server.example.com", port: 22, username: "root", hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => clients.shift() as never });

        try {
            await expect(transport.upload(localPath, "/tmp/release/artifact")).rejects.toThrow("chmod failed");
            expect(failedSftp.operations.at(-1)).toMatch(/^unlink:\/tmp\/release\/artifact\.part-/);
            expect(failedClient.endCalls).toBeGreaterThan(0);
            expect(await transport.ping()).toBe(false);
            expect(replacementClient.connectOptions).toBeDefined();
        } finally {
            transport.close();
            rmSync(fixtureDirectory, { recursive: true, force: true });
        }
    });

    test("bounds an SFTP upload and does not return its timed-out connection to the pool", async () => {
        const fixtureDirectory = mkdtempSync(join(tmpdir(), "supacloud-sftp-timeout-"));
        const localPath = join(fixtureDirectory, "artifact");
        writeFileSync(localPath, "release artifact");
        const timedOutClient = new FakeSshClient();
        const stalledSftp = new FakeSftpClient();
        stalledSftp.hangFastPut = true;
        timedOutClient.sftpClient = stalledSftp;
        const replacementClient = new FakeSshClient();
        const clients = [timedOutClient, replacementClient];
        const transport = new SshTransport({
            host: "server.example.com", port: 22, username: "root", hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => clients.shift() as never });

        try {
            await expect(transport.upload(localPath, "/tmp/release/artifact", { timeoutMs: 10 })).rejects.toThrow("SFTP upload timed out");
            expect(timedOutClient.endCalls).toBeGreaterThan(0);
            expect(await transport.ping()).toBe(false);
            expect(replacementClient.connectOptions).toBeDefined();
        } finally {
            transport.close();
            rmSync(fixtureDirectory, { recursive: true, force: true });
        }
    });
});
