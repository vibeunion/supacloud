import { beforeAll, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createApplication, createHttpPolicySuite, createHttpTelemetry,
  createMemoryHttpCacheStore, createMemoryHttpRateLimitStore, HttpPolicyConfigurationError,
  ApplicationError,
  type BuiltinHttpPolicyDeclaration, type CompiledModule, type HttpCacheStore,
  type HttpTelemetryEvent, type SupAuthContextOptions, type SupAuthRequestContext,
} from "./index";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let keyResolver: SupAuthContextOptions["keyResolver"];
const issuer = "https://identity.example";
beforeAll(async () => {
  keys = await generateKeyPair("ES256");
  keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "policy", alg: "ES256" }] });
});
async function token(subject = "alice", claims: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: subject, role: "authenticated", client_id: "app", iss: issuer, aud: "api",
    exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), ...claims,
  }).setProtectedHeader({ alg: "ES256", kid: "policy" }).sign(keys.privateKey);
}
function auth(resolveAccess?: SupAuthContextOptions["resolveAccess"]): SupAuthContextOptions {
  return {
    issuer, audience: "api", clientId: "app", projectId: "app",
    jwksUrl: `${issuer}/keys`, keyResolver,
    resolveAccess: resolveAccess ?? (async (identity) => ({
      projectId: "app", tenantId: identity.subject === "bob" ? "b" : "a", permissions: ["items.read"],
    })),
  };
}
const guards: BuiltinHttpPolicyDeclaration[] = [
  { name: "authenticated" }, { name: "tenant", options: { param: "tenant" } },
  { name: "permission", options: { allOf: ["items.read"] } },
];
function fixture(policies: readonly unknown[], run?: (context: SupAuthRequestContext) => unknown): CompiledModule {
  return {
    name: "secure-items", createServices: () => ({}),
    createRequestScope: (_services, context) => ({
      controller: { run: () => run ? run(context as SupAuthRequestContext) : {
        tenant: (context as SupAuthRequestContext).access.tenantId,
        subject: (context as SupAuthRequestContext).identity.subject,
      } },
    }),
    controllers: [{
      path: "/tenants/:tenant", serviceKey: "controller", scope: "request",
      routes: [{
        method: "GET", path: "/items", handler: "run",
        params: t.Object({ tenant: t.String({ minLength: 1 }) }), data: { httpPolicies: policies },
      }],
    }],
  };
}
function request(credential?: string, tenant = "a", headers: Record<string, string> = {}) {
  return new Request(`http://localhost/tenants/${tenant}/items`, {
    headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...headers },
  });
}
async function settle() { await Bun.sleep(20); }

test("JWT authentication, tenant checks and permissions compose before scoped DI", async () => {
  let calls = 0, membership = true;
  const suite = createHttpPolicySuite({
    auth: auth(async () => membership ? { projectId: "app", tenantId: "a", permissions: ["items.read"] } : null),
  });
  const app = createApplication({ ...suite, modules: [fixture(guards, () => { calls++; return { ok: true }; })] });
  const credential = await token();
  for (const req of [
    request(undefined, "a", { "x-supacloud-jwt-sub": "alice", "x-tenant-id": "a" }),
    request("forged"), request(await token("alice", { aud: "wrong" })),
    request(await token("alice", { exp: 1 })),
  ]) expect((await app.handle(req)).status).toBe(401);
  expect((await app.handle(request(credential, "b", { "x-tenant-id": "a" }))).status).toBe(403);
  expect(calls).toBe(0);
  expect((await app.handle(request(credential))).status).toBe(200);
  membership = false;
  expect((await app.handle(request(credential))).status).toBe(403);
  expect(calls).toBe(1);
});

test("permission checks deny missing grants and never accept fabricated request contexts", async () => {
  const suite = createHttpPolicySuite({ auth: auth(async () => ({ projectId: "app", tenantId: "a", permissions: [] })) });
  expect((await createApplication({ ...suite, modules: [fixture(guards)] }).handle(request(await token()))).status).toBe(403);
  const spoof = createApplication({
    httpPolicies: suite.httpPolicies, modules: [fixture(guards)],
    requestContext: () => ({ identity: { authenticated: true, subject: "admin" }, access: { tenantId: "a", permissions: ["items.read"] } }),
  });
  expect((await spoof.handle(request(await token()))).status).toBe(401);
});

