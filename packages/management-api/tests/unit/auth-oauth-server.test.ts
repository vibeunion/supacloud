// @supacloud-test-isolate
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { createLocalJWKSet, jwtVerify, generateKeyPair, exportJWK } from "jose";
import { authOAuthServerRoutes } from "../../src/routes/auth-oauth-server";
import { projectService } from "../../src/services";
import { projectAuthRepository } from "../../src/repositories/project-auth.repository";
import { config } from "../../src/config";
import {
  SupAuthDependentRefreshError, tenantRuntimeService, type GotrueRuntimeStatus,
} from "../../src/services/tenant-runtime.service";
import {
  buildAwsKmsRs256JwtKeyMaterial, generateOidcJwtKeyMaterial, normalizeProjectJwtKeys, normalizeProjectJwtJwks,
} from "../../src/utils/project-jwt";
import { isRecord } from "../../src/utils/project-config";
import { ProjectAuthContextError, type ProjectAuthRecord } from "../../src/utils/project-auth-record";
import { createTestFetch } from "../helpers/fetch";
import { buildProjectJwtSettings } from "../../src/services/project-jwt-settings";
import { getAuthRuntimeDescriptor } from "../../src/services/auth-runtime.service";
import { GoTrueOAuthError, requestGoTrueOAuth } from "../../src/services/gotrue-oauth-admin";

