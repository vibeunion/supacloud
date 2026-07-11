import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createStudioSessionService } from "../../src/services/studio-session.service";

describe("StudioSessionService", () => {
  test("stores only a SHA-256 token hash and issues a 15 minute opaque session", async () => {
    const created: Array<Record<string, unknown>> = [];
    const now = new Date("2026-07-11T00:00:00.000Z");
    const service = createStudioSessionService({
      repository: {
        create: async (input) => {
          created.push(input);
          return {
            id: "session-1",
            username: input.username,
            expiresAt: input.expiresAt,
          };
        },
        findActiveByTokenHash: async () => null,
        rotate: async () => null,
        revoke: async () => false,
      },
      now: () => now,
      expectedUsername: "admin",
      expectedPassword: "correct-password",
      randomToken: () => "opaque-session-token",
    });

    const result = await service.login({
      username: "admin",
      password: "correct-password",
      clientIp: "203.0.113.9",
      userAgent: "test-agent",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected login success");
    expect(result.token).toBe("opaque-session-token");
    expect(result.expiresAt.toISOString()).toBe("2026-07-11T00:15:00.000Z");
    expect(created).toHaveLength(1);
    expect(created[0]?.tokenHash).toBe(
      createHash("sha256").update("opaque-session-token").digest("hex"),
    );
    expect(JSON.stringify(created[0])).not.toContain("opaque-session-token");
  });

  test("locks independently by normalized username and client IP after repeated failures", async () => {
    const repository = {
      create: async () => {
        throw new Error("unexpected session creation");
      },
      findActiveByTokenHash: async () => null,
      rotate: async () => null,
      revoke: async () => false,
    };
    const service = createStudioSessionService({
      repository,
      expectedUsername: "admin",
      expectedPassword: "correct-password",
      maxFailures: 2,
      failureWindowMs: 60_000,
      lockoutMs: 120_000,
    });

    expect((await service.login({ username: "ADMIN", password: "wrong", clientIp: "198.51.100.1", userAgent: "test" })).reason).toBe("invalid_credentials");
    expect((await service.login({ username: "admin", password: "wrong", clientIp: "198.51.100.2", userAgent: "test" })).reason).toBe("locked");
    expect((await service.login({ username: "admin", password: "wrong", clientIp: "198.51.100.3", userAgent: "test" })).reason).toBe("locked");

    expect((await service.login({ username: "user-a", password: "wrong", clientIp: "203.0.113.20", userAgent: "test" })).reason).toBe("invalid_credentials");
    expect((await service.login({ username: "user-b", password: "wrong", clientIp: "203.0.113.20", userAgent: "test" })).reason).toBe("locked");
    expect((await service.login({ username: "user-c", password: "wrong", clientIp: "203.0.113.20", userAgent: "test" })).reason).toBe("locked");
  });

  test("shares one failure bucket across rotated invalid usernames", async () => {
    const service = createStudioSessionService({
      repository: {
        create: async () => { throw new Error("unexpected session creation"); },
        findActiveByTokenHash: async () => null,
        rotate: async () => null,
        revoke: async () => false,
      },
      expectedUsername: "admin",
      expectedPassword: "correct-password",
      maxFailures: 2,
    });

    expect((await service.login({ username: "user-a", password: "wrong", clientIp: "192.0.2.1", userAgent: "test" })).reason).toBe("invalid_credentials");
    expect((await service.login({ username: "user-b", password: "wrong", clientIp: "192.0.2.2", userAgent: "test" })).reason).toBe("locked");
    expect((await service.login({ username: "user-c", password: "wrong", clientIp: "192.0.2.3", userAgent: "test" })).reason).toBe("locked");
  });

  test("uses a bounded overflow bucket when an attacker rotates client IPs", async () => {
    let sessionId = 0;
    const service = createStudioSessionService({
      repository: {
        create: async (input) => ({
          id: `session-${++sessionId}`,
          username: input.username,
          expiresAt: input.expiresAt,
        }),
        findActiveByTokenHash: async () => null,
        rotate: async () => null,
        revoke: async () => false,
      },
      expectedUsername: "admin",
      expectedPassword: "correct-password",
      maxFailures: 2,
      maxFailureBuckets: 2,
    });
    const attempt = (password: string, clientIp: string) => service.login({
      username: "admin",
      password,
      clientIp,
      userAgent: "test",
    });

    await attempt("wrong", "192.0.2.1");
    await attempt("correct-password", "192.0.2.9");
    await attempt("wrong", "192.0.2.2");
    await attempt("correct-password", "192.0.2.9");
    expect((await attempt("wrong", "192.0.2.3")).reason).toBe("invalid_credentials");
    await attempt("correct-password", "192.0.2.1");
    expect((await attempt("wrong", "192.0.2.4")).reason).toBe("locked");
    expect((await attempt("wrong", "192.0.2.5")).reason).toBe("locked");
  });
});