test("concurrent users and tenants cannot share cache values; permission revocation is checked before a hit", async () => {
  let writes = 0, active = true;
  const cacheStore = createMemoryHttpCacheStore();
  const suite = createHttpPolicySuite({
    auth: auth(async (identity) => ({
      projectId: "app", tenantId: identity.subject === "bob" ? "b" : "a",
      permissions: active ? ["items.read"] : [],
    })), cacheStore, cacheNamespace: "test-v1",
  });
  const app = createApplication({
    ...suite,
    modules: [fixture([...guards, { name: "cache", options: { ttlMs: 10000 } }], (context) => ({
      subject: context.identity.subject, tenant: context.access.tenantId, write: ++writes,
    }))],
  });
  const alice = await token(), bob = await token("bob"), charlie = await token("charlie");
  const initial = await Promise.all([[alice, "a"], [bob, "b"], [charlie, "a"]].map(async ([credential, tenant]) =>
    (await app.handle(request(credential, tenant))).json()));
  await settle();
  const cached = await Promise.all([[alice, "a"], [bob, "b"], [charlie, "a"]].map(async ([credential, tenant]) =>
    (await app.handle(request(credential, tenant))).json()));
  expect(cached).toEqual(initial);
  expect(writes).toBe(3);
  expect((await app.handle(request(bob, "a"))).status).toBe(403);
  active = false;
  expect((await app.handle(request(alice))).status).toBe(403);
  expect(writes).toBe(3);
  active = true;
  cacheStore.clear();
  await app.handle(request(alice));
  expect(writes).toBe(4);
});

test("rate limits include trusted actor and tenant; cache hits cannot bypass quotas", async () => {
  const suite = createHttpPolicySuite({
    auth: auth(), cacheNamespace: "test-v1", cacheStore: createMemoryHttpCacheStore(), rateLimitStore: createMemoryHttpRateLimitStore(),
  });
  const app = createApplication({ ...suite, modules: [fixture([
    ...guards, { name: "rateLimit", options: { limit: 2, windowMs: 1000 } },
    { name: "cache", options: { ttlMs: 1000 } },
  ])] });
  const credential = await token();
  const responses = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    app.handle(request(credential, "a", { "x-forwarded-for": `10.0.0.${i}` }))));
  expect(responses.filter((response) => response.status === 200)).toHaveLength(2);
  expect(responses.filter((response) => response.status === 429)).toHaveLength(4);
  expect(responses.find((response) => response.status === 429)?.headers.get("retry-after")).toBe("1");
  expect((await app.handle(request(await token("bob"), "b"))).status).toBe(200);
});

test("cache bypasses native responses, cookies, errors, oversized output and request no-store", async () => {
  const credential = await token();
  for (const scenario of ["native", "cookie", "error", "large", "request-no-store", "vary", "response-no-store"]) {
    let writes = 0;
    const suite = createHttpPolicySuite({ auth: auth(), cacheNamespace: "test-v1", cacheStore: createMemoryHttpCacheStore() });
    const http = new Elysia().onBeforeHandle(({ set }) => {
      if (scenario === "cookie") set.headers["set-cookie"] = "session=test; HttpOnly";
      if (scenario === "vary") set.headers.vary = "accept-language";
      if (scenario === "response-no-store") set.headers["cache-control"] = "no-store";
    }).as("scoped");
    const app = createApplication({
      ...suite, http,
      modules: [fixture([...guards, { name: "cache", options: { ttlMs: 1000, maxBodyBytes: 32 } }], () => {
        writes++;
        if (scenario === "error") throw new Error("private failure");
        if (scenario === "native") return Response.json({ writes });
        return { value: scenario === "large" ? "x".repeat(40) : writes };
      })],
    });
    for (let i = 0; i < 2; i++) {
      const response = await app.handle(request(credential, "a", scenario === "request-no-store" ? { "cache-control": "no-store" } : {}));
      await response.arrayBuffer();
      await settle();
    }
    expect(writes).toBe(2);
  }
});

test("backend failures are sanitized; post-response cache failures are reported without changing success", async () => {
  let errors = 0;
  const credential = await token();
  const cache: HttpCacheStore = {
    generation: () => "test", get: () => undefined, set: () => { throw new Error("secret"); }, clear: () => {},
  };
  const suite = createHttpPolicySuite({ auth: auth(), cacheNamespace: "test-v1", cacheStore: cache, onCacheWriteError: () => { errors++; } });
  const app = createApplication({ ...suite, modules: [fixture([...guards, { name: "cache", options: { ttlMs: 1000 } }])] });
  expect((await app.handle(request(credential))).status).toBe(200);
  await settle();
  expect(errors).toBe(1);
  const unavailable = createHttpPolicySuite({
    auth: auth(), rateLimitStore: { consume: () => { throw new Error("secret"); } },
  });
  const blocked = await createApplication({ ...unavailable, modules: [fixture([
    ...guards, { name: "rateLimit", options: { limit: 1, windowMs: 1000 } },
  ])] }).handle(request(credential));
  expect(blocked.status).toBe(503);
  expect(await blocked.text()).not.toContain("secret");
});

