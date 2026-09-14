import { afterEach, expect, spyOn, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import {
  SupaCloudOAuthClientError, SupaCloudOAuthClientsClient, SupaCloudApiError, createSupaCloudClient,
  type SupaCloudOAuthClientCreate, type SupaCloudOAuthRequest,
} from "./index";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const id = "12345678-1234-4234-8234-123456789abc";
const otherId = "aaaaaaaa-1234-4234-8234-123456789abc";
const base = "https://management.test/v1/projects/a/auth/oauth-clients";
function client() {
  return {
    client_id: id, client_type: "confidential", token_endpoint_auth_method: "client_secret_basic",
    client_name: "App", redirect_uris: ["https://app.test/callback"],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    registration_type: "manual", created_at: "2026-09-10T00:00:00.123456789Z",
    updated_at: "2026-09-10T00:00:01Z",
  };
}
function sdk(request: SupaCloudOAuthRequest, token: () => Promise<string | null> | string | null = () => "management-token") {
  return new SupaCloudOAuthClientsClient({ managementApiUrl: "https://management.test", projectRef: "a", getAccessToken: token, request });
}
async function rejected(promise: Promise<unknown>, code?: string, uncertain?: boolean) {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(SupaCloudApiError);
    if (!(error instanceof SupaCloudOAuthClientError)) throw error;
    if (code !== undefined) expect(error.code).toBe(code);
    if (uncertain !== undefined) expect(error.mutationMayHaveApplied).toBe(uncertain);
    return error;
  }
  throw new Error("Expected OAuth failure");
}

test("existing SDK factory uses the validated Management client without a GoTrue admin credential", async () => {
  const supabase = createClient("https://api.test", "public-key", {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  let calls = 0;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    expect(String(input)).toBe(base);
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("omit");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer management-token");
    expect(headers.has("apikey")).toBe(false);
    return Response.json({ clients: [client()] });
  }, originalFetch);
  const facade = createSupaCloudClient({
    supabase, managementApiUrl: "https://management.test/", projectRef: "a", getAccessToken: () => "management-token",
  });
  expect(facade.auth.oauthClients).toBeInstanceOf(SupaCloudOAuthClientsClient);
  expect(await facade.auth.oauthClients.list()).toEqual({ clients: [client()] });
  expect(calls).toBe(1);
});

test("list rejects missing Management envelopes, duplicates and every malformed declared field", async () => {
  let payload: unknown = { clients: [] };
  const api = sdk(async () => Response.json(payload));
  expect(await api.list()).toEqual({ clients: [] });
  payload = { clients: [{ ...client(), private_config: "hidden" }] };
  expect(await api.list()).toEqual({ clients: [client()] });
  payload = { clients: [{ client_id: id, client_type: "public" }] };
  expect(await api.list()).toEqual(payload);
  for (const bad of [
    {}, null, [], { data: [] }, { clients: null }, { clients: [client(), client()] },
    ...[
      { client_id: "client_1" }, { client_type: "other" }, { client_type: undefined },
      { token_endpoint_auth_method: "none" }, { token_endpoint_auth_method: null },
      { client_name: 5 }, { client_secret: "hidden" }, { redirect_uris: [1] },
      { redirect_uris: ["javascript:alert(1)"] }, { redirect_uris: ["https://app.test/#"] },
      { redirect_uris: ["https://app.test", "https://app.test"] }, { grant_types: ["password"] },
      { response_types: ["token"] }, { registration_type: null }, { created_at: "2026-02-31T00:00:00Z" },
      { updated_at: "yesterday" }, { client_uri: "https://user:password@app.test" }, { logo_uri: {} },
    ].map(patch => ({ clients: [{ ...client(), ...patch }] })),
  ]) {
    payload = bad;
    await rejected(api.list(), "INVALID_OAUTH_CLIENT_RESPONSE", false);
  }
});