const originalFetch = globalThis.fetch;
const originalOwner = config.authRuntimeOwnerRef;
const spies: Array<{ mockRestore(): void }> = [];
function track<T extends { mockRestore(): void }>(spy: T): T {
  spies.push(spy);
  return spy;
}
afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore();
  globalThis.fetch = originalFetch;
  config.authRuntimeOwnerRef = originalOwner;
});

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an OAuth response object");
  return value;
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected an OAuth record array");
  return value.map((entry: unknown) => record(entry));
}
async function responseRecord(response: Response) {
  const value: unknown = await response.json();
  return record(value);
}
function projectRecord(projectConfig: Record<string, unknown> = {}): ProjectAuthRecord {
  return {
    ref: "proj_1", organization_id: "org_1", jwt_secret: "synthetic-project-jwt-secret",
    config: {
      api_domain: "api.example.com", postgrest_port: 3100, gotrue_port: 3200,
      auth: {}, ...projectConfig,
    },
  };
}
function runtimeStatus(): GotrueRuntimeStatus {
  return {
    component: "gotrue", desired: "running", actual: "running", port: 3200,
    unit: "supacloud-gotrue@proj_1", health: "healthy", last_error: null,
    updated_at: null, last_reconciled_at: null,
  };
}
function setup(projectConfig: Record<string, unknown> = {}) {
  config.authRuntimeOwnerRef = "";
  const project = projectRecord(projectConfig);
  const projectSpy = track(spyOn(projectAuthRepository, "findByRef").mockResolvedValue(project));
  const settingsSpy = track(spyOn(projectService, "getProjectSettings").mockResolvedValue(project.config));
  return {
    projectSpy, settingsSpy,
    updateSpy: track(spyOn(projectService, "updateProjectSettings").mockImplementation(async (_ref, settings) => {
      projectSpy.mockResolvedValue({ ...project, config: settings });
      settingsSpy.mockResolvedValue(settings);
      return settings;
    })),
    applySpy: track(spyOn(tenantRuntimeService, "applyAuthConfig").mockResolvedValue(runtimeStatus())),
  };
}
function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${config.masterToken}`);
  return new Elysia().use(authOAuthServerRoutes).handle(
    new Request(`http://localhost/v1/projects/proj_1/auth${path}`, { ...init, headers }),
  );
}
function post(path: string, body: unknown) {
  return request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
function writtenAuth(call: Parameters<typeof projectService.updateProjectSettings> | undefined) {
  if (!call) throw new Error("Expected persisted OAuth settings");
  expect(call[0]).toBe("proj_1");
  const auth = record(call[1].auth);
  return { auth, oauth: record(auth.oauth_server) };
}
async function signingConfig() {
  const material = await generateOidcJwtKeyMaterial("synthetic-project-jwt-secret");
  return {
    material,
    auth: {
      oauth_server: {
        enabled: true, allow_dynamic_registration: true,
        issuer: "https://api.example.com/auth/v1", signing_alg: material.signing_alg,
        key_id: material.key_id, jwt_keys: material.jwt_keys, jwt_jwks: material.jwt_jwks,
      },
    },
  };
}
const kmsPair = await generateKeyPair("RS256", { extractable: true });
const kmsInput = {
  aws_kms_arn: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
  key_id: "kms-key-1", public_jwk: await exportJWK(kmsPair.publicKey),
};
const oauthClientId = "12345678-1234-4234-8234-123456789abc";
function oauthClient() {
  return {
    client_id: oauthClientId, client_type: "confidential", client_name: "App",
    redirect_uris: ["https://app.example.com/callback"], token_endpoint_auth_method: "client_secret_basic",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    registration_type: "manual", created_at: "2026-09-10T00:00:00.123456789Z", updated_at: "2026-09-10T00:00:00Z",
  };
}

describe("authOAuthServerRoutes", () => {
  test("GET /oauth-server returns an account-isolated status payload", async () => {
    const signing = await signingConfig();
    const { projectSpy } = setup({ auth: signing.auth });
    const response = await request("/oauth-server");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      account_isolated: true, organization_id: "org_1", enabled: true,
      signing_alg: "ES256", oidc_id_token_ready: true,
      state_source: "configuration", runtime_verified: false,
      authorization_endpoint: "https://api.example.com/auth/v1/oauth/authorize",
      registration_endpoint: "https://api.example.com/auth/v1/oauth/clients/register",
    });
    expect(projectSpy).toHaveBeenCalledWith("proj_1");
  });

  test("POST /oauth-server/migrate stores scoped ES256 config and applies auth runtime", async () => {
    const { updateSpy, applySpy } = setup();
    const response = await post("/oauth-server/migrate", { allow_dynamic_registration: true });
    const payload = await responseRecord(response);
    const { auth, oauth } = writtenAuth(updateSpy.mock.calls[0]);
    const savedAuth = JSON.stringify(auth);
    expect(normalizeProjectJwtKeys(oauth.jwt_keys) !== null).toBe(true);
    expect(normalizeProjectJwtJwks(oauth.jwt_jwks) !== null).toBe(true);
    expect(response.status).toBe(200);
    expect(payload.account_isolated).toBe(true);
    expect(oauth).toMatchObject({
      enabled: true, allow_dynamic_registration: true, authorization_path: "/authorize.html", signing_alg: "ES256",
    });
    expect(oauth.issuer).toMatch(/\/auth\/v1$/);
    expect(payload.authorization_path).toBe("/authorize.html");
    expect(typeof oauth.key_id).toBe("string");
    expect(Array.isArray(record(oauth.jwt_jwks).keys)).toBe(true);
    expect(typeof oauth.migrated_at).toBe("string");
    expect(applySpy).toHaveBeenCalledWith("proj_1", {}, auth);
    const jwtKeys = records(oauth.jwt_keys);
    expect(jwtKeys).toHaveLength(1);
    expect(jwtKeys.find((key) => key.alg === "ES256")).toMatchObject({
      kty: "EC", alg: "ES256", use: "sig", key_ops: ["sign"],
    });
    expect(jwtKeys.find((key) => key.kid === "legacy-hs256")).toBeUndefined();

    const rejected = await post("/oauth-server/migrate", { authorization_path: "https://auth.example.com/authorize.html" });
    expect(rejected.status).toBe(400);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledTimes(1);

    expect(JSON.stringify(auth) === savedAuth).toBe(true);
    await buildProjectJwtSettings("proj_1", { ...projectRecord().config, auth }, getAuthRuntimeDescriptor("proj_1"));
    const readback = await request("/oauth-server");
    expect(readback.status, await readback.text()).toBe(200);
    applySpy.mockRejectedValueOnce(new Error("runtime apply failed"));
    const unavailable = await post("/oauth-server/migrate", { authorization_path: "/authorize.html" });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      code: "AUTH_RUNTIME_APPLY_FAILED", persisted: true, runtime_applied: false,
    });
    applySpy.mockRejectedValueOnce(new SupAuthDependentRefreshError(["dependent-project"]));
    const dependent = await post("/oauth-server/migrate", { authorization_path: "/authorize.html" });
    expect(dependent.status).toBe(503);
    expect(await dependent.json()).toMatchObject({
      code: "SUPAUTH_DEPENDENT_REFRESH_FAILED", persisted: true, runtime_applied: true,
      failed_dependents: ["dependent-project"],
    });
  });

  test("POST /oauth-server/kms-rs256 stores AWS KMS backed RS256 signing config", async () => {
    const { updateSpy, applySpy } = setup();
    const response = await post("/oauth-server/kms-rs256", { ...kmsInput, allow_dynamic_registration: true });
    const { auth, oauth } = writtenAuth(updateSpy.mock.calls[0]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signing_alg: "RS256", migration_status: "oidc_rs256_migrated" });
    expect(oauth).toMatchObject({
      enabled: true, signing_alg: "RS256", key_id: "kms-key-1",
      allow_dynamic_registration: true, authorization_path: "/authorize.html",
    });
    const jwtKeys = records(oauth.jwt_keys);
    const publicKeys = records(record(oauth.jwt_jwks).keys);
    expect(jwtKeys).toHaveLength(1);
    expect(publicKeys).toHaveLength(1);
    expect(jwtKeys[0]).toMatchObject({
      kty: "RSA", alg: "RS256", kid: "kms-key-1", key_ops: ["sign"], "aws:kms:arn": kmsInput.aws_kms_arn,
    });
    const publicKey = record(publicKeys[0]);
    expect(publicKey).toMatchObject({ kty: "RSA", alg: "RS256", kid: "kms-key-1", key_ops: ["verify"] });
    expect(publicKey["aws:kms:arn"]).toBeUndefined();
    expect(applySpy).toHaveBeenCalledWith("proj_1", {}, auth);

    applySpy.mockRejectedValueOnce(new Error("runtime apply failed"));
    const unavailable = await post("/oauth-server/kms-rs256", kmsInput);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      code: "AUTH_RUNTIME_APPLY_FAILED", persisted: true, runtime_applied: false,
    });
  });

  test("GET /oauth-clients proxies with a verifiable project-scoped GoTrue token", async () => {
    const signing = await signingConfig();
    setup({ auth: signing.auth });
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = createTestFetch(async (input, init) => {
      calls.push({ url: input instanceof Request ? input.url : String(input), init });
      return Response.json({ clients: [] });
    });
    const response = await request("/oauth-clients");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clients: [] });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("Expected one GoTrue request");
    expect(call.url).toBe("http://127.0.0.1:3200/admin/oauth/clients?page=&per_page=");
    expect(call.init?.redirect).toBe("error");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("x-supabase-api-version")).toBe("2024-01-01");
    const authorization = headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new Error("Expected a bearer token");
    const adminToken = authorization.slice(7);
    expect(headers.get("x-project-ref")).toBe("proj_1");
    expect(headers.get("apikey")).toBe(adminToken);
    const verified = await jwtVerify(adminToken, createLocalJWKSet(signing.material.jwt_jwks), {
      algorithms: ["ES256"], issuer: "https://api.example.com/auth/v1",
    });
    expect(verified.protectedHeader).toMatchObject({ alg: "ES256", kid: signing.material.key_id });
    expect(verified.payload.role).toBe("service_role");
    const unrelated = await signingConfig();
    await expect(jwtVerify(adminToken, createLocalJWKSet(unrelated.material.jwt_jwks))).rejects.toThrow();
  });

  test("GET /oauth-clients explains KMS-only projects cannot use the local admin proxy", async () => {
    const material = await buildAwsKmsRs256JwtKeyMaterial(kmsInput);
    setup({ auth: { oauth_server: {
      enabled: true, issuer: "https://api.example.com/auth/v1", signing_alg: "RS256",
      jwt_keys: material.jwt_keys, jwt_jwks: material.jwt_jwks,
    } } });
    const fetchMock = mock(async () => Response.json({}));
    globalThis.fetch = createTestFetch(fetchMock);
    const response = await request("/oauth-clients");
    expect(response.status).toBe(409);
    expect((await responseRecord(response)).message).toContain("cannot locally sign RS256/KMS tokens yet");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("POST /oauth-clients sends empty secret for public GoTrue clients", async () => {
    const signing = await signingConfig();
    setup({ auth: signing.auth });
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = createTestFetch(async (input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected serialized OAuth client body");
      const body: unknown = JSON.parse(init.body);
      calls.push({ url: input instanceof Request ? input.url : String(input), body });
      return Response.json({
        ...oauthClient(), client_type: "public", client_name: "Public app", token_endpoint_auth_method: "none",
      }, { status: 201 });
    });
    const response = await post("/oauth-clients", {
      client_type: "public", redirect_uris: ["https://app.example.com/callback"],
      grant_types: ["authorization_code", "refresh_token"], client_name: "Public app",
    });
    expect(response.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:3200/admin/oauth/clients",
      body: { client_type: "public", token_endpoint_auth_method: "none", client_secret: "" },
    });
  });
});

