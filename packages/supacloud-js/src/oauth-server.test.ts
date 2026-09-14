import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient } from "./index";
import {
  SupaCloudOAuthServerClient, SupaCloudOAuthServerError,
  type SupaCloudOAuthServerStatus, type SupaCloudAuthorizeUrlOptions,
} from "./oauth-server";

const requiredStatus = {
  project_ref: "proj_1", organization_id: null, account_isolated: true,
  state_source: "configuration", runtime_verified: false,
  enabled: true, allow_dynamic_registration: false, authorization_path: "/authorize.html",
  issuer: "https://project.example.com/auth/v1",
  discovery_url: "https://project.example.com/auth/v1/.well-known/openid-configuration",
  oauth_authorization_server_metadata_url: "https://auth.example.com/.well-known/oauth-authorization-server/auth/v1",
  jwks_url: "https://project.example.com/auth/v1/.well-known/jwks.json",
  authorization_endpoint: "https://project.example.com/auth/v1/oauth/authorize",
  token_endpoint: "https://project.example.com/auth/v1/oauth/token",
  userinfo_endpoint: "https://project.example.com/auth/v1/oauth/userinfo",
  registration_endpoint: "https://project.example.com/auth/v1/oauth/clients/register",
  signing_alg: "ES256", key_id: "key-1", oidc_id_token_ready: true,
  migration_status: "oidc_es256_migrated", warnings: [],
} satisfies SupaCloudOAuthServerStatus;
const discovery = {
  issuer: requiredStatus.issuer, authorization_endpoint: requiredStatus.authorization_endpoint,
  token_endpoint: requiredStatus.token_endpoint, jwks_uri: requiredStatus.jwks_url,
  response_types_supported: ["code"], subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["ES256"],
};
const managementUrl = "https://management.example.com/v1/projects/proj_1/auth/oauth-server";
const options = {
  managementApiUrl: "https://management.example.com", projectRef: "proj_1",
  getAccessToken: () => "management-token",
};
type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
async function withFetch<T>(handler: Handler, work: () => Promise<T>): Promise<T> {
  const spy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init)),
    { preconnect: globalThis.fetch.preconnect },
  ));
  try { return await work(); } finally { spy.mockRestore(); }
}
async function rejected(work: Promise<unknown>): Promise<SupaCloudOAuthServerError> {
  try { await work; } catch (error) {
    if (error instanceof SupaCloudOAuthServerError) return error;
    throw error;
  }
  throw new Error("Expected rejection");
}
async function publicKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { ...await crypto.subtle.exportKey("jwk", pair.publicKey), alg: "ES256", kid: "key-1", use: "sig" };
}

type Operation = "getStatus" | "migrateToOidc";
async function readStatus(payload: unknown, operation: Operation) {
  let calls = 0;
  return withFetch((url, init) => {
    const write = operation === "migrateToOidc" && calls++ > 0;
    expect(url).toBe(`${managementUrl}${write ? "/migrate" : ""}`);
    expect(init?.method).toBe(write ? "POST" : "GET");
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer management-token");
    return Response.json(operation === "migrateToOidc" && !write ? requiredStatus : payload);
  }, () => new SupaCloudOAuthServerClient(options)[operation]());
}

for (const operation of ["getStatus", "migrateToOidc"] as const) {
  describe(`OAuth Server ${operation} contract`, () => {
    test("accepts the configuration contract and strips unknown fields", async () => {
      expect(await readStatus({ ...requiredStatus, secret: "hidden" }, operation)).toEqual(requiredStatus);
    });
    test.each(Object.keys(requiredStatus))("rejects missing %s", async key => {
      const payload: Record<string, unknown> = { ...requiredStatus };
      delete payload[key];
      await expect(readStatus(payload, operation)).rejects.toThrow("Invalid OAuth Server response");
    });
    test.each([
      ["project_ref", "other"], ["account_isolated", false], ["organization_id", 7],
      ["state_source", "runtime"], ["runtime_verified", true], ["enabled", "true"],
      ["allow_dynamic_registration", 1], ["issuer", "javascript:alert(1)"],
      ["issuer", "https://user:secret@project.example.com/auth/v1"],
      ["authorization_path", "/%2e%2e/admin"], ["authorization_path", "//evil.test"],
      ["discovery_url", "https://foreign.test/openid"], ["jwks_url", "http://127.0.0.1/private"],
      ["token_endpoint", `${requiredStatus.token_endpoint}?x=1`], ["key_id", ""],
      ["signing_alg", "HS256"], ["oidc_id_token_ready", false], ["migration_status", "pending"],
      ["warnings", ["valid", 1]], ["warnings", null],
    ])("rejects inconsistent %s", async (key, value) => {
      await expect(readStatus({ ...requiredStatus, [String(key)]: value }, operation)).rejects.toThrow("Invalid OAuth Server response");
    });
    test.each([null, [], 1, "status"].map(value => [value] as const))("rejects non-record %p", async value => {
      await expect(readStatus(value, operation)).rejects.toThrow("Invalid OAuth Server response");
    });
  });
}

