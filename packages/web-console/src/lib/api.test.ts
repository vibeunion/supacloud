import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { apiClient, getStudioSession, loginStudio, logoutStudio } from "./api";

const originalFetch = globalThis.fetch;

describe("apiClient", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
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
      new Response(JSON.stringify({ valid: true, username: "admin" }), { status: 200 }),
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
    expect(session).toEqual({ authenticated: true, username: "admin" });
    expect(logout).toBe(true);
    expect(calls.map(call => [call.input, call.init?.method, call.init?.credentials])).toEqual([
      ["/auth/login", "POST", "include"],
      ["/auth/session", "GET", "include"],
      ["/auth/logout", "POST", "include"],
    ]);
    expect(JSON.stringify(login)).not.toContain("token");
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