describe("official GoTrue SDK boundary", () => {
  test("normalizes documented empty lists and rejects malformed fields without leaking unknown fields", async () => {
    const signing = await signingConfig();
    setup({ auth: signing.auth });
    let payload: unknown = {};
    globalThis.fetch = createTestFetch(async () => Response.json(payload));
    expect(await (await request("/oauth-clients")).json()).toEqual({ clients: [] });
    payload = { clients: [{ ...oauthClient(), private_config: "hidden" }] };
    expect(await (await request("/oauth-clients")).json()).toEqual({ clients: [oauthClient()] });
    for (const bad of [
      null, [], { error: "private backend message" }, { clients: null },
      { clients: [oauthClient(), oauthClient()] },
      ...[
        { client_id: "client_1" }, { client_type: "unknown" }, { client_name: 1 },
        { token_endpoint_auth_method: "none" }, { redirect_uris: [5] },
        { redirect_uris: ["javascript:alert(1)"] }, { grant_types: ["password"] },
        { response_types: ["token"] }, { registration_type: true },
        { created_at: "2026-02-31T00:00:00Z" }, { updated_at: "2026-01-01" },
        { client_uri: "https://user:password@app.test" }, { logo_uri: [] },
        { client_secret: "hidden" }, { client_type: null }, { redirect_uris: null },
      ].map(patch => ({ clients: [{ ...oauthClient(), ...patch }] })),
    ]) {
      payload = bad;
      const response = await request("/oauth-clients");
      expect(response.status, JSON.stringify(bad)).toBe(502);
      expect(await response.text()).not.toContain("hidden");
    }
  });

  test("validates inputs before dispatch and validates client identity and submitted mutation receipts", async () => {
    const signing = await signingConfig();
    setup({ auth: signing.auth });
    let calls = 0;
    let payload: unknown = oauthClient();
    globalThis.fetch = createTestFetch(async (_url, options) => {
      calls++;
      return Response.json(payload, { status: options?.method === "POST" ? 201 : 200 });
    });
    for (const input of [
      { redirect_uris: [] }, { redirect_uris: ["javascript:alert(1)"] },
      { redirect_uris: ["https://app.test/#fragment"] },
      { redirect_uris: ["https://app.test/"], client_type: "public", token_endpoint_auth_method: "client_secret_basic" },
    ]) expect((await post("/oauth-clients", input)).status).toBe(400);
    expect((await request("/oauth-clients/not-a-uuid")).status).toBe(400);
    expect(calls).toBe(0);
    payload = { ...oauthClient(), client_id: "aaaaaaaa-1234-4234-8234-123456789abc" };
    expect((await request(`/oauth-clients/${oauthClientId}`)).status).toBe(502);
    payload = oauthClient();
    const mismatch = await request(`/oauth-clients/${oauthClientId}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Changed" }),
    });
    expect(mismatch.status).toBe(502);
    expect(await mismatch.json()).toMatchObject({ mutation_may_have_applied: true });
    const missingSecret = await post("/oauth-clients", { redirect_uris: oauthClient().redirect_uris, client_name: "App" });
    expect(missingSecret.status).toBe(502);
    payload = { ...oauthClient(), client_secret: "one-time-secret" };
    const created = await post("/oauth-clients", { redirect_uris: oauthClient().redirect_uris, client_name: "App" });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ client_secret: "one-time-secret" });
    expect(calls).toBe(4);
  });

  test("rejects accessor-backed and non-data OAuth inputs before SDK dispatch", async () => {
    let accesses = 0;
    let calls = 0;
    const getter = () => { accesses++; return "App"; };
    const accessorInput = Object.defineProperty({}, "client_name", { enumerable: true, get: getter });
    const accessorUris = Object.defineProperty(["https://app.test/"], "0", {
      enumerable: true, get() { accesses++; return "https://app.test/"; },
    });
    const overriddenUris = Object.assign(["https://app.test/"], {
      map() { accesses++; return ["https://app.test/"]; },
    });
    globalThis.fetch = createTestFetch(async () => { calls++; return Response.json(oauthClient()); });
    for (const input of [
      accessorInput,
      Object.create({ client_name: "App" }),
      Object.assign({ client_name: "App" }, { [Symbol("hidden")]: "ignored" }),
      Object.defineProperty({ client_name: "App" }, "hidden", { value: "ignored" }),
      { redirect_uris: accessorUris },
      { redirect_uris: new Array(1) },
      { redirect_uris: overriddenUris },
    ]) {
      await expect(requestGoTrueOAuth({
        url: "http://127.0.0.1:3200", projectRef: "proj_1", adminToken: "synthetic-token",
        signal: new AbortController().signal,
      }, { kind: "update", clientId: oauthClientId, input })).rejects.toMatchObject({ status: 400 });
    }
    expect(accesses).toBe(0);
    expect(calls).toBe(0);
    const validInput: Record<string, unknown> = Object.create(null);
    validInput.client_name = "App";
    validInput.redirect_uris = Object.freeze([...oauthClient().redirect_uris]);
    const accepted = await requestGoTrueOAuth({
      url: "http://127.0.0.1:3200", projectRef: "proj_1", adminToken: "synthetic-token",
      signal: new AbortController().signal,
    }, { kind: "update", clientId: oauthClientId, input: Object.freeze(validInput) });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ client_id: oauthClientId, client_name: "App" });
    expect(calls).toBe(1);
  });

  test("validates the OAuth operation discriminator and own data before dispatch", async () => {
    let accesses = 0;
    let calls = 0;
    const accessor = Object.defineProperty({}, "kind", {
      enumerable: true, get() { accesses++; return "list"; },
    });
    globalThis.fetch = createTestFetch(async () => { calls++; return Response.json({ clients: [] }); });
    const invalidOperations: unknown[] = [
      null, [], "list", {}, { kind: "unknown" }, { kind: 1 },
      { kind: "list", clientId: oauthClientId }, { kind: "create" },
      { kind: "get" }, { kind: "delete", clientId: 123 },
      { kind: "regenerate", clientId: "invalid" },
      { kind: "update", clientId: oauthClientId },
      Object.create({ kind: "list" }), accessor,
      Object.assign({ kind: "list" }, { [Symbol("hidden")]: true }),
      Object.defineProperty({ kind: "list" }, "hidden", { value: true }),
    ];
    for (const operation of invalidOperations) {
      await expect(requestGoTrueOAuth({
        url: "http://127.0.0.1:3200", projectRef: "proj_1", adminToken: "synthetic-token",
        signal: new AbortController().signal,
      }, operation)).rejects.toMatchObject({ status: 400, mutationMayHaveApplied: false });
    }
    expect(accesses).toBe(0);
    expect(calls).toBe(0);
    const validOperation: Record<string, unknown> = Object.create(null);
    validOperation.kind = "list";
    const response = await requestGoTrueOAuth({
      url: "http://127.0.0.1:3200", projectRef: "proj_1", adminToken: "synthetic-token",
      signal: new AbortController().signal,
    }, Object.freeze(validOperation));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clients: [] });
    expect(calls).toBe(1);
  });

  test("validates OAuth context without coercion or caller-provided signal methods", async () => {
    let executions = 0;
    let calls = 0;
    const context = {
      url: "http://127.0.0.1:3200", projectRef: "proj_1", adminToken: "synthetic-token",
      signal: new AbortController().signal,
    };
    const coercible = { toString() { executions++; return context.url; } };
    const accessor = Object.defineProperty({ ...context }, "adminToken", {
      enumerable: true, get() { executions++; return "synthetic-token"; },
    });
    const fakeSignal = {
      throwIfAborted() { executions++; },
      addEventListener() { executions++; },
      removeEventListener() { executions++; },
    };
    globalThis.fetch = createTestFetch(async () => { calls++; return Response.json({ clients: [] }); });
    const invalidContexts: unknown[] = [
      null, [], Object.create(context), accessor,
      Object.assign({ ...context }, { [Symbol("extra")]: true }),
      Object.defineProperty({ ...context }, "hidden", { value: true }),
      { ...context, extra: true }, { ...context, url: coercible },
      { ...context, projectRef: 123 }, { ...context, adminToken: 123 },
      { ...context, adminToken: coercible }, { ...context, signal: fakeSignal },
      { ...context, signal: Object.create(AbortSignal.prototype) },
      { ...context, signal: null }, { ...context, timeoutMs: null },
      { ...context, timeoutMs: "1000" }, { ...context, timeoutMs: 0 },
      { ...context, timeoutMs: 120001 }, { ...context, timeoutMs: NaN },
      { ...context, url: "file:///tmp/auth" }, { ...context, adminToken: "bad token" },
    ];
    for (const value of invalidContexts) {
      await expect(requestGoTrueOAuth(value, { kind: "list" })).rejects.toMatchObject({
        status: 502, mutationMayHaveApplied: false,
      });
    }
    expect(executions).toBe(0);
    expect(calls).toBe(0);
    const signal = new AbortController().signal;
    for (const method of ["throwIfAborted", "addEventListener", "removeEventListener"]) {
      Object.defineProperty(signal, method, { get() { executions++; throw new Error("caller method"); } });
    }
    const validContext: Record<string, unknown> = Object.create(null);
    Object.assign(validContext, context, { signal, timeoutMs: 1000 });
    const response = await requestGoTrueOAuth(Object.freeze(validContext), { kind: "list" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clients: [] });
    expect(executions).toBe(0);
    expect(calls).toBe(1);
    for (const reason of [null, false, 0, "", { cancelled: true }]) {
      const cancelled = new AbortController();
      cancelled.abort(reason);
      await expect(requestGoTrueOAuth({ ...context, signal: cancelled.signal }, { kind: "list" }))
        .rejects.toBe(reason);
    }
    expect(calls).toBe(1);
  });

  test("rejects unexpected success statuses and bounds response bodies", async () => {
    const signing = await signingConfig();
    setup({ auth: signing.auth });
    for (const reply of [
      new Response(null, { status: 204 }),
      Response.json({ clients: [] }, { status: 201 }),
      new Response("<html>private upstream message</html>", { headers: { "content-type": "text/html" } }),
      new Response("invalid JSON", { headers: { "content-type": "application/json" } }),
      new Response(`{"padding":"${"x".repeat(1024 * 1024)}"}`, { headers: { "content-type": "application/json" } }),
      Response.json({ message: "private upstream message" }, { status: 500 }),
    ]) {
      globalThis.fetch = createTestFetch(async () => reply);
      const response = await request("/oauth-clients");
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("private upstream message");
    }
    for (const reply of [new Response(null), Response.json({ success: true })]) {
      globalThis.fetch = createTestFetch(async () => reply);
      const response = await request(`/oauth-clients/${oauthClientId}`, { method: "DELETE" });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ mutation_may_have_applied: true });
    }
  });

  test("cancels hanging streams and late fetches without retrying mutations", async () => {
    const cancelled = new AbortController();
    let calls = 0;
    globalThis.fetch = createTestFetch(async () => { calls++; return Response.json({ clients: [] }); });
    cancelled.abort();
    await expect(requestGoTrueOAuth({
      url: "http://127.0.0.1:3200", projectRef: "proj_1", adminToken: "synthetic-token", signal: cancelled.signal,
    }, { kind: "list" })).rejects.toThrow();
    expect(calls).toBe(0);
    let closed = false;
    globalThis.fetch = createTestFetch(async () => {
      calls++;
      return new Response(new ReadableStream({ cancel() { closed = true; } }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    });
    const streamTimeout = requestGoTrueOAuth({
      url: "http://127.0.0.1:3200", projectRef: "proj_1", adminToken: "synthetic-token",
      signal: new AbortController().signal, timeoutMs: 25,
    }, { kind: "create", input: { redirect_uris: oauthClient().redirect_uris } });
    try { await streamTimeout; throw new Error("Expected stream deadline failure"); }
    catch (error) {
      if (!(error instanceof GoTrueOAuthError)) throw error;
      expect(error.status).toBe(504);
      expect(error.mutationMayHaveApplied).toBe(true);
    }
    expect(calls).toBe(1);
    expect(closed).toBe(true);
    const late = Promise.withResolvers<Response>();
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = createTestFetch(async (_url, options) => { calls++; signal = options?.signal; return late.promise; });
    const pending = requestGoTrueOAuth({
      url: "http://127.0.0.1:3200", projectRef: "proj_1", adminToken: "synthetic-token",
      signal: new AbortController().signal, timeoutMs: 25,
    }, { kind: "delete", clientId: oauthClientId });
    try { await pending; throw new Error("Expected deadline failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(GoTrueOAuthError);
      if (!(error instanceof GoTrueOAuthError)) throw error;
      expect(error.status).toBe(504);
      expect(error.mutationMayHaveApplied).toBe(true);
    }
    expect(signal?.aborted).toBe(true);
    let disposed = false;
    late.resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(disposed).toBe(true);
    expect(calls).toBe(2);
  });

  test("rejects changed project configuration before and after an SDK operation", async () => {
    const signing = await signingConfig();
    const { projectSpy } = setup({ auth: signing.auth });
    const original = projectRecord({ auth: signing.auth });
    const changed = projectRecord({ auth: signing.auth, gotrue_port: 3201 });
    let calls = 0;
    globalThis.fetch = createTestFetch(async () => { calls++; return Response.json({ clients: [] }); });
    projectSpy.mockResolvedValueOnce(original).mockResolvedValue(changed);
    expect((await request("/oauth-clients")).status).toBe(503);
    expect(calls).toBe(0);
    projectSpy.mockResolvedValue(original);
    globalThis.fetch = createTestFetch(async () => {
      calls++;
      projectSpy.mockResolvedValue(changed);
      return Response.json({ clients: [] });
    });
    expect((await request("/oauth-clients")).status).toBe(503);
    expect(calls).toBe(1);
    projectSpy.mockResolvedValue(original);
    globalThis.fetch = createTestFetch(async () => {
      calls++;
      projectSpy.mockResolvedValue(changed);
      return new Response(null, { status: 204 });
    });
    const changedAfterDelete = await request(`/oauth-clients/${oauthClientId}`, { method: "DELETE" });
    expect(changedAfterDelete.status).toBe(503);
    expect(await changedAfterDelete.json()).toMatchObject({
      code: "OAUTH_CONTEXT_UNCONFIRMED", mutation_may_have_applied: true,
    });
    expect(calls).toBe(2);
  });

  test("real HTTP SDK lifecycle preserves upstream paths, receipts and project-scoped credentials", async () => {
    const signing = await signingConfig();
    const requests: Array<{ path: string; method: string; headers: Headers; body: unknown }> = [];
    let saved: Record<string, unknown> = oauthClient();
    let removed = false;
    const upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body: unknown = req.method === "POST" || req.method === "PUT" ? await req.text() : undefined;
        const parsed: unknown = body ? JSON.parse(String(body)) : undefined;
        requests.push({ path, method: req.method, headers: req.headers, body: parsed });
        if (path === `/admin/oauth/clients/${oauthClientId}/regenerate_secret`) {
          return Response.json({ ...saved, client_secret: "rotated-secret" });
        }
        if (req.method === "POST") {
          saved = { ...oauthClient(), ...record(parsed) };
          return Response.json({ ...saved, client_secret: "initial-secret" }, { status: 201 });
        }
        if (req.method === "PUT") saved = { ...saved, ...record(parsed) };
        if (req.method === "DELETE") { removed = true; return new Response(null, { status: 204 }); }
        if (path === "/admin/oauth/clients") return Response.json(removed ? {} : { clients: [saved] });
        return Response.json(saved);
      },
    });
    try {
      setup({ auth: signing.auth, gotrue_port: upstream.port });
      const unauthorized = await request("/oauth-clients", { headers: { authorization: "Bearer invalid" } });
      expect(unauthorized.status).toBe(401);
      expect(requests).toHaveLength(0);
      const created = await post("/oauth-clients", { client_name: "App", redirect_uris: oauthClient().redirect_uris });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ client_secret: "initial-secret" });
      expect((await request(`/oauth-clients/${oauthClientId}`)).status).toBe(200);
      const updated = await request(`/oauth-clients/${oauthClientId}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Changed" }),
      });
      expect(await updated.json()).toMatchObject({ client_name: "Changed" });
      const rotated = await request(`/oauth-clients/${oauthClientId}/regenerate-secret`, { method: "POST" });
      expect(await rotated.json()).toMatchObject({ client_secret: "rotated-secret" });
      expect((await request(`/oauth-clients/${oauthClientId}`, { method: "DELETE" })).status).toBe(204);
      expect(await (await request("/oauth-clients")).json()).toEqual({ clients: [] });
      expect(requests.map(value => value.method)).toEqual(["POST", "GET", "PUT", "POST", "DELETE", "GET"]);
      for (const call of requests) {
        expect(call.path).toStartWith("/admin/oauth/clients");
        expect(call.headers.get("x-project-ref")).toBe("proj_1");
        expect(call.headers.get("x-supabase-api-version")).toBe("2024-01-01");
        const token = call.headers.get("apikey");
        if (!token) throw new Error("Missing project credential");
        const verified = await jwtVerify(token, createLocalJWKSet(signing.material.jwt_jwks));
        expect(verified.payload.role).toBe("service_role");
        expect(call.headers.get("authorization")).toBe(`Bearer ${token}`);
      }
    } finally { await upstream.stop(true); }
  });
});