test("factory preserves auth.oauthServer; unconfigured status is distinct from runtime verification", async () => {
  const supabase = createClient("https://project.example.com", "anon-key", {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const client = createSupaCloudClient({ ...options, supabase });
  const { key_id: _key, ...base } = requiredStatus;
  const unconfigured = { ...base, signing_alg: "not_migrated", oidc_id_token_ready: false, migration_status: "not_migrated" };
  await withFetch(() => Response.json(unconfigured), async () => {
    expect((await client.auth.oauthServer.getStatus()).runtime_verified).toBe(false);
    await expect(client.auth.oauthServer.getDiscovery()).rejects.toThrow("not configured");
  });
});

test("public reads omit all credentials, strip unknown fields and recheck configuration", async () => {
  const key = await publicKey();
  const calls: string[] = [];
  await withFetch((url, init) => {
    calls.push(url);
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    if (url === managementUrl) return Response.json(requiredStatus);
    expect([...new Headers(init?.headers)]).toEqual([]);
    return Response.json(url === requiredStatus.discovery_url
      ? { ...discovery, arbitrary: "hidden" } : { keys: [{ ...key, arbitrary: "hidden" }] });
  }, async () => {
    const client = new SupaCloudOAuthServerClient(options);
    expect(await client.getDiscovery()).toEqual(discovery);
    const jwks = await client.getJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(Object.hasOwn(jwks.keys[0] ?? {}, "arbitrary")).toBe(false);
    expect(calls).toEqual([managementUrl, requiredStatus.discovery_url, managementUrl,
      managementUrl, requiredStatus.jwks_url, managementUrl]);
  });
});

test.each([
  null, [], {}, { ...discovery, issuer: "https://foreign.test" },
  { ...discovery, jwks_uri: "https://foreign.test/jwks" },
  { ...discovery, token_endpoint: "https://foreign.test/token" },
  { ...discovery, userinfo_endpoint: "https://foreign.test/user" },
  { ...discovery, response_types_supported: [] },
  { ...discovery, subject_types_supported: ["unknown"] },
  { ...discovery, id_token_signing_alg_values_supported: ["HS256"] },
].map(value => [value] as const))("rejects invalid discovery %p", async payload => {
  await withFetch(url => Response.json(url === managementUrl ? requiredStatus : payload), async () => {
    await expect(new SupaCloudOAuthServerClient(options).getDiscovery()).rejects.toThrow();
  });
});

test("rejects invalid, private, duplicate, mismatched and off-curve JWK material", async () => {
  const key = await publicKey();
  const bad: unknown[] = [null, {}, { keys: [] }, { keys: [key, key] },
    { keys: [{ ...key, kid: "other" }] }, { keys: [{ ...key, alg: "RS256" }] },
    { keys: [{ ...key, x: "A".repeat(43), y: "A".repeat(43) }] },
    { keys: [{ ...key, key_ops: ["sign"] }] }, { keys: [{ ...key, use: "enc" }] },
    { keys: [{ kty: "oct", k: "secret" }] },
    ...["d", "p", "q", "dp", "dq", "qi", "oth", "k"].map(field => ({ keys: [{ ...key, [field]: "secret" }] })),
  ];
  for (const payload of bad) {
    await withFetch(url => Response.json(url === managementUrl ? requiredStatus : payload), async () => {
      await expect(new SupaCloudOAuthServerClient(options).getJwks()).rejects.toThrow();
    });
  }
});

test("accepts RS256 public keys and rejects undersized modulus and invalid exponent", async () => {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
  }, true, ["sign", "verify"]);
  const key = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), alg: "RS256", kid: "rsa", use: "sig" };
  const status = { ...requiredStatus, signing_alg: "RS256", key_id: "rsa", migration_status: "oidc_rs256_migrated" };
  for (const candidate of [key, { ...key, n: "AQAB" }, { ...key, e: "Ag" }]) {
    await withFetch(url => Response.json(url === managementUrl ? status : { keys: [candidate] }), async () => {
      const work = new SupaCloudOAuthServerClient(options).getJwks();
      if (candidate === key) expect((await work).keys[0]?.alg).toBe("RS256");
      else await expect(work).rejects.toThrow();
    });
  }
});

