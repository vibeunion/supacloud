import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import { getAuditLog, redactSshOutput, SshTransport } from "./ssh";

const TEST_HOST_KEY = Buffer.from("supacloud-test-host-key");
const TEST_HOST_FINGERPRINT = `SHA256:${createHash("sha256").update(TEST_HOST_KEY).digest("base64").replace(/=+$/, "")}`;

class FakeSshClient extends EventEmitter {
    connectOptions: Record<string, unknown> | undefined;
    connectError: Error | undefined;
    stdout = Buffer.from("ok\n");
    stderrOutput = Buffer.alloc(0);

    connect(options: Record<string, unknown>): this {
        this.connectOptions = options;
        queueMicrotask(() => this.connectError ? this.emit("error", this.connectError) : this.emit("ready"));
        return this;
    }

    exec(_command: string, callback: (error: Error | undefined, stream: EventEmitter & { stderr: EventEmitter }) => void): void {
        const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        stream.stderr = new EventEmitter();
        callback(undefined, stream);
        queueMicrotask(() => {
            if (this.stdout.length > 0) stream.emit("data", this.stdout);
            if (this.stderrOutput.length > 0) stream.stderr.emit("data", this.stderrOutput);
            stream.emit("close", 0);
        });
    }

    end(): void {}
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
});