describe("OAuth context failures", () => {
  test("unconfigured OAuth reports only configuration state, without inventing signing readiness", async () => {
    setup();
    const response = await request("/oauth-server");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: false, signing_alg: "not_migrated", oidc_id_token_ready: false,
      migration_status: "not_migrated", state_source: "configuration", runtime_verified: false,
      authorization_path: "/authorize.html",
    });
  });

  test("invalid or contradictory OAuth signing configuration cannot become status or a migration write", async () => {
    const signing = await signingConfig();
    const unrelated = await signingConfig();
    const { projectSpy, settingsSpy, updateSpy, applySpy } = setup({ auth: signing.auth });
    const oauth = signing.auth.oauth_server;
    for (const next of [
      { ...oauth, jwt_keys: [] }, { ...oauth, jwt_jwks: { keys: [] } },
      { ...oauth, signing_alg: "HS256" }, { ...oauth, key_id: "wrong-key" },
      { ...oauth, jwt_jwks: unrelated.material.jwt_jwks },
      { ...oauth, authorization_path: "/%2e%2e/private" },
      { ...oauth, issuer: "https://user:private-password@auth.test/auth/v1" },
    ]) {
      const project = projectRecord({ auth: { oauth_server: next } });
      projectSpy.mockResolvedValue(project);
      settingsSpy.mockResolvedValue(project.config);
      const response = await request("/oauth-server");
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        code: "PROJECT_AUTH_CONTEXT_UNAVAILABLE", message: "Project authentication context unavailable",
      });
      expect((await post("/oauth-server/migrate", {})).status).toBe(503);
    }
    expect(updateSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
  });

  test("migration preserves an existing validated RS256 KMS algorithm and key identity", async () => {
    const material = await buildAwsKmsRs256JwtKeyMaterial(kmsInput);
    const { updateSpy, applySpy } = setup({ auth: { oauth_server: {
      ...material, enabled: true, issuer: "https://api.example.com/auth/v1",
    } } });
    const response = await post("/oauth-server/migrate", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      signing_alg: "RS256", key_id: material.key_id, migration_status: "oidc_rs256_migrated",
      state_source: "configuration", runtime_verified: false,
    });
    const { oauth } = writtenAuth(updateSpy.mock.calls[0]);
    expect(oauth.signing_alg).toBe("RS256");
    expect(oauth.jwt_keys).toEqual(material.jwt_keys);
    expect(oauth.jwt_jwks).toEqual(material.jwt_jwks);
    expect(applySpy).toHaveBeenCalledTimes(1);
  });

  test("a fabricated persistence receipt cannot trigger runtime application", async () => {
    const { updateSpy, applySpy } = setup();
    updateSpy.mockImplementationOnce(async (_ref, settings) => settings);
    const response = await post("/oauth-server/migrate", {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "PROJECT_AUTH_CONTEXT_UNAVAILABLE", message: "Project authentication context unavailable",
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(applySpy).not.toHaveBeenCalled();
  });

  test("changed project context cannot return old OAuth status or authorize a pending migration", async () => {
    const signing = await signingConfig();
    const { projectSpy, updateSpy, applySpy } = setup({ auth: signing.auth });
    const initial = projectRecord({ auth: signing.auth });
    projectSpy.mockResolvedValueOnce(initial).mockResolvedValue({ ...initial, organization_id: "other-org" });
    expect((await request("/oauth-server")).status).toBe(503);
    projectSpy.mockResolvedValueOnce(initial).mockResolvedValue({ ...initial, jwt_secret: "changed-secret" });
    expect((await post("/oauth-server/migrate", {})).status).toBe(503);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
  });

  test("external Auth prevents local OAuth status, mutation and administrative proxy requests", async () => {
    const { settingsSpy, updateSpy, applySpy } = setup({ auth: {
      third_party_auth: { enabled: true, auth_upstream: "https://external.example.test" },
    } });
    const network = mock(async () => Response.json({}));
    globalThis.fetch = createTestFetch(network);
    for (const response of [
      await request("/oauth-server"), await request("/oauth-clients"),
      await post("/oauth-server/migrate", {}), await post("/oauth-server/kms-rs256", kmsInput),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "AUTH_RUNTIME_NOT_LOCAL" });
    }
    expect(settingsSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  test("unusable RSA public keys fail validation before persistence or runtime application", async () => {
    const { updateSpy, applySpy } = setup();
    const response = await post("/oauth-server/kms-rs256", {
      ...kmsInput, public_jwk: { kty: "RSA", n: "sXch7w", e: "AQAB" },
    });
    expect(response.status).toBe(503);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
  });

  test("KMS configuration cannot silently replace an invalid persisted authorization path with a default", async () => {
    const { updateSpy, applySpy } = setup({ auth: { oauth_server: { authorization_path: "/%2e%2e/private" } } });
    const response = await post("/oauth-server/kms-rs256", kmsInput);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "PROJECT_AUTH_CONTEXT_UNAVAILABLE" });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
  });

  test("rejects unauthenticated reads before accessing the project record", async () => {
    const { projectSpy } = setup();
    const response = await new Elysia().use(authOAuthServerRoutes).handle(
      new Request("http://localhost/v1/projects/proj_1/auth/oauth-server"),
    );
    expect(response.status).toBe(401);
    expect(projectSpy).not.toHaveBeenCalled();
  });

  test("does not invent a default context after the project record disappears", async () => {
    const { projectSpy, updateSpy, applySpy } = setup();
    projectSpy.mockResolvedValue(null);
    expect((await request("/oauth-server")).status).toBe(404);
    expect((await post("/oauth-server/migrate", {})).status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
  });

  test("returns a non-cacheable generic error for invalid persisted context", async () => {
    const { projectSpy, updateSpy, applySpy } = setup();
    projectSpy.mockRejectedValue(new ProjectAuthContextError());
    const response = await post("/oauth-server/migrate", {});
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      code: "PROJECT_AUTH_CONTEXT_UNAVAILABLE", message: "Project authentication context unavailable",
    });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
  });

  test.each([
    { oauth_server: { enabled: "true" } },
    { oauth_server: { issuer: 42 } },
    { oauth_server: { authorization_path: [] } },
    { oauth_server: "private-invalid-config" },
  ])("rejects invalid current settings %# before persisting or applying", async (auth) => {
    const { settingsSpy, updateSpy, applySpy } = setup();
    settingsSpy.mockResolvedValue({ auth });
    const response = await post("/oauth-server/migrate", {});
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-invalid-config");
    expect(updateSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
  });

  test.each(["/oauth-server/migrate", "/oauth-server/kms-rs256"])(
    "does not apply runtime state after a missing persistence receipt at %s", async (path) => {
      const { updateSpy, applySpy } = setup();
      updateSpy.mockResolvedValue(null);
      const response = await post(path, path.endsWith("kms-rs256") ? kmsInput : {});
      expect(response.status).toBe(404);
      expect(applySpy).not.toHaveBeenCalled();
    },
  );
});