test("all six operations validate their exact paths, statuses, identity and creation secrets", async () => {
  const calls: string[] = [];
  let state = client();
  const api = sdk(async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/regenerate-secret")) return Response.json({ ...state, client_secret: "rotated" });
    if (init.method === "POST") return Response.json({ ...state, client_secret: "one-time" }, { status: 201 });
    if (init.method === "PUT") { state = { ...state, client_name: "Changed" }; return Response.json(state); }
    return Response.json(url === base ? { clients: [state] } : state);
  });
  expect((await api.list()).clients).toHaveLength(1);
  expect((await api.get(id)).client_id).toBe(id);
  expect((await api.create({ client_name: "App", redirect_uris: client().redirect_uris })).client_secret).toBe("one-time");
  expect((await api.update(id, { client_name: "Changed" })).client_name).toBe("Changed");
  expect((await api.regenerateSecret(id)).client_secret).toBe("rotated");
  await api.delete(id);
  expect(calls).toEqual([
    `GET ${base}`, `GET ${base}/${id}`, `POST ${base}`, `PUT ${base}/${id}`,
    `POST ${base}/${id}/regenerate-secret`, `DELETE ${base}/${id}`,
  ]);
  const publicClient = { ...client(), client_type: "public", token_endpoint_auth_method: "none" };
  const publicApi = sdk(async () => Response.json(publicClient, { status: 201 }));
  expect(await publicApi.create({ client_type: "public", redirect_uris: client().redirect_uris })).toEqual(publicClient);
  const missingSecret = sdk(async () => Response.json(client(), { status: 201 }));
  await rejected(missingSecret.create({ redirect_uris: client().redirect_uris }), "INVALID_OAUTH_CLIENT_RESPONSE", true);
  const wrongIdentity = sdk(async () => Response.json({ ...client(), client_id: otherId }));
  await rejected(wrongIdentity.get(id), "INVALID_OAUTH_CLIENT_RESPONSE", false);
  await rejected(wrongIdentity.update(id, { client_name: "App" }), "INVALID_OAUTH_CLIENT_RESPONSE", true);
  const mismatch = sdk(async () => Response.json(client()));
  await rejected(mismatch.update(id, { client_name: "Changed" }), "INVALID_OAUTH_CLIENT_RESPONSE", true);
});

test("invalid inputs never resolve credentials or send requests; valid input is captured before await", async () => {
  let calls = 0;
  const token = Promise.withResolvers<string>();
  let tokenCalls = 0;
  let sentBody: unknown;
  const api = sdk(async (_url, options) => {
    calls++;
    if (typeof options.body !== "string") throw new Error("Expected JSON request");
    sentBody = JSON.parse(options.body);
    return Response.json({ ...client(), client_secret: "one-time" }, { status: 201 });
  }, () => { tokenCalls++; return token.promise; });
  await rejected(api.get("../other"), "INVALID_OAUTH_CLIENT_INPUT", false);
  await rejected(api.update(id, {}), "INVALID_OAUTH_CLIENT_INPUT", false);
  await rejected(api.create({ redirect_uris: [] }), "INVALID_OAUTH_CLIENT_INPUT", false);
  await rejected(api.create({ redirect_uris: ["javascript:alert(1)"] }), "INVALID_OAUTH_CLIENT_INPUT", false);
  expect(tokenCalls).toBe(0);
  expect(calls).toBe(0);
  const input: SupaCloudOAuthClientCreate = { client_name: "App", redirect_uris: ["https://app.test/callback"] };
  const pending = api.create(input);
  input.client_name = "Changed";
  input.redirect_uris.push("https://foreign.test/");
  token.resolve("management-token");
  expect((await pending).client_name).toBe("App");
  expect(sentBody).toEqual({ client_name: "App", redirect_uris: ["https://app.test/callback"] });
  expect(calls).toBe(1);
  expect(() => new SupaCloudOAuthClientsClient({
    managementApiUrl: "https://user:secret@management.test", projectRef: "a", getAccessToken: () => "token",
  })).toThrow();
});

test("unexpected statuses, malformed encodings and oversized bodies never become success", async () => {
  for (const reply of [
    new Response(null, { status: 204 }), Response.json({ clients: [] }, { status: 201 }),
    new Response("not-json", { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ clients: [] }), { headers: { "content-type": "text/html" } }),
    Response.json({ padding: "x".repeat(1024 * 1024) }),
    new Response(null, { status: 302, headers: { location: "https://foreign.test" } }),
  ]) await rejected(sdk(async () => reply).list(), undefined, false);
  for (const reply of [new Response(null), Response.json({ success: true })]) {
    await rejected(sdk(async () => reply).delete(id), undefined, true);
  }
  const privateError = sdk(async () => Response.json({
    code: "OAUTH_CONTEXT_UNCONFIRMED", message: "private upstream secret", private_config: "private",
    mutation_may_have_applied: true,
  }, { status: 503 }));
  const failure = await rejected(privateError.delete(id), "OAUTH_CONTEXT_UNCONFIRMED", true);
  expect(failure.status).toBe(503);
  expect(failure.message).not.toContain("private");
  expect(JSON.stringify(failure.responseBody)).not.toContain("private");
});

