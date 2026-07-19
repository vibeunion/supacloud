import { describe, expect, test } from "bun:test";
import {
  buildBackgroundForwardDispatch,
  buildBackgroundForwardedRequest,
  createBackgroundInvocationToken,
} from "./background-forward";

describe("background forwarded request", () => {
  test("uses a tenant-scoped background token without forwarding the master token", async () => {
    const controller = new AbortController();
    const request = new Request("http://edge-runtime/internal/background/proj/fn", {
      method: "POST",
      headers: {
        authorization: "Bearer management-master-token",
        apikey: "management-api-key",
        "x-supacloud-internal-auth": "Bearer management-master-token",
        "x-supacloud-internal-token": "legacy-management-master-token",
        "x-supacloud-auth-authorization": "Bearer user-token",
        "x-supacloud-auth-apikey": "anon-key",
        "x-supacloud-jwt-sub": "attacker-controlled",
      },
      body: JSON.stringify({ ok: true }),
      signal: controller.signal,
    });

    const forwarded = buildBackgroundForwardedRequest(request, "background-token");

    expect(forwarded.headers.get("x-supacloud-internal-auth")).toBe("Bearer background-token");
    expect(forwarded.headers.get("x-supacloud-internal-token")).toBeNull();
    expect(forwarded.headers.get("authorization")).toBe("Bearer user-token");
    expect(forwarded.headers.get("apikey")).toBe("anon-key");
    expect(forwarded.headers.get("x-supacloud-auth-authorization")).toBeNull();
    expect(forwarded.headers.get("x-supacloud-auth-apikey")).toBeNull();
    expect(forwarded.headers.get("x-supacloud-jwt-sub")).toBeNull();
    controller.abort();
    expect(forwarded.signal.aborted).toBe(true);
    expect(await forwarded.text()).toBe(JSON.stringify({ ok: true }));
  });

  test("removes privileged headers when no user auth was preserved", () => {
    const request = new Request("http://edge-runtime/internal/background/proj/fn", {
      method: "POST",
      headers: {
        authorization: "Bearer management-master-token",
        apikey: "management-api-key",
        "x-supacloud-internal-auth": "Bearer management-master-token",
      },
      body: "{}",
    });

    const forwarded = buildBackgroundForwardedRequest(request, "background-token");

    expect(forwarded.headers.get("x-supacloud-internal-auth")).toBe("Bearer background-token");
    expect(forwarded.headers.get("authorization")).toBeNull();
    expect(forwarded.headers.get("apikey")).toBeNull();
  });

  test("creates a fresh invocation token", () => {
    const first = createBackgroundInvocationToken();
    const second = createBackgroundInvocationToken();

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  test("keeps forwarded header and tenant env token in sync", () => {
    const request = new Request("http://edge-runtime/internal/background/proj/fn/work", {
      method: "POST",
      headers: {
        authorization: "Bearer management-master-token",
        "x-supacloud-internal-auth": "Bearer management-master-token",
        "x-supacloud-auth-authorization": "Bearer user-token",
      },
      body: "{}",
    });

    const dispatch = buildBackgroundForwardDispatch(
      request,
      {
        SUPABASE_URL: "https://api.example.com",
      },
      "background-token",
    );

    expect(dispatch.backgroundInternalToken).toBe("background-token");
    expect(dispatch.forwardedRequest.headers.get("x-supacloud-internal-auth")).toBe("Bearer background-token");
    expect(dispatch.forwardedRequest.headers.get("authorization")).toBe("Bearer user-token");
    expect(dispatch.tenantEnv.SUPACLOUD_BACKGROUND_INTERNAL_TOKEN).toBe("background-token");
    expect(dispatch.tenantEnv.SUPABASE_URL).toBe("https://api.example.com");
  });
});