describe("OAuth proxy native redirect boundary", () => {
  test.each([301, 302, 303, 307, 308].flatMap((status) => [
    { status, crossOrigin: false }, { status, crossOrigin: true },
  ]))("does not forward administrative credentials through redirect %#", async ({ status, crossOrigin }) => {
    const signing = await signingConfig();
    let targetRequests = 0;
    const sourceHeaders: Headers[] = [];
    const target = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() { targetRequests++; return Response.json({ clients: [] }); },
    });
    const source = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/target") {
          targetRequests++;
          return Response.json({ clients: [] });
        }
        sourceHeaders.push(request.headers);
        return new Response(null, {
          status, headers: { location: crossOrigin ? new URL("/target", target.url).href : "/target" },
        });
      },
    });
    const app = new Elysia().use(authOAuthServerRoutes);
    const management = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      setup({ auth: signing.auth, gotrue_port: source.port });
      const response = await originalFetch(new URL("/v1/projects/proj_1/auth/oauth-clients", management.url), {
        headers: { authorization: `Bearer ${config.masterToken}` },
      });
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ code: "502", message: "GoTrue OAuth admin endpoint unavailable" });
      expect(sourceHeaders).toHaveLength(1);
      const headers = sourceHeaders[0];
      if (!headers) throw new Error("Expected the authorized upstream request");
      expect(headers.get("authorization")).toStartWith("Bearer ");
      expect(headers.get("apikey")).toBeTruthy();
      expect(targetRequests).toBe(0);
    } finally {
      await management.stop(true);
      await source.stop(true);
      await target.stop(true);
    }
  });
});
