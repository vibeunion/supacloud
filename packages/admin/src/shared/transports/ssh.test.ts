import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    getAuditLog,
    outputRequiresSecretRedaction,
    redactSshOutput,
    SshCommandOutcomeUnknownError,
    SshTransport,
    stripTerminalControls,
} from "./ssh";

const TEST_HOST_KEY = Buffer.from("supacloud-test-host-key");
const TEST_HOST_FINGERPRINT = `SHA256:${createHash("sha256").update(TEST_HOST_KEY).digest("base64").replace(/=+$/, "")}`;
const SAFETY_METADATA = {
    backup_id: "control-plane-20260819T000000Z-00000000-0000-4000-8000-000000000001",
    backup_directory: "/var/lib/supacloud/backups/control-plane-upgrades/control-plane-20260819T000000Z-00000000-0000-4000-8000-000000000001",
    bytes: 2048,
    completed_at: "2026-08-19T00:00:00.000Z",
    sha256: "c".repeat(64),
    schema: "supacloud.control-plane-upgrade-safety.v1",
    current_key_checkpoint_present: true,
    candidate_counts: {
        deprecated_webhook_secrets: 0,
        legacy_deployment_history_rows: 0,
        legacy_project_config_rows: 0,
        opaque_key_backfill_projects: 1,
        stored_secret_values: 2,
    },
};

function safetyMetadataLine(receipt: unknown = SAFETY_METADATA): string {
    return `SUPACLOUD_CONTROL_PLANE_UPGRADE_SAFETY=${JSON.stringify(receipt)}`;
}