test("malformed built-in declarations fail startup, including unsafe cache ordering and command caching", () => {
  const suite = createHttpPolicySuite({
    auth: auth(), cacheNamespace: "test-v1", rateLimitStore: createMemoryHttpRateLimitStore(), cacheStore: createMemoryHttpCacheStore(),
  });
  const invalid = [
    [{ name: "authenticated", options: {} }],
    [{ name: "permission", options: { allOf: [] } }],
    [{ name: "permission", options: { allOf: new Array(1) } }],
    [{ name: "tenant", options: { param: "" } }],
    [{ name: "rateLimit", options: { limit: 0, windowMs: 10 } }],
    [{ name: "cache", options: { ttlMs: Infinity } }],
    [{ name: "cache", options: { ttlMs: 1000 } }, { name: "authenticated" }],
  ];
  for (const policies of invalid) {
    expect(() => createApplication({ ...suite, modules: [fixture(policies)] })).toThrow(HttpPolicyConfigurationError);
  }
  const factory = suite.httpPolicies.cache!;
  expect(() => factory({ ttlMs: 1 }, { method: "POST", path: "/" })).toThrow(HttpPolicyConfigurationError);
  expect(() => factory({ ttlMs: 1 }, { method: "GET", path: "/", command: "Write" })).toThrow(HttpPolicyConfigurationError);
  const missing = createHttpPolicySuite({ auth: auth() });
  expect(() => missing.httpPolicies.cache!({ ttlMs: 1 }, { method: "GET", path: "/" })).toThrow(HttpPolicyConfigurationError);
  expect(() => missing.httpPolicies.rateLimit!({ limit: 1, windowMs: 1 }, { method: "GET", path: "/" })).toThrow(HttpPolicyConfigurationError);
});

test("HTTP telemetry includes validation, denial, failure and native routes without payloads or credentials", async () => {
  const events: HttpTelemetryEvent[] = [];
  const suite = createHttpPolicySuite({ auth: auth() });
  const module = fixture(guards, () => { throw new Error("private"); });
  module.controllers[0]!.routes[0]!.params = t.Object({ tenant: t.Literal("a") });
  const app = createApplication({
    ...suite, http: createHttpTelemetry((event) => { events.push(event); }),
    modules: [module],
  }).get("/public", () => "ok")
    .get("/denied", ({ set }) => { set.status = "Forbidden"; return "denied"; });
  const credential = await token();
  expect((await app.handle(request(undefined, "a", { "x-request-id": "request-1" }))).status).toBe(401);
  expect((await app.handle(request(credential))).status).toBe(500);
  expect((await app.handle(request(credential, "b"))).status).toBe(422);
  expect((await app.handle(new Request("http://localhost/denied"))).status).toBe(403);
  expect((await app.handle(new Request("http://localhost/private-unmatched?credential=private"))).status).toBe(404);
  const response = await app.handle(new Request("http://localhost/public?secret=private"));
  expect(response.status).toBe(200);
  expect(response.headers.get("x-request-id")).toBeTruthy();
  await settle();
  expect(events.map((event) => event.status).sort()).toEqual([200, 401, 403, 404, 422, 500]);
  expect(events.every((event) => event.durationMs >= 0)).toBe(true);
  expect(events.find((event) => event.requestId === "request-1")?.route).toBe("/tenants/:tenant/items");
  expect(JSON.stringify(events)).not.toContain("private");
  expect(JSON.stringify(events)).not.toContain(credential);
});

test("request context and command observation share the HTTP correlation ID", async () => {
  const suite = createHttpPolicySuite({ auth: auth() });
  const app = createApplication({
    ...suite, http: createHttpTelemetry(() => {}),
    modules: [fixture(guards, (context) => ({ requestId: context.requestId }))],
  });
  const response = await app.handle(request(await token()));
  expect(await response.json()).toEqual({ requestId: response.headers.get("x-request-id") });
});

