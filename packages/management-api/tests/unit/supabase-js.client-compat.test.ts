import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";

const BASE_URL = "https://testref.api.example.com";
const ANON_KEY = "anon-key-test";

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
};

function toRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

describe("supabase-js client request compatibility matrix", () => {
  let originalFetch: typeof fetch;
  const calls: FetchCall[] = [];

  beforeEach(() => {
    calls.length = 0;
    originalFetch = globalThis.fetch;

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();

      const mergedHeaders = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => mergedHeaders.set(key, value));
      }

      calls.push({
        url,
        method,
        headers: toRecord(mergedHeaders),
      });

      const pathname = new URL(url).pathname;

      if (pathname === "/auth/v1/user") {
        return Promise.resolve(new Response(JSON.stringify({
          id: "00000000-0000-0000-0000-000000000001",
          aud: "authenticated",
          role: "authenticated",
          email: "test@example.com",
        }), { headers: { "Content-Type": "application/json" } }));
      }

      if (pathname.startsWith("/rest/v1/rpc/")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }));
      }

      if (pathname.startsWith("/rest/v1/")) {
        return Promise.resolve(new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } }));
      }

      if (pathname.startsWith("/functions/v1/")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }));
      }

      if (pathname.startsWith("/storage/v1/object/list/")) {
        return Promise.resolve(new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } }));
      }

      if (pathname.startsWith("/storage/v1/object/sign/")) {
        return Promise.resolve(new Response(JSON.stringify({ signedURL: "/object/sign/avatars/folder/file.txt?token=t&t=1" }), {
          headers: { "Content-Type": "application/json" },
        }));
      }

      return Promise.resolve(new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("auth/rest/rpc/functions/storage/realtime endpoints align with supacloud routes", async () => {
    const client = createClient(BASE_URL, ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    // Verify the inner configuration bound it to the mock URL
    const mockClient = client as any;
    expect(String(mockClient.authUrl)).toBe(`${BASE_URL}/auth/v1`);
    expect(String(mockClient.storageUrl)).toBe(`${BASE_URL}/storage/v1`);
    expect(String(mockClient.functionsUrl)).toBe(`${BASE_URL}/functions/v1`);
    expect((client as unknown as { realtime: { endPoint: string } }).realtime.endPoint)
      .toBe("wss://testref.api.example.com/realtime/v1/websocket");

    await client.auth.getUser("jwt-token-user");
    await client.from("todos").select("*").limit(1);
    await client.rpc("hello_rpc", { ping: true });
    await client.functions.invoke("hello", { body: { ping: true } });
    await client.storage.from("avatars").list("folder", { limit: 1 });
    await client.storage.from("avatars").createSignedUrl("folder/file.txt", 60);

    const calledPaths = calls.map((c) => new URL(c.url).pathname);
    expect(calledPaths.some((p) => p === "/auth/v1/user")).toBe(true);
    expect(calledPaths.some((p) => p.startsWith("/rest/v1/todos"))).toBe(true);
    expect(calledPaths.some((p) => p === "/rest/v1/rpc/hello_rpc")).toBe(true);
    expect(calledPaths.some((p) => p === "/functions/v1/hello")).toBe(true);
    expect(calledPaths.some((p) => p === "/storage/v1/object/list/avatars")).toBe(true);
    expect(calledPaths.some((p) => p === "/storage/v1/object/sign/avatars/folder/file.txt")).toBe(true);

    const getUserCall = calls.find((c) => new URL(c.url).pathname === "/auth/v1/user");
    expect(getUserCall?.headers.authorization).toBe("Bearer jwt-token-user");
    expect(getUserCall?.headers.apikey).toBe(ANON_KEY);
  });
});