test("rejects configuration changes observed after public fetch", async () => {
  let reads = 0;
  await withFetch(url => Response.json(url === managementUrl
    ? { ...requiredStatus, key_id: ++reads === 1 ? "key-1" : "key-2" } : discovery), async () => {
    await expect(new SupaCloudOAuthServerClient(options).getDiscovery()).rejects.toThrow("configuration changed");
  });
});

test("bounds body bytes, requires JSON and rejects invalid UTF-8 and HTTP statuses", async () => {
  for (const response of [
    new Response("{}", { headers: { "content-type": "text/html" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    Response.json({ text: "a".repeat(65536) }),
    new Response("{}", { headers: { "content-type": "application/json", "content-length": "65537" } }),
    Response.json(requiredStatus, { status: 201 }),
    Response.json({ message: "private upstream message" }, { status: 401 }),
    Response.redirect("https://foreign.test", 302),
  ]) {
    await withFetch(() => response, async () => {
      const error = await rejected(new SupaCloudOAuthServerClient(options).getStatus());
      expect(error.message).not.toContain("private upstream message");
    });
  }
});

test("migration captures input and preserves uncertain write outcomes without retry", async () => {
  const submitted = { ...requiredStatus, allow_dynamic_registration: true, authorization_path: "/new.html" };
  for (const payload of [
    { ...submitted, allow_dynamic_registration: false },
    { ...submitted, key_id: "changed" },
    { ...submitted, organization_id: "other" },
    { ...submitted, enabled: false },
    { code: "SUPAUTH_DEPENDENT_REFRESH_FAILED", message: "secret details" },
  ]) {
    let writes = 0;
    await withFetch((url, init) => {
      if (url === managementUrl) return Response.json(requiredStatus);
      writes++;
      expect(JSON.parse(String(init?.body))).toEqual({ allow_dynamic_registration: true, authorization_path: "/new.html" });
      return Response.json(payload, { status: "code" in payload ? 503 : 200 });
    }, async () => {
      const input = { allowDynamicRegistration: true, authorizationPath: "/new.html" };
      const work = new SupaCloudOAuthServerClient(options).migrateToOidc(input);
      input.allowDynamicRegistration = false;
      input.authorizationPath = "/changed";
      const error = await rejected(work);
      expect(error.mutationMayHaveApplied).toBe(true);
      expect(error.message).not.toContain("secret details");
      if ("code" in payload) expect(error.code).toBe("SUPAUTH_DEPENDENT_REFRESH_FAILED");
      expect(writes).toBe(1);
    });
  }
  await withFetch(url => Response.json(url === managementUrl ? requiredStatus
    : { ...requiredStatus, allow_dynamic_registration: true, authorization_path: "/new.html" }), async () => {
    expect((await new SupaCloudOAuthServerClient(options).migrateToOidc({
      allowDynamicRegistration: true, authorizationPath: "/new.html",
    })).allow_dynamic_registration).toBe(true);
  });
});

test("authorization parameters are validated before I/O and captured before awaiting status", async () => {
  const valid: SupaCloudAuthorizeUrlOptions = {
    clientId: "client", redirectUri: "https://app.test/callback", scope: ["openid", "email"],
    codeChallenge: "A".repeat(43), codeChallengeMethod: "S256", state: "state", nonce: "nonce",
  };
  await withFetch(() => Response.json(requiredStatus), async () => {
    const input = { ...valid };
    const work = new SupaCloudOAuthServerClient(options).buildAuthorizeUrl(input);
    input.clientId = "changed";
    const url = new URL(await work);
    expect(url.searchParams.get("client_id")).toBe("client");
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("code_challenge")).toBe(valid.codeChallenge);
  });
  await withFetch(() => { throw new Error("Must not fetch"); }, async () => {
    for (const input of [
      { ...valid, clientId: "" }, { ...valid, redirectUri: "javascript:alert(1)" },
      { ...valid, redirectUri: "https://app.test/#fragment" },
      { ...valid, scope: "openid\nemail" }, { ...valid, codeChallenge: "short" },
      { ...valid, codeChallengeMethod: undefined }, { ...valid, resource: "data:foo" },
    ]) {
      const parsed: unknown = input;
      const result = await rejected(new SupaCloudOAuthServerClient(options).buildAuthorizeUrl(parsed as SupaCloudAuthorizeUrlOptions));
      expect(result.code).toBe("OAUTH_SERVER_INVALID");
    }
    const malformed: unknown = { allowDynamicRegistration: "true" };
    expect((await rejected(new SupaCloudOAuthServerClient(options).migrateToOidc(
      malformed as Parameters<SupaCloudOAuthServerClient["migrateToOidc"]>[0],
    ))).mutationMayHaveApplied).toBe(false);
  });
});

test("deadline stops credential lookup, stalled bodies and late fetch responses", async () => {
  const originalTimeout = globalThis.setTimeout;
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(Object.assign(
    (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      originalTimeout(callback, delay === 15000 ? 20 : delay, ...args),
    { __promisify__: originalTimeout.__promisify__ },
  ));
  try {
    let fetches = 0;
    await withFetch(() => { fetches++; return Response.json(requiredStatus); }, async () => {
      const error = await rejected(new SupaCloudOAuthServerClient({
        ...options, getAccessToken: () => new Promise(() => {}),
      }).getStatus());
      expect(error.code).toBe("OAUTH_SERVER_TIMEOUT");
      expect(fetches).toBe(0);
    });
    let cancelled = false;
    await withFetch(() => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } }), async () => {
      expect((await rejected(new SupaCloudOAuthServerClient(options).getStatus())).code).toBe("OAUTH_SERVER_TIMEOUT");
      expect(cancelled).toBe(true);
    });
    let deliver: ((response: Response) => void) | undefined;
    await withFetch(() => new Promise(resolve => { deliver = resolve; }), async () => {
      await rejected(new SupaCloudOAuthServerClient(options).getStatus());
      cancelled = false;
      deliver?.(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
      await new Promise(resolve => originalTimeout(resolve, 0));
      expect(cancelled).toBe(true);
    });
  } finally { timers.mockRestore(); }
});

test("native HTTP redirect cannot send management credentials to another endpoint", async () => {
  let leaked = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { leaked++; return Response.json(requiredStatus); } });
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.redirect(target.url, 302); } });
  try {
    await expect(new SupaCloudOAuthServerClient({ ...options, managementApiUrl: source.url.origin }).getStatus()).rejects.toThrow();
    expect(leaked).toBe(0);
  } finally { await source.stop(true); await target.stop(true); }
});

