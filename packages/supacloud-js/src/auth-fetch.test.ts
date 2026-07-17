import { describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudOAuthFetch } from "./auth-fetch";

declare const Bun: {
  serve(options: {
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): {
    port: number;
    stop(closeActiveConnections?: boolean): void | Promise<void>;
  };
};

describe("createSupaCloudOAuthFetch", () => {
  test("passes non-refresh requests through unchanged", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const transport = createSupaCloudOAuthFetch({
      clientId: "client_1",
      fetch: async (input, init) => {
        calls.push({ input, init });
        return new Response("ok");
      },
    });

    await transport("https://auth.example.com/auth/v1/user", { method: "GET" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.input).toBe("https://auth.example.com/auth/v1/user");
    expect(calls[0]?.init).toMatchObject({ method: "GET" });
  });

  test("rewrites Supabase JSON refresh requests to the OAuth endpoint", async () => {
    const calls: Request[] = [];
    const transport = createSupaCloudOAuthFetch({
      clientId: "client_1",
      tokenEndpoint: "https://auth.example.com/auth/v1/oauth/token",
      fetch: async (input) => {
        calls.push(input instanceof Request ? input : new Request(input));
        return new Response("ok");
      },
    });

    await transport("https://auth.example.com/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: {
        apikey: "anon-key",
        authorization: "Bearer current-session-token",
        cookie: "session=browser-cookie",
        "proxy-authorization": "Basic proxy-credentials",
        "x-client-info": "supabase-js",
      },
      body: JSON.stringify({ refresh_token: "refresh_1" }),
    });

    const captured = calls[0]!;
    expect(captured.url).toBe("https://auth.example.com/auth/v1/oauth/token");
    expect(captured.method).toBe("POST");
    expect(captured.headers.get("apikey")).toBe("anon-key");
    expect(captured.headers.get("authorization")).toBe(null);
    expect(captured.headers.get("cookie")).toBe(null);
    expect(captured.headers.get("proxy-authorization")).toBe(null);
    expect(captured.headers.get("x-client-info")).toBe("supabase-js");
    expect(captured.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(await captured.text()).toBe(
      "refresh_token=refresh_1&grant_type=refresh_token&client_id=client_1",
    );
  });

  test("preserves an existing client_id and supports Request input", async () => {
    const calls: Request[] = [];
    const transport = createSupaCloudOAuthFetch({
      clientId: "client_default",
      fetch: async (input) => {
        calls.push(input instanceof Request ? input : new Request(input));
        return new Response("ok");
      },
    });
    const request = new Request("https://auth.example.com/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: "refresh_token=refresh_2&client_id=client_existing",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    await transport(request);
    const captured = calls[0]!;
    expect(captured.url).toBe("https://auth.example.com/auth/v1/oauth/token");
    expect(await captured.text()).toBe(
      "refresh_token=refresh_2&client_id=client_existing&grant_type=refresh_token",
    );
  });

  test("preserves a reverse-proxy path prefix and rejects cross-origin endpoints", async () => {
    const calls: Request[] = [];
    const transport = createSupaCloudOAuthFetch({
      clientId: "client_1",
      fetch: async (input) => {
        calls.push(input instanceof Request ? input : new Request(input));
        return new Response("ok");
      },
    });
    await transport("https://auth.example.com/tenant/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: "refresh_3" }),
      headers: { "content-type": "application/json" },
    });
    expect(calls[0]?.url).toBe("https://auth.example.com/tenant/auth/v1/oauth/token");

    let message = "";
    try {
      await createSupaCloudOAuthFetch({
        clientId: "client_1",
        tokenEndpoint: "https://other.example.com/auth/v1/oauth/token",
      })("https://auth.example.com/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        body: JSON.stringify({ refresh_token: "refresh_4" }),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("must use the Supabase Auth origin");
  });

  test("does not follow redirects from the OAuth token endpoint", async () => {
    const redirectedBodies: string[] = [];
    const redirected = Bun.serve({
      port: 0,
      async fetch(request: Request) {
        redirectedBodies.push(await request.text());
        return new Response("unexpected redirect target");
      },
    });
    const redirectedUrl = `http://127.0.0.1:${redirected.port}/capture`;
    const auth = Bun.serve({
      port: 0,
      fetch() {
        return Response.redirect(redirectedUrl, 307);
      },
    });

    try {
      const origin = `http://127.0.0.1:${auth.port}`;
      const transport = createSupaCloudOAuthFetch({ clientId: "client_1" });
      let message = "";
      try {
        await transport(`${origin}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          body: JSON.stringify({ refresh_token: "refresh_secret" }),
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message === "").toBe(false);
      expect(redirectedBodies.length).toBe(0);
    } finally {
      await auth.stop(true);
      await redirected.stop(true);
    }
  });

  test("is a transparent pass-through for a single-project Supabase app", async () => {
    const calls: Request[] = [];
    const supabase = createClient("https://project.example.com", "anon-key", {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        fetch: createSupaCloudOAuthFetch({
          fetch: async (input, init) => {
            calls.push(input instanceof Request ? input : new Request(input, init));
            return Response.json({
              access_token: "project_access_2",
              refresh_token: "project_refresh_2",
              expires_in: 3600,
              token_type: "bearer",
              user: { id: "user_1", aud: "authenticated", role: "authenticated" },
            });
          },
        }),
      },
    });

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: "project_refresh_1",
    });
    expect(error).toBe(null);
    expect(data.session?.access_token).toBe("project_access_2");
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(
      "https://project.example.com/auth/v1/token?grant_type=refresh_token",
    );
    expect(calls[0]?.headers.get("content-type")).toContain("application/json");
    const body = JSON.parse(await calls[0]!.text()) as { refresh_token?: string };
    expect(body.refresh_token).toBe("project_refresh_1");
  });

  test("keeps supabase-js in charge of refresh session lifecycle", async () => {
    const calls: Request[] = [];
    const authFetch = createSupaCloudOAuthFetch({
      clientId: "client_1",
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        calls.push(request);
        return Response.json({
          access_token: "access_2",
          refresh_token: "refresh_2",
          expires_in: 3600,
          token_type: "bearer",
          user: { id: "user_1", aud: "authenticated", role: "authenticated" },
        });
      },
    });
    const supabase = createClient("https://auth.example.com", "anon-key", {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: authFetch },
    });

    const { data, error } = await supabase.auth.refreshSession({ refresh_token: "refresh_1" });
    expect(error).toBe(null);
    expect(data.session?.access_token).toBe("access_2");
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://auth.example.com/auth/v1/oauth/token");
    expect(await calls[0]!.text()).toBe(
      "refresh_token=refresh_1&grant_type=refresh_token&client_id=client_1",
    );
  });
});