test("cancellation and deadlines cover token acquisition, streams and late responses without retries", async () => {
  let calls = 0;
  const token = Promise.withResolvers<string>();
  const api = sdk(async () => { calls++; return Response.json({ clients: [] }); }, () => token.promise);
  await rejected(api.list({ timeoutMs: 20 }), "OAUTH_CLIENT_REQUEST_TIMED_OUT", false);
  token.resolve("token");
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(calls).toBe(0);
  let disposed = false;
  const late = Promise.withResolvers<Response>();
  let sentSignal: AbortSignal | null | undefined;
  const network = sdk(async (_url, options) => { calls++; sentSignal = options.signal; return late.promise; });
  const abort = new AbortController();
  const pending = network.delete(id, { signal: abort.signal });
  await new Promise(resolve => setTimeout(resolve, 5));
  abort.abort();
  await rejected(pending, "OAUTH_CLIENT_REQUEST_CANCELLED", true);
  expect(sentSignal?.aborted).toBe(true);
  late.resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(disposed).toBe(true);
  expect(calls).toBe(1);
  let streamClosed = false;
  const streaming = sdk(async () => new Response(new ReadableStream({ cancel() { streamClosed = true; } }), {
    status: 201, headers: { "content-type": "application/json" },
  }));
  await rejected(streaming.create({ redirect_uris: client().redirect_uris }, { timeoutMs: 20 }), "OAUTH_CLIENT_REQUEST_TIMED_OUT", true);
  expect(streamClosed).toBe(true);
});

test("OAuth requests do not require Promise.withResolvers at runtime", async () => {
  const unavailable = spyOn(Promise, "withResolvers").mockImplementation(() => {
    throw new Error("Promise.withResolvers is unavailable in the supported runtime");
  });
  try {
    let calls = 0;
    const api = sdk(async () => { calls++; return Response.json({ clients: [] }); });
    expect(await api.list()).toEqual({ clients: [] });
    const cancelled = new AbortController();
    cancelled.abort();
    await rejected(api.list({ signal: cancelled.signal }), "OAUTH_CLIENT_REQUEST_CANCELLED", false);
    expect(calls).toBe(1);
    const waiting = sdk(async () => { calls++; return Response.json({ clients: [] }); },
      () => new Promise<string>(() => {}));
    await rejected(waiting.list({ timeoutMs: 20 }), "OAUTH_CLIENT_REQUEST_TIMED_OUT", false);
    expect(calls).toBe(1);
    let disposed = false;
    const writing = sdk(async () => {
      calls++;
      return new Response(new ReadableStream<Uint8Array>({ cancel() { disposed = true; } }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    });
    await rejected(writing.create({ redirect_uris: client().redirect_uris }, { timeoutMs: 20 }),
      "OAUTH_CLIENT_REQUEST_TIMED_OUT", true);
    expect(calls).toBe(2);
    expect(disposed).toBe(true);
    expect(unavailable).not.toHaveBeenCalled();
  } finally {
    unavailable.mockRestore();
  }
});

test("explicit session mode uses only a relative Management URL and captures the project", async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const options = {
    managementApiUrl: "", projectRef: "a",
    sessionRequest: async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      return Response.json({ clients: [] });
    },
  };
  const api = new SupaCloudOAuthClientsClient(options);
  options.projectRef = "b";
  await api.list();
  expect(calls[0]?.url).toBe("/v1/projects/a/auth/oauth-clients");
  expect(calls[0]?.options.credentials).toBe("same-origin");
  expect(new Headers(calls[0]?.options.headers).has("authorization")).toBe(false);
  expect(() => new SupaCloudOAuthClientsClient({ ...options, managementApiUrl: "https://foreign.test" })).toThrow();
});

test("strict focused consumer types reject contradictory clients and guarantee secret receipts", async () => {
  const child = Bun.spawn({
    cmd: [join(import.meta.dir, "../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit",
      "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess", "--skipLibCheck", "false",
      "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ESNext",
      "--lib", "ESNext,DOM,DOM.Iterable", "--types", "node",
      join(import.meta.dir, "../test/oauth-clients-types.ts")],
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);