class FakeSshClient extends EventEmitter {
    connectOptions: Record<string, unknown> | undefined;
    connectError: Error | undefined;
    stdout = Buffer.from("ok\n");
    stderrOutput = Buffer.alloc(0);
    stallCommand = false;
    closeWithoutExitStatus = false;
    completionDelayMs = 0;
    synchronousExecError: Error | undefined;
    streamErrorAfterDispatch: Error | undefined;
    terminalCloseEmitted = false;
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
        if (this.synchronousExecError) throw this.synchronousExecError;
        if (this.activeChannels >= this.maxConcurrentChannels) {
            callback(new Error("open failed: administratively prohibited: open failed"), undefined as never);
            return;
        }
        const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        stream.stderr = new EventEmitter();
        callback(undefined, stream);
        if (this.stallCommand) return;
        const complete = () => {
            if (this.streamErrorAfterDispatch) {
                stream.emit("error", this.streamErrorAfterDispatch);
                return;
            }
            if (this.stdout.length > 0) stream.emit("data", this.stdout);
            if (this.stderrOutput.length > 0) stream.stderr.emit("data", this.stderrOutput);
            this.terminalCloseEmitted = true;
            if (this.closeWithoutExitStatus) stream.emit("close");
            else stream.emit("close", 0);
        };
        if (this.completionDelayMs > 0) setTimeout(complete, this.completionDelayMs);
        else queueMicrotask(complete);
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
            "postgresql://:empty-user-password@localhost/postgres",
            "Authorization: Bearer bearer-token",
            "PUBLIC_DOMAIN=api.example.com",
        ].join("\n"));

        expect(output).not.toContain("database-password");
        expect(output).not.toContain("jwt secret with spaces");
        expect(output).not.toContain("api-token");
        expect(output).not.toContain("url-password");
        expect(output).not.toContain("empty-user-password");
        expect(output).not.toContain("bearer-token");
        expect(output).toContain("PUBLIC_DOMAIN=api.example.com");
        expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(5);
        expect(redactSshOutput('{"token":"[REDACTED]"}')).toBe('{"token":"[REDACTED]"}');
        const escapedOutput = redactSshOutput(String.raw`{\"token\":\"raw-token\"}suffix`);
        expect(escapedOutput).toBe("[REDACTED: structured secret output]");
        expect(escapedOutput).not.toContain("raw-token");
        for (const structuredSecret of [
            String.raw`{"token":"prefix-\\"synthetic-escaped-tail"}`,
            String.raw`{"to\\u006ben":"unicode-token"}`,
            String.raw`{\"to\\u006ben\":\"escaped-unicode-token\"}`,
            String.raw`{to\\u006ben:"unquoted-unicode-token"}`,
            String.raw`{to\\u{006b}en:"codepoint-unicode-token"}`,
        ]) {
            expect(redactSshOutput(structuredSecret)).toBe("[REDACTED: structured secret output]");
        }
    });

    test("marks command output when transport redaction changed it", async () => {
        const client = new FakeSshClient();
        client.stdout = Buffer.from("DATABASE_URL=postgres://admin:database-password@localhost/postgres\n");
        const transport = new SshTransport({
            host: "server.example.com",
            port: 22,
            username: "root",
            hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => client as never });

        try {
            const result = await transport.exec("hostname");
            expect(result.stdout).toContain("[REDACTED]");
            expect(result.stdout).not.toContain("database-password");
            expect(result.stdoutRedacted).toBe(true);
        } finally {
            transport.close();
        }
    });

    test("does not treat upgrade safety metadata or terminal color as secret redaction", async () => {
        const receipt = safetyMetadataLine();
        const colored = `\u001b[32m${receipt}\u001b[0m\n\u001b]0;upgrade\u0007`;
        expect(redactSshOutput(receipt)).toBe(receipt);
        expect(stripTerminalControls(colored)).toBe(`${receipt}\n`);
        expect(outputRequiresSecretRedaction(colored)).toBe(false);
        expect(outputRequiresSecretRedaction("\u001b[31mPOSTGRES_PASSWORD=database-password\u001b[0m")).toBe(true);

        const client = new FakeSshClient();
        client.stdout = Buffer.from(colored);
        const transport = new SshTransport({
            host: "server.example.com",
            port: 22,
            username: "root",
            hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => client as never });
        try {
            const result = await transport.exec("tail -n 80 -- /var/log/supacloud/upgrade.log");
            expect(result.stdout).toBe(`${receipt}\n`);
            expect(result.stdoutRedacted).toBe(false);
        } finally {
            transport.close();
        }
    });

    test("only exempts numeric and boolean safety metadata at the receipt schema and path", () => {
        for (const field of Object.keys(SAFETY_METADATA.candidate_counts).filter(name => /secret|key/.test(name))) {
            // Boundaries: safe integer / negative / fractional / unsafe / string / array / object / null.
            for (const invalidCount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "synthetic-secret", ["synthetic-secret"], { value: "synthetic-secret" }, null, true]) {
                const output = safetyMetadataLine({
                    ...SAFETY_METADATA,
                    candidate_counts: { ...SAFETY_METADATA.candidate_counts, [field]: invalidCount },
                });
                expect(outputRequiresSecretRedaction(output)).toBe(true);
                expect(redactSshOutput(output)).toBe("[REDACTED: structured secret output]");
            }
        }
        for (const invalidFlag of ["synthetic-secret", ["synthetic-secret"], { value: "synthetic-secret" }, null, 1]) {
            expect(outputRequiresSecretRedaction(safetyMetadataLine({
                ...SAFETY_METADATA, current_key_checkpoint_present: invalidFlag,
            }))).toBe(true);
        }
        for (const output of [
            safetyMetadataLine({ ...SAFETY_METADATA, schema: "untrusted.schema" }),
            safetyMetadataLine({ ...SAFETY_METADATA, backup_directory: "/tmp/untrusted" }),
            safetyMetadataLine({ ...SAFETY_METADATA, nested: { stored_secret_values: "synthetic-secret" } }),
            '{"stored_secret_values":2}',
            '{"current_key_checkpoint_present":true}',
            '{"stored_secret_values":"synthetic-secret"}',
            '{"stored_secret_values":"synthetic-secret","stored_secret_values":"[REDACTED]"}',
            String.raw`{\"stored_secret_values\":\"synthetic-secret\"}suffix`,
            String.raw`{"stored\u005fsecret_values":"synthetic-secret"}`,
            String.raw`{"stored\\u005fsecret_values":"synthetic-secret"}`,
            String.raw`{stored\u{005f}secret_values:"synthetic-secret"}`,
            safetyMetadataLine().replace('"stored_secret_values":2', '"stored_secret_values":"synthetic-secret","stored_secret_values":2'),
            safetyMetadataLine().replace('"stored_secret_values":2', '"stored_secret_values":"synthetic-secret"'),
            safetyMetadataLine().slice(0, -1),
        ]) {
            expect(outputRequiresSecretRedaction(output)).toBe(true);
            expect(redactSshOutput(output)).not.toContain("synthetic-secret");
        }
        for (const prefix of ["SAFETY", "PREFLIGHT"]) {
            const output = safetyMetadataLine().replace("UPGRADE_SAFETY=", `UPGRADE_${prefix}=`);
            expect(outputRequiresSecretRedaction(output)).toBe(false);
            expect(redactSshOutput(output)).toBe(output);
        }
        const boundaryReceipt = safetyMetadataLine({
            ...SAFETY_METADATA,
            current_key_checkpoint_present: false,
            candidate_counts: { ...SAFETY_METADATA.candidate_counts, stored_secret_values: Number.MAX_SAFE_INTEGER },
        });
        expect(outputRequiresSecretRedaction(boundaryReceipt)).toBe(false);
        expect(redactSshOutput(boundaryReceipt)).toBe(boundaryReceipt);
    });

    test("both collectors redact metadata smuggling and preserve validated receipts", async () => {
        const receipt = safetyMetadataLine();
        const client = new FakeSshClient();
        const output = `${receipt}\n{"stored_secret_values":["synthetic-secret"]}\n`
            + '{"stored_secret_values":"synthetic-secret","stored_secret_values":"[REDACTED]"}\n';
        client.stdout = Buffer.from(output);
        client.stderrOutput = Buffer.from(output);
        const transport = new SshTransport({
            host: "server.example.com", port: 22, username: "root", hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => client as never });
        try {
            const result = await transport.exec("hostname");
            expect(result.stdout).toBe(`${receipt}\n[REDACTED: structured secret output]\n[REDACTED: structured secret output]\n`);
            expect(result.stderr).toBe(result.stdout);
            expect(result.stdoutRedacted).toBe(true);
            expect(result.stderrRedacted).toBe(true);
            expect(result.stdoutTruncated).toBe(false);
            expect(result.stderrTruncated).toBe(false);
        } finally {
            transport.close();
        }
    });

    test("OSC normalization stops at the first BEL or ST across multiple controls", async () => {
        const receipt = safetyMetadataLine();
        for (const firstTerminator of ["\u0007", "\u001b\\"]) {
            for (const secondTerminator of ["\u0007", "\u001b\\"]) {
                const output = `\u001b]0;before${firstTerminator}${receipt}\n\u001b]0;after${secondTerminator}`;
                expect(stripTerminalControls(output)).toBe(`${receipt}\n`);
                expect(outputRequiresSecretRedaction(output)).toBe(false);
                const secretOutput = `\u001b]0;before${firstTerminator}POSTGRES_PASSWORD=synthetic-secret\n\u001b]0;after${secondTerminator}`;
                expect(stripTerminalControls(secretOutput)).toBe("POSTGRES_PASSWORD=synthetic-secret\n");
                expect(outputRequiresSecretRedaction(secretOutput)).toBe(true);
                const client = new FakeSshClient();
                client.stdout = Buffer.from(output);
                client.stderrOutput = Buffer.from(secretOutput);
                const transport = new SshTransport({
                    host: "server.example.com", port: 22, username: "root", hostFingerprint: TEST_HOST_FINGERPRINT,
                }, { clientFactory: () => client as never });
                try {
                    const result = await transport.exec("hostname");
                    expect(result.stdout).toBe(`${receipt}\n`);
                    expect(result.stdoutRedacted).toBe(false);
                    expect(result.stderr).toBe("POSTGRES_PASSWORD=[REDACTED]\n");
                    expect(result.stderrRedacted).toBe(true);
                } finally {
                    transport.close();
                }
            }
        }
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
            const timedOut = transport.exec("long-running-upgrade", 10);
            await expect(timedOut).rejects.toBeInstanceOf(SshCommandOutcomeUnknownError);
            await expect(timedOut).rejects.toMatchObject({
                code: "OUTCOME_UNKNOWN",
                message: "SSH command timed out after 10ms; remote outcome is unknown",
            });
            expect(stalledClient.endCalls).toBe(1);

            const cleanup = await transport.exec("remove-upgrade-helper");
            expect(cleanup.success).toBe(true);
            expect(clientIndex).toBe(2);
            expect(cleanupClient.connectOptions?.host).toBe("server.example.com");
        } finally {
            transport.close();
        }
    });

    test("discards a connection when exec throws synchronously before dispatch", async () => {
        const disconnectedClient = new FakeSshClient();
        disconnectedClient.synchronousExecError = new Error("Not connected");
        const cleanupClient = new FakeSshClient();
        const clients = [disconnectedClient, cleanupClient];
        let clientIndex = 0;
        const transport = new SshTransport({
            host: "server.example.com",
            port: 22,
            username: "root",
            hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => clients[clientIndex++] as never });

        try {
            await expect(transport.exec("long-running-upgrade", 10)).rejects.toThrow("Not connected");
            expect(disconnectedClient.endCalls).toBe(1);
            expect((await transport.exec("remove-upgrade-helper")).success).toBe(true);
            expect(clientIndex).toBe(2);
        } finally {
            transport.close();
        }
    });

    test("keeps timeout unknown when the remote stream closes successfully later", async () => {
        const client = new FakeSshClient();
        client.completionDelayMs = 20;
        const transport = new SshTransport({
            host: "server.example.com", port: 22, username: "root",
            hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => client as never });

        try {
            await expect(transport.exec("long-running-upgrade", 5)).rejects.toMatchObject({
                code: "OUTCOME_UNKNOWN",
            });
            await new Promise(resolve => setTimeout(resolve, 25));
            expect(client.terminalCloseEmitted).toBe(true);
            expect(client.endCalls).toBe(1);
        } finally {
            transport.close();
        }
    });

    test("keeps post-dispatch stream errors unknown without reflecting their message", async () => {
        const client = new FakeSshClient();
        client.streamErrorAfterDispatch = new Error("TOKEN=stream-secret");
        const transport = new SshTransport({
            host: "server.example.com", port: 22, username: "root",
            hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => client as never });

        try {
            let failure: unknown;
            try {
                await transport.exec("long-running-upgrade");
            } catch (error: unknown) {
                failure = error;
            }
            expect(failure).toBeInstanceOf(SshCommandOutcomeUnknownError);
            expect(String(failure)).not.toContain("stream-secret");
            expect(client.endCalls).toBe(1);
        } finally {
            transport.close();
        }
    });

    test("marks a dispatched command without terminal status as outcome unknown", async () => {
        const client = new FakeSshClient();
        client.closeWithoutExitStatus = true;
        const transport = new SshTransport({
            host: "server.example.com",
            port: 22,
            username: "root",
            hostFingerprint: TEST_HOST_FINGERPRINT,
        }, { clientFactory: () => client as never });

        try {
            await expect(transport.exec("long-running-upgrade")).rejects.toMatchObject({
                code: "OUTCOME_UNKNOWN",
                message: "SSH command stream closed without a terminal status; remote outcome is unknown",
            });
            expect(client.endCalls).toBe(1);
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
