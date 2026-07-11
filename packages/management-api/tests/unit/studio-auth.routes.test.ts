import { describe, expect, test } from "bun:test";
import { createStudioAuthRoutes } from "../../src/routes/studio-auth";
import type { StudioSessionService } from "../../src/services/studio-session.service";

describe("Studio auth routes", () => {
  test("login sets a secure HttpOnly opaque-session cookie without returning the token", async () => {
    const service: StudioSessionService = {
      login: async () => ({
        ok: true,
        token: "raw-session-token",
        username: "admin",
        expiresAt: new Date("2026-07-11T00:15:00.000Z"),
      }),
      verify: async () => null,
      refresh: async () => null,
      revoke: async () => false,
    };
    const app = createStudioAuthRoutes({
      service,
      audit: async () => undefined,
    });

    const response = await app.handle(new Request("https://console.example.com/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": "203.0.113.10",
      },
      body: JSON.stringify({ username: "admin", password: "correct-password" }),
    }));

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") || "";
    expect(cookie).toContain("__Host-supacloud_session=raw-session-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=900");
    const body = await response.json() as Record<string, unknown>;
    expect(body.token).toBeUndefined();
    expect(body).toMatchObject({ success: true, username: "admin" });
  });

  test("refresh rejects a cross-origin cookie request before rotating the session", async () => {
    let refreshCalls = 0;
    const service: StudioSessionService = {
      login: async () => ({ ok: false, reason: "invalid_credentials" }),
      verify: async () => null,
      refresh: async () => {
        refreshCalls += 1;
        return null;
      },
      revoke: async () => false,
    };
    const app = createStudioAuthRoutes({ service, audit: async () => undefined });

    const response = await app.handle(new Request("https://console.example.com/auth/refresh", {
      method: "POST",
      headers: {
        cookie: "__Host-supacloud_session=current-token",
        origin: "https://evil.example.net",
      },
    }));

    expect(response.status).toBe(403);
    expect(refreshCalls).toBe(0);
  });

  test("rejects cross-origin login before checking credentials", async () => {
    let loginCalls = 0;
    const actions: string[] = [];
    const service: StudioSessionService = {
      login: async () => {
        loginCalls += 1;
        return { ok: false, reason: "invalid_credentials" };
      },
      verify: async () => null,
      refresh: async () => null,
      revoke: async () => false,
    };
    const app = createStudioAuthRoutes({
      service,
      audit: async (input) => { actions.push(input.action || ""); },
    });

    const response = await app.handle(new Request("https://console.example.com/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example.net",
      },
      body: JSON.stringify({ username: "admin", password: "stolen-password" }),
    }));

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(loginCalls).toBe(0);
    expect(actions).toEqual(["studio_login_csrf_denied"]);
  });

  test("rejects cross-site browser login even when Origin is omitted", async () => {
    let loginCalls = 0;
    const service: StudioSessionService = {
      login: async () => {
        loginCalls += 1;
        return { ok: false, reason: "invalid_credentials" };
      },
      verify: async () => null,
      refresh: async () => null,
      revoke: async () => false,
    };
    const app = createStudioAuthRoutes({ service, audit: async () => undefined });

    const response = await app.handle(new Request("https://console.example.com/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    }));

    expect(response.status).toBe(403);
    expect(loginCalls).toBe(0);
  });

  test("returns a retry window and audits locked login attempts", async () => {
    const actions: string[] = [];
    const service: StudioSessionService = {
      login: async () => ({ ok: false, reason: "locked", retryAfterSeconds: 120 }),
      verify: async () => null,
      refresh: async () => null,
      revoke: async () => false,
    };
    const app = createStudioAuthRoutes({
      service,
      audit: async (input) => { actions.push(input.action || ""); },
    });

    const response = await app.handle(new Request("https://console.example.com/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(actions).toEqual(["studio_login_locked"]);
  });

  test("session inspection and same-origin logout use and revoke the opaque cookie", async () => {
    const revoked: string[] = [];
    const service: StudioSessionService = {
      login: async () => ({ ok: false, reason: "invalid_credentials" }),
      verify: async (token) => token === "active-token"
        ? { id: "session-1", username: "admin", expiresAt: new Date("2026-07-11T00:15:00.000Z") }
        : null,
      refresh: async () => null,
      revoke: async (token) => {
        revoked.push(token);
        return true;
      },
    };
    const app = createStudioAuthRoutes({ service, audit: async () => undefined });

    const sessionResponse = await app.handle(new Request("https://console.example.com/auth/session", {
      headers: { cookie: "__Host-supacloud_session=active-token" },
    }));
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toMatchObject({ valid: true, username: "admin" });

    const logoutResponse = await app.handle(new Request("https://console.example.com/auth/logout", {
      method: "POST",
      headers: {
        cookie: "__Host-supacloud_session=active-token",
        origin: "https://console.example.com",
      },
    }));
    expect(logoutResponse.status).toBe(200);
    expect(revoked).toEqual(["active-token"]);
    expect(logoutResponse.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
