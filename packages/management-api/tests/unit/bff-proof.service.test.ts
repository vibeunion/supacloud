import { beforeEach, describe, expect, mock, test } from "bun:test";

const consumedNonces = new Set<string>();
const transaction = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join("?");
  if (query.includes("DELETE FROM supaoauth_bff_proof_nonces")) return Promise.resolve([]);
  if (query.includes("INSERT INTO supaoauth_bff_proof_nonces")) {
    const nonce = String(values[0]);
    if (consumedNonces.has(nonce)) return Promise.resolve([]);
    consumedNonces.add(nonce);
    return Promise.resolve([{ nonce }]);
  }
  return Promise.resolve([]);
});
const sql = Object.assign(mock(() => Promise.resolve([])), {
  begin: mock(async (callback: (database: typeof transaction) => Promise<unknown>) => callback(transaction)),
});

let authContext: Record<string, unknown> = {
  role: "project",
  ref: "proj_1",
  principalId: "project:proj_1",
};
const getAuthContext = mock(async () => authContext);

mock.module("../../src/db", () => ({ sql }));
mock.module("../../src/middleware/auth", () => ({ getTransportAuthContextForDelegatedProof: getAuthContext }));

const { config } = await import("../../src/config");
const {
  buildBffProofHeaders,
  resolveTrustedPrincipal,
} = await import("../../src/services/bff-proof.service");

const signingSecret = "test-bff-signing-secret-0123456789abcdef";
const path = "/v1/projects/proj_1/organizations?limit=10";

function signedRequest(body: string, overrides: Record<string, string> = {}): Request {
  const url = new URL(`http://localhost${path}`);
  const headers = buildBffProofHeaders({
    method: "POST",
    pathname: url.pathname,
    search: url.search,
    actorId: "admin-one",
    actorType: "admin",
    requestId: "request-one",
    nonce: "nonce-0123456789abcdef",
    body,
  });
  return new Request(url, {
    method: "POST",
    headers: { ...headers, authorization: "Bearer project-token", ...overrides },
    body,
  });
}

describe("SupaOAuth BFF proof v2", () => {
  beforeEach(() => {
    consumedNonces.clear();
    transaction.mockClear();
    sql.begin.mockClear();
    getAuthContext.mockClear();
    authContext = { role: "project", ref: "proj_1", principalId: "project:proj_1" };
    config.supaoauthBffSigningSecret = signingSecret;
  });

  test("verifies the exact body and caches a principal on the same Request", async () => {
    const request = signedRequest('{"name":"Acme"}');

    const first = await resolveTrustedPrincipal(request, "proj_1");
    const second = await resolveTrustedPrincipal(request, "proj_1");

    expect(first).toMatchObject({ id: "admin-one", type: "admin", platformAdmin: false });
    expect(second).toEqual(first);
    expect(consumedNonces.size).toBe(1);
    expect(sql.begin).toHaveBeenCalledTimes(1);
  });

  test("rejects body tampering and body swaps", async () => {
    const signed = signedRequest('{"name":"Acme"}');
    const tampered = new Request(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: '{"name":"Other"}',
    });
    await expect(resolveTrustedPrincipal(tampered, "proj_1")).rejects.toThrow("valid SupaOAuth BFF proof");

    const first = signedRequest('{"name":"First"}');
    const second = signedRequest('{"name":"Second"}');
    const swapped = new Request(first.url, {
      method: first.method,
      headers: second.headers,
      body: '{"name":"First"}',
    });
    await expect(resolveTrustedPrincipal(swapped, "proj_1")).rejects.toThrow("valid SupaOAuth BFF proof");
    expect(consumedNonces.size).toBe(0);
  });

  test("rejects a replay on a different Request", async () => {
    const first = signedRequest('{"name":"Acme"}');
    const replay = new Request(first.url, {
      method: first.method,
      headers: first.headers,
      body: '{"name":"Acme"}',
    });

    await resolveTrustedPrincipal(first, "proj_1");
    await expect(resolveTrustedPrincipal(replay, "proj_1")).rejects.toThrow("valid SupaOAuth BFF proof");
    expect(sql.begin).toHaveBeenCalledTimes(2);
  });

  test("rejects stale timestamps before consuming the nonce", async () => {
    const body = '{"name":"Acme"}';
    const url = new URL(`http://localhost${path}`);
    const headers = buildBffProofHeaders({
      method: "POST",
      pathname: url.pathname,
      search: url.search,
      actorId: "admin-one",
      actorType: "admin",
      requestId: "request-one",
      timestamp: Math.floor(Date.now() / 1000) - 301,
      nonce: "nonce-stale-0123456789",
      body,
    });
    const request = new Request(url, { method: "POST", headers, body });

    await expect(resolveTrustedPrincipal(request, "proj_1")).rejects.toThrow("valid SupaOAuth BFF proof");
    expect(sql.begin).not.toHaveBeenCalled();
  });

  test("rejects legacy v1 signatures for project delegation", async () => {
    const request = signedRequest('{"name":"Acme"}');
    request.headers.set(
      "x-supaoauth-actor-signature",
      request.headers.get("x-supaoauth-actor-signature")!.replace(/^v2=/, "v1="),
    );

    await expect(resolveTrustedPrincipal(request, "proj_1")).rejects.toThrow("valid SupaOAuth BFF proof");
    expect(sql.begin).not.toHaveBeenCalled();
  });

  test("uses the empty-body digest for GET requests", async () => {
    const url = new URL("http://localhost/v1/projects/proj_1/organizations?limit=10");
    const headers = buildBffProofHeaders({
      method: "GET",
      pathname: url.pathname,
      search: url.search,
      actorId: "admin-one",
      actorType: "admin",
      requestId: "request-get",
      nonce: "nonce-get-0123456789ab",
    });
    const request = new Request(url, { headers });

    await expect(resolveTrustedPrincipal(request, "proj_1")).resolves.toMatchObject({
      id: "admin-one",
      requestId: "request-get",
    });
  });

  test("keeps authorization source outside the cryptographic canonical payload", async () => {
    const request = signedRequest('{"name":"Acme"}', {
      "x-supaoauth-authorization-source": "rbac_projection",
    });
    request.headers.set("x-supaoauth-authorization-source", "changed-after-signing");

    await expect(resolveTrustedPrincipal(request, "proj_1")).resolves.toMatchObject({
      id: "admin-one",
    });
  });

  test("keeps master privileges when no delegation is attempted", async () => {
    authContext = { role: "master", principalId: "master" };
    const request = new Request("http://localhost/v1/projects/proj_1/organizations");

    await expect(resolveTrustedPrincipal(request, "proj_1")).resolves.toMatchObject({
      id: "master",
      type: "master",
      platformAdmin: true,
    });
    expect(sql.begin).not.toHaveBeenCalled();
  });

  test("resolves a signed BFF actor even when the transport uses the master token", async () => {
    authContext = { role: "master", principalId: "master" };
    const request = signedRequest('{"name":"Acme"}');

    await expect(resolveTrustedPrincipal(request, "proj_1")).resolves.toMatchObject({
      id: "admin-one",
      type: "admin",
      platformAdmin: false,
    });
  });

  test("rejects incomplete delegation headers instead of falling back to master", async () => {
    authContext = { role: "master", principalId: "master" };
    const request = new Request("http://localhost/v1/projects/proj_1/organizations", {
      headers: { "x-supaoauth-actor-id": "forged-owner" },
    });

    await expect(resolveTrustedPrincipal(request, "proj_1")).rejects.toThrow(
      "valid SupaOAuth BFF proof",
    );
  });
});