test("actual Management status producer matches SDK and native public document reads", async () => {
  const { authOAuthServerRoutes } = await import("../../management-api/src/routes/auth-oauth-server");
  const { projectAuthRepository } = await import("../../management-api/src/repositories/project-auth.repository");
  const { config } = await import("../../management-api/src/config");
  const { generateOidcJwtKeyMaterial } = await import("../../management-api/src/utils/project-jwt");
  const oldToken = config.masterToken, oldOwner = config.authRuntimeOwnerRef;
  config.masterToken = "oauth-server-local-fixture-token";
  config.authRuntimeOwnerRef = "";
  const material = await generateOidcJwtKeyMaterial("synthetic-signing-secret");
  let issuer = "";
  let publicReads = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      publicReads++;
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
      expect(request.headers.has("apikey")).toBe(false);
      return Response.json(new URL(request.url).pathname.endsWith("/jwks.json")
        ? { keys: material.jwt_jwks.keys.filter(key => key.kty === "EC") }
        : {
          ...discovery, issuer, authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`, jwks_uri: `${issuer}/.well-known/jwks.json`,
        });
    },
  });
  issuer = `${upstream.url.origin}/auth/v1`;
  const project = spyOn(projectAuthRepository, "findByRef").mockResolvedValue({
    ref: "proj_1", organization_id: null, jwt_secret: "synthetic-signing-secret",
    config: {
      api_domain: "api.test", gotrue_port: upstream.port, postgrest_port: 3100,
      auth: { oauth_server: { ...material, issuer, enabled: true } },
    },
  });
  const management = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => authOAuthServerRoutes.handle(request) });
  try {
    const client = new SupaCloudOAuthServerClient({
      managementApiUrl: management.url.origin, projectRef: "proj_1", getAccessToken: () => config.masterToken,
    });
    const status = await client.getStatus();
    expect(status.key_id).toBe(material.key_id);
    expect(status.runtime_verified).toBe(false);
    expect((await client.getDiscovery()).issuer).toBe(issuer);
    expect((await client.getJwks()).keys[0]?.kid).toBe(material.key_id);
    expect(publicReads).toBe(2);
    await expect(new SupaCloudOAuthServerClient({
      managementApiUrl: management.url.origin, projectRef: "proj_1", getAccessToken: () => "invalid",
    }).getDiscovery()).rejects.toThrow();
    expect(publicReads).toBe(2);
  } finally {
    project.mockRestore();
    config.masterToken = oldToken; config.authRuntimeOwnerRef = oldOwner;
    await management.stop(true); await upstream.stop(true);
  }
});

test("strict focused consumer checks real declarations without skipLibCheck", async () => {
  const child = Bun.spawn({
    cmd: [join(import.meta.dir, "../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit",
      "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess", "--skipLibCheck", "false",
      "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ESNext",
      "--lib", "ESNext,DOM,DOM.Iterable", "--types", "node", join(import.meta.dir, "../test/oauth-server-types.ts")],
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);
