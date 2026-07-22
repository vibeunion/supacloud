import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertRealtimeSecretAlignment, RealtimeService, validateRealtimeSecretConfiguration } from "../../src/services/realtime.service";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("RealtimeService tenant payloads", () => {
  test("fails closed when the API or container verification secret drifts", () => {
    expect(() => assertRealtimeSecretAlignment({
      canonicalSecret: "canonical-realtime-secret",
      configuredApiSecret: "stale-api-secret",
    })).toThrow("does not match");
    expect(() => assertRealtimeSecretAlignment({
      canonicalSecret: "canonical-realtime-secret",
      containerApiSecret: "stale-container-secret",
    })).toThrow("does not match");
    expect(() => assertRealtimeSecretAlignment({
      canonicalSecret: "canonical-realtime-secret",
      configuredApiSecret: "canonical-realtime-secret",
      containerApiSecret: "canonical-realtime-secret",
    })).not.toThrow();
  });

  test("fails closed when the required container verification secret is missing or empty", () => {
    for (const containerApiSecret of [undefined, "", "   "]) {
      expect(() => assertRealtimeSecretAlignment({
        canonicalSecret: "canonical-realtime-secret",
        containerApiSecret,
        requireContainerApiSecret: true,
      })).toThrow("container API JWT secret is missing");
    }
  });

  test("fails closed when the container env file is missing or omits API_JWT_SECRET", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-realtime-secret-"));
    try {
      expect(() => validateRealtimeSecretConfiguration(join(dir, "missing.env")))
        .toThrow("container API JWT secret is missing");
      const emptyFile = join(dir, "empty.env");
      writeFileSync(emptyFile, "OTHER_SECRET=value\n");
      expect(() => validateRealtimeSecretConfiguration(emptyFile))
        .toThrow("container API JWT secret is missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("registerTenant disables per-tenant postgres SSL for local service databases", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 201 });
    }) as typeof fetch;

    const service = new RealtimeService();
    const ok = await service.registerTenant({
      projectRef: "testref",
      dbName: "postgres",
      dbPassword: "postgres",
      jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    });

    expect(ok).toBe(true);
    const body = JSON.parse(String(calls[0]?.init?.body ?? "{}"));
    const settings = body.tenant.extensions[0].settings;
    expect(settings.ssl_enforced).toBe(false);
    expect(settings.db_user).toBe("supabase_admin");
    expect(settings.db_password).toBe("postgres");
    expect(settings.db_user_realtime).toBe("supabase_realtime_admin");
    expect(settings.db_pass_realtime).toBe("postgres");
  });
});

describe("RealtimeService registration retry", () => {
  // 测试内缩短 backoff，避免默认 3s × 重试次数撑爆单测 5s 超时
  const origBackoff = process.env.REALTIME_REGISTER_BACKOFF_MS;
  const origAttempts = process.env.REALTIME_REGISTER_MAX_ATTEMPTS;
  beforeEach(() => {
    process.env.REALTIME_REGISTER_BACKOFF_MS = "1";
    process.env.REALTIME_REGISTER_MAX_ATTEMPTS = "5";
  });
  afterEach(() => {
    if (origBackoff === undefined) delete process.env.REALTIME_REGISTER_BACKOFF_MS;
    else process.env.REALTIME_REGISTER_BACKOFF_MS = origBackoff;
    if (origAttempts === undefined) delete process.env.REALTIME_REGISTER_MAX_ATTEMPTS;
    else process.env.REALTIME_REGISTER_MAX_ATTEMPTS = origAttempts;
  });

  test("registerTenant retries on connection error until Realtime container becomes ready", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      // 前 2 次模拟容器未就绪（连接级失败），第 3 次容器拉起返回 201
      if (attempts < 3) {
        throw new Error("Unable to connect. Is the computer able to access the url?");
      }
      return new Response("{}", { status: 201 });
    }) as typeof fetch;

    const service = new RealtimeService();
    const ok = await service.registerTenant({
      projectRef: "retryref",
      dbName: "postgres",
      dbPassword: "postgres",
      jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    });

    expect(ok).toBe(true);
    expect(attempts).toBe(3);
  });

  test("registerTenant does not retry on HTTP error responses (e.g. 4xx)", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      // 逻辑错误：立即返回 400，不应重试
      return new Response("bad request", { status: 400 });
    }) as typeof fetch;

    const service = new RealtimeService();
    const ok = await service.registerTenant({
      projectRef: "badref",
      dbName: "postgres",
      dbPassword: "postgres",
      jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    });

    expect(ok).toBe(false);
    expect(attempts).toBe(1);
  });
});