test("response validation failures never populate the cache", async () => {
  let writes = 0;
  const suite = createHttpPolicySuite({ auth: auth(), cacheNamespace: "test-v1", cacheStore: createMemoryHttpCacheStore() });
  const module = fixture([...guards, { name: "cache", options: { ttlMs: 1000 } }], () => ({ value: ++writes }));
  module.controllers[0]!.routes[0]!.response = t.Object({ value: t.String() });
  const app = createApplication({ ...suite, modules: [module] });
  const credential = await token();
  for (let i = 0; i < 2; i++) {
    expect((await app.handle(request(credential))).status).toBe(500);
    await settle();
  }
  expect(writes).toBe(2);
});

test("real HTTP serves protected cache and telemetry with fresh per-request correlation", async () => {
  let calls = 0;
  const suite = createHttpPolicySuite({ auth: auth(), cacheNamespace: "test-v1", cacheStore: createMemoryHttpCacheStore() });
  const app = createApplication({
    ...suite, http: createHttpTelemetry(() => {}),
    modules: [fixture([...guards, { name: "cache", options: { ttlMs: 1000 } }], () => ({ count: ++calls }))],
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => app.handle(req) });
  try {
    const credential = await token();
    for (const requestId of ["first", "second"]) {
      const response = await fetch(new URL("/tenants/a/items", server.url), {
        headers: { authorization: `Bearer ${credential}`, "x-request-id": requestId },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe(requestId);
      expect(await response.json()).toEqual({ count: 1 });
      await settle();
    }
    expect(calls).toBe(1);
  } finally { await server.stop(true); }
});

test("cache stores the delivered bytes without invoking toJSON a second time", async () => {
  let serializations = 0, handlers = 0;
  const suite = createHttpPolicySuite({
    auth: auth(), cacheNamespace: "serialized-v1", cacheStore: createMemoryHttpCacheStore(),
  });
  const app = createApplication({
    ...suite, modules: [fixture([...guards, { name: "cache", options: { ttlMs: 10000 } }], () => {
      handlers++;
      return { toJSON: () => ({ serialization: ++serializations }) };
    })],
  });
  const credential = await token();
  const first = await (await app.handle(request(credential))).text();
  await settle();
  const second = await (await app.handle(request(credential))).text();
  expect(first).toBe('{"serialization":1}');
  expect(second).toBe(first);
  expect(serializations).toBe(1);
  expect(handlers).toBe(1);
});

test("shared cache requires explicit deployment namespace and separates rolling releases", async () => {
  const cacheStore = createMemoryHttpCacheStore();
  const policies = [...guards, { name: "cache", options: { ttlMs: 10000 } }];
  const missingNamespace = createHttpPolicySuite({ auth: auth(), cacheStore });
  expect(() => createApplication({ ...missingNamespace, modules: [fixture(policies)] })).toThrow("cacheNamespace");
  let calls = 0;
  const application = (version: string) => createApplication({
    ...createHttpPolicySuite({ auth: auth(), cacheStore, cacheNamespace: version }),
    modules: [fixture(policies, () => ({ version, call: ++calls }))],
  });
  const credential = await token();
  const first = application("v1");
  expect(await (await first.handle(request(credential))).json()).toEqual({ version: "v1", call: 1 });
  await settle();
  expect(await (await application("v2").handle(request(credential))).json()).toEqual({ version: "v2", call: 2 });
  expect(await (await application("v1").handle(request(credential))).json()).toEqual({ version: "v1", call: 1 });
});

test("access-provider exceptions including public errors and Responses never expose backend details", async () => {
  const credential = await token();
  for (const error of [
    new Error("private-provider-secret"),
    new ApplicationError("private-provider-secret", { status: 403, code: "PRIVATE_PROVIDER" }),
    new Response("private-provider-secret", { status: 500 }),
  ]) {
    const suite = createHttpPolicySuite({ auth: auth(async () => { throw error; }) });
    const response = await createApplication({ ...suite, modules: [fixture(guards)] }).handle(request(credential));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-provider");
  }
});

test("invalidating while a read is in flight rejects its stale cache fill", async () => {
  const store = createMemoryHttpCacheStore();
  const suite = createHttpPolicySuite({ auth: auth(), cacheNamespace: "generation", cacheStore: store });
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  let value = "old", first = true;
  const app = createApplication({
    ...suite, modules: [fixture([...guards, { name: "cache", options: { ttlMs: 10000 } }], async () => {
      const snapshot = value;
      if (first) { first = false; entered.resolve(); await resume.promise; }
      return { value: snapshot };
    })],
  });
  const credential = await token();
  const pending = app.handle(request(credential));
  await entered.promise;
  value = "new";
  await store.clear();
  resume.resolve();
  expect(await (await pending).json()).toEqual({ value: "old" });
  await settle();
  expect(await (await app.handle(request(credential))).json()).toEqual({ value: "new" });
});
