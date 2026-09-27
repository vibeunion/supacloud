import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createLocalJWKSet, jwtVerify } from "jose";
import { createSupAuthRequestContext } from "../../../elysia/src/identity";
import { verifyGatewaySupAuthAccess } from "./platform-supauth-access";

export async function verifyGatewayOAuthPkce(input: {
  ref: string; url: string; subject: string; client: SupabaseClient; transport: typeof fetch;
}) {
  assert.ok(process.env.MASTER_TOKEN);
  const { ref, url, subject, client, transport } = input;
  const issuer = `${url}/auth/v1`;
  const name = `gateway-pkce-${crypto.randomUUID()}`;
  const callback = "https://acceptance.example.com/callback";
  const management = (method: string, suffix = "", body?: unknown) =>
    fetch(`http://127.0.0.1:9090/v1/projects/${ref}/auth/oauth-clients${suffix}`, {
      method, headers: {
        authorization: `Bearer ${process.env.MASTER_TOKEN}`, "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  let clientId: string | undefined;
  let accessEvidence: Record<string, boolean> = {};
  try {
    const created = await management("POST", "", {
      client_name: name, client_type: "public", token_endpoint_auth_method: "none",
      redirect_uris: [callback], grant_types: ["authorization_code", "refresh_token"],
    });
    assert.ok(created.ok, `OAuth client creation failed (${created.status})`);
    clientId = (await created.json()).client_id;
    assert.ok(clientId);
    const verifier = randomBytes(32).toString("base64url");
    const state = crypto.randomUUID(), nonce = crypto.randomUUID();
    const authorizeCode = async (codeVerifier: string, expectedState: string, expectedNonce: string) => {
      const authorize = new URL(`${issuer}/oauth/authorize`);
      authorize.search = new URLSearchParams({
        client_id: clientId!, redirect_uri: callback, response_type: "code",
        scope: "openid email profile", state: expectedState, nonce: expectedNonce,
        code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      const authorization = await transport(authorize, { redirect: "manual" });
      assert.equal(authorization.status, 302);
      const location = authorization.headers.get("location");
      assert.ok(location);
      const authorizationId = new URL(location).searchParams.get("authorization_id");
      assert.ok(authorizationId, "authorization did not redirect to consent");
      const details = await client.auth.oauth.getAuthorizationDetails(authorizationId);
      assert.ok(!details.error, "OAuth authorization details unavailable");
      assert.ok(details.data);
      let redirectUrl: string;
      if ("redirect_url" in details.data) {
        redirectUrl = details.data.redirect_url;
      } else {
        assert.equal(details.data.client.id, clientId);
        assert.equal(details.data.user.id, subject);
        const consent = await client.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true });
        assert.ok(!consent.error && consent.data?.redirect_url, "OAuth consent failed");
        redirectUrl = consent.data.redirect_url;
      }
      const redirect = new URL(redirectUrl);
      assert.equal(`${redirect.origin}${redirect.pathname}`, callback);
      assert.equal(redirect.searchParams.get("state"), expectedState);
      const code = redirect.searchParams.get("code");
      assert.ok(code);
      return code;
    };
    const code = await authorizeCode(verifier, state, nonce);
    const exchange = (authorizationCode: string, codeVerifier?: string) => transport(`${issuer}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: clientId!, code: authorizationCode,
        redirect_uri: callback,
        ...(codeVerifier === undefined ? {} : { code_verifier: codeVerifier }),
      }),
    });
    const exchanged = await exchange(code, verifier);
    assert.equal(exchanged.status, 200, "PKCE token exchange failed");
    const tokens = await exchanged.json();
    assert.ok(typeof tokens.access_token === "string" && typeof tokens.id_token === "string");
    const keyResponse = await transport(`${issuer}/.well-known/jwks.json`);
    assert.equal(keyResponse.status, 200);
    const resolver = createLocalJWKSet(await keyResponse.json());
    const identity = await jwtVerify(tokens.id_token, resolver, {
      issuer, audience: clientId, algorithms: ["ES256", "RS256"], requiredClaims: ["sub", "iat", "exp", "nonce"],
    });
    assert.equal(identity.payload.sub, subject);
    assert.equal(identity.payload.nonce, nonce);
    const contextOptions = {
      issuer, audience: "authenticated", clientId, projectId: ref,
      jwksUrl: `${issuer}/.well-known/jwks.json`, keyResolver: resolver,
      resolveAccess: async () => ({ projectId: ref, tenantId: "acceptance", permissions: [] }),
    };
    const request = new Request(`${url}/application`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const context = await createSupAuthRequestContext(contextOptions)(request);
    assert.equal(context.identity.subject, subject);
    assert.equal(context.identity.clientId, clientId);
    if (process.env.SUPACLOUD_SUPAUTH_RBAC_TEST === "1") {
      assert.ok(process.env.SUPACLOUD_TEST_SUPAUTH_URL, "Live SupAuth URL required");
      assert.ok(process.env.SUPACLOUD_TEST_SUPAUTH_BEARER, "Live SupAuth admin session or SSO bearer required");
      accessEvidence = await verifyGatewaySupAuthAccess({
        ref, url, subject, clientId, accessToken: tokens.access_token, keyResolver: resolver,
        supauthUrl: process.env.SUPACLOUD_TEST_SUPAUTH_URL,
        supauthBearer: process.env.SUPACLOUD_TEST_SUPAUTH_BEARER,
        masterToken: process.env.MASTER_TOKEN,
      });
    }
    await assert.rejects(createSupAuthRequestContext({
      ...contextOptions, clientId: crypto.randomUUID(),
    })(request), (error: unknown) => !!error && typeof error === "object" && "status" in error && error.status === 401);
    const wrongVerifier = randomBytes(32).toString("base64url");
    const wrongCode = await authorizeCode(wrongVerifier, crypto.randomUUID(), crypto.randomUUID());
    const wrongExchange = await exchange(wrongCode, randomBytes(32).toString("base64url"));
    assert.equal(wrongExchange.status, 400, "Wrong PKCE verifier was accepted");
    assert.equal((await wrongExchange.json()).error, "invalid_grant");
    const missingCode = await authorizeCode(randomBytes(32).toString("base64url"), crypto.randomUUID(), crypto.randomUUID());
    const missingVerifier = await exchange(missingCode);
    assert.equal(missingVerifier.status, 400, "Missing PKCE verifier was accepted");
    assert.equal((await missingVerifier.json()).error, "invalid_grant");
    const replay = await exchange(code, verifier);
    assert.equal(replay.status, 400, "authorization code was reusable");
    return {
      oauthPkce: true, oauthPkceWrongVerifier: true, oauthPkceMissingVerifier: true,
      oauthIdToken: true, supAuthApplicationIdentity: true, oauthCodeSingleUse: true, ...accessEvidence,
    };
  } finally {
    // A lost create response still requires discovering and removing this test client.
    if (!clientId) {
      const listed = await management("GET");
      assert.equal(listed.status, 200, "OAuth cleanup lookup failed");
      const payload = await listed.json();
      const clients = Array.isArray(payload) ? payload : payload.clients;
      assert.ok(Array.isArray(clients));
      clientId = clients.find((entry) => entry.client_name === name)?.client_id;
    }
    if (clientId) {
      const removed = await management("DELETE", `/${clientId}`);
      assert.ok(removed.ok || removed.status === 404, "OAuth client cleanup failed");
      const readback = await management("GET", `/${clientId}`);
      assert.equal(readback.status, 404, "OAuth client still exists after cleanup");
    }
  }
}
