import { beforeAll, expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApplication, createSupAuthRequestContext, requireTrustedIdentity, type CompiledModule, type SupAuthContextOptions } from "./index";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let resolveKey: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  keys = await generateKeyPair("ES256");
  resolveKey = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "test", alg: "ES256" }] });
});
const issuer = "https://identity.example/auth/v1";
async function token(claims: Record<string, unknown> = {}) {
  return new SignJWT({ sub: "person", role: "authenticated", client_id: "app-a", iss: issuer, aud: "enterprise", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "test" }).sign(keys.privateKey);
}
function options(overrides: Partial<SupAuthContextOptions> = {}): SupAuthContextOptions {
  return {
    issuer, audience: "enterprise", clientId: "app-a", projectId: "app-a",
    jwksUrl: "https://identity.example/auth/v1/.well-known/jwks.json",
    keyResolver: resolveKey,
    resolveAccess: async () => ({ projectId: "app-a", tenantId: "tenant-a", permissions: ["review.approve"] }),
    ...overrides,
  };
}
function request(token?: string) {
  return new Request("https://app.example/reviews", { headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "x-supacloud-jwt-sub": "forged-admin",
    "x-tenant-id": "forged-tenant",
  } });
}

test("verified issuer/subject and local access replace all forwarded identity claims", async () => {
  const credential = await token();
  const context = await createSupAuthRequestContext(options())(request(credential));
  expect(context.identity.subject).toBe("person");
  expect(context.identity.issuer).toBe(issuer);
  expect(context.access.tenantId).toBe("tenant-a");
  expect(requireTrustedIdentity(context).accessToken).toBe(credential);
  expect(JSON.stringify(context.identity)).not.toContain(credential);
  expect(Object.isFrozen(context.identity)).toBe(true);
  expect(Object.isFrozen(context.access.permissions)).toBe(true);
});

test("invalid credentials fail before application access lookup", async () => {
  let lookups = 0;
  const factory = createSupAuthRequestContext(options({
    resolveAccess: async () => { lookups++; return null; },
  }));
  for (const credential of [
    undefined, "invalid", await token({ iss: "https://other.example" }),
    await token({ aud: "other" }), await token({ exp: 1 }),
    await token({ sub: "" }), await token({ exp: undefined }),
    await token({ nbf: Math.floor(Date.now() / 1000) + 600 }),
    await token({ client_id: "other" }), await token({ client_id: undefined }),
    await token({ azp: "other" }), await token({ client_id: 42 }),
    await token({ role: "service_role" }), await token({ role: undefined }),
  ]) {
    await expect(factory(request(credential))).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
  }
  expect(lookups).toBe(0);
});

test("unified login is denied for another application or revoked membership", async () => {
  const credential = await token();
  for (const access of [
    null,
    { projectId: "app-b", tenantId: "tenant-b", permissions: ["review.approve"] },
  ]) {
    await expect(createSupAuthRequestContext(options({ resolveAccess: async () => access }))(request(credential)))
      .rejects.toMatchObject({ status: 403 });
  }
});

test("key failures are sanitized and never fall back to forwarded subjects", async () => {
  const factory = createSupAuthRequestContext(options({
    keyResolver: async () => { throw new Error("private endpoint failure"); },
  }));
  await expect(factory(request(await token()))).rejects.toMatchObject({
    status: 503, code: "AUTHENTICATION_UNAVAILABLE", message: "Identity verification service unavailable",
  });
});

test("azp alone and matching dual application claims are supported", async () => {
  for (const claims of [{ client_id: undefined, azp: "app-a" }, { azp: "app-a" }]) {
    expect((await createSupAuthRequestContext(options())(request(await token(claims)))).identity.clientId).toBe("app-a");
  }
});

test("asymmetric trust and HTTPS configuration are mandatory", () => {
  expect(() => createSupAuthRequestContext(options({ issuer: "http://identity.example" }))).toThrow("HTTPS");
  expect(() => createSupAuthRequestContext(options({ jwksUrl: "http://identity.example/keys" }))).toThrow("HTTPS");
  expect(() => createSupAuthRequestContext(options({ algorithms: [] }))).toThrow("ES256");
  expect(() => createSupAuthRequestContext(options({ projectId: "" }))).toThrow("required");
});

test("wrong signing keys and symmetric credentials are rejected", async () => {
  const other = await generateKeyPair("ES256");
  const claims = { sub: "person", iss: issuer, aud: "enterprise", exp: Math.floor(Date.now() / 1000) + 60, iat: Math.floor(Date.now() / 1000) };
  const forged = await new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "test" }).sign(other.privateKey);
  const symmetric = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", kid: "test" }).sign(new TextEncoder().encode("not-a-trusted-key-not-a-trusted-key"));
  for (const credential of [forged, symmetric]) {
    await expect(createSupAuthRequestContext(options())(request(credential))).rejects.toMatchObject({ status: 401 });
  }
});

test("actual HTTP handlers run only for verified users with access to the current application", async () => {
  let calls = 0;
  let active = true;
  const module: CompiledModule = {
    name: "protected",
    createServices: () => ({ controller: { get: () => { calls++; return { ok: true }; } } }),
    controllers: [{ path: "", serviceKey: "controller", scope: "application", routes: [{ method: "GET", path: "/reviews", handler: "get" }] }],
  };
  const app = createApplication({
    modules: [module],
    requestContext: createSupAuthRequestContext(options({
      resolveAccess: async () => active ? { projectId: "app-a", tenantId: "tenant-a", permissions: [] } : null,
    })),
  });
  const credential = await token();
  expect((await app.handle(request())).status).toBe(401);
  expect((await app.handle(request("bad"))).status).toBe(401);
  expect(calls).toBe(0);
  expect((await app.handle(request(credential))).status).toBe(200);
  active = false;
  expect((await app.handle(request(credential))).status).toBe(403);
  expect(calls).toBe(1);
});
