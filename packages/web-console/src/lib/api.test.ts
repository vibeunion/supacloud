import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { apiClient, getStudioSession, loginStudio, logoutStudio } from "./api";

const originalFetch = globalThis.fetch;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

describe("apiClient", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("normalizes empty error responses to JSON", async () => {
    globalThis.fetch = async () => new Response("", {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "Content-Type": "text/plain" },
    });

    const response = await apiClient("/v1/projects");

    expect(response.status).toBe(502);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({
      message: "Bad Gateway",
      code: "502",
    });
  });

  test("uses the HttpOnly cookie session without injecting a browser token", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_input, init) => {
      capturedInit = init;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await apiClient("/v1/projects", {
      headers: { "X-Test": "1" },
    });

    expect(capturedInit?.credentials).toBe("include");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.get("X-Test")).toBe("1");
  });

  test("normalizes the cookie login, session, and logout contract without returning a token", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const responses = [
      new Response(JSON.stringify({ success: true, username: "admin" }), { status: 200 }),
      new Response(JSON.stringify({
        valid: true,
        username: "admin",
        expires_at: "2026-07-24T03:00:00.000Z",
      }), { status: 200 }),
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    ];
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return responses.shift()!;
    };

    const login = await loginStudio("admin", "correct-password");
    const session = await getStudioSession();
    const logout = await logoutStudio();

    expect(login).toEqual({ success: true, username: "admin" });
    expect(session).toEqual({
      authenticated: true,
      username: "admin",
      expiresAt: "2026-07-24T03:00:00.000Z",
    });
    expect(logout).toBe(true);
    expect(calls.map(call => [call.input, call.init?.method, call.init?.credentials])).toEqual([
      ["/auth/login", "POST", "include"],
      ["/auth/session", "GET", "include"],
      ["/auth/logout", "POST", "include"],
    ]);
    expect(JSON.stringify(login)).not.toContain("token");
  });

  test("preserves a managed API 401 when the cookie session remains valid", async () => {
    const location = {
      pathname: "/project/proj_1",
      href: "https://console.example.com/project/proj_1",
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location },
    });
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === "/auth/session") {
        return Response.json({ valid: true, username: "admin" });
      }
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    };

    const response = await apiClient("/v1/projects");

    expect(response.status).toBe(401);
    expect(location.href).toBe("https://console.example.com/project/proj_1");
    expect(calls).toEqual(["/v1/projects", "/auth/session"]);
  });

  test("refreshes an expiring Studio session once before a managed API request", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { pathname: "/project/proj_1", href: "https://console.example.com/project/proj_1" } },
    });
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === "/auth/session") {
        return new Response(JSON.stringify({
          valid: true,
          username: "admin",
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/auth/refresh") {
        return new Response(JSON.stringify({
          success: true,
          username: "admin",
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };

    await getStudioSession();
    const response = await apiClient("/v1/projects");

    expect(response.status).toBe(200);
    expect(calls).toEqual(["/auth/session", "/auth/refresh", "/v1/projects"]);
  });

  test("shares one refresh across concurrent managed API requests", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { pathname: "/project/proj_1", href: "https://console.example.com/project/proj_1" } },
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === "/auth/session") {
        return Response.json({
          valid: true,
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        });
      }
      if (url === "/auth/refresh") {
        await refreshGate;
        return Response.json({
          success: true,
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        });
      }
      return Response.json({ ok: true });
    };

    await getStudioSession();
    const requests = Promise.all([
      apiClient("/v1/projects/first"),
      apiClient("/v1/projects/second"),
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.filter((url) => url === "/auth/refresh")).toHaveLength(1);
    releaseRefresh();
    const responses = await requests;
    expect(responses.every((response) => response.ok)).toBe(true);
  });

  test("continues the managed request when session refresh hits a network error", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { pathname: "/project/proj_1", href: "https://console.example.com/project/proj_1" } },
    });
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === "/auth/session") {
        return Response.json({
          valid: true,
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        });
      }
      if (url === "/auth/refresh") throw new TypeError("network unavailable");
      return Response.json({ ok: true });
    };

    await getStudioSession();
    const response = await apiClient("/v1/projects");

    expect(response.status).toBe(200);
    expect(calls).toEqual(["/auth/session", "/auth/refresh", "/v1/projects"]);
  });

  test("does not hide unexpected session refresh errors", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { pathname: "/project/proj_1", href: "https://console.example.com/project/proj_1" } },
    });
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === "/auth/session") {
        return Response.json({
          valid: true,
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        });
      }
      throw new Error("unexpected refresh failure");
    };

    await getStudioSession();

    await expect(apiClient("/v1/projects")).rejects.toThrow("unexpected refresh failure");
  });

  test("Studio browser code never persists or forwards the session token", () => {
    const sources = [
      "./admin/auth.ts",
      "./admin/provider.ts",
      "../routes/+layout.svelte",
      "../routes/login/+page.svelte",
      "../routes/project/[ref]/tasks/+page.svelte",
    ].map(relativePath => readFileSync(new URL(relativePath, import.meta.url), "utf8"));

    for (const source of sources) {
      expect(source).not.toContain("supacloud_session");
      expect(source).not.toContain("supacloud_master_token");
    }
    expect(sources.at(-1)).not.toContain("project: projectRef ?? \"\", token");
  });
});
