import { expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifyGatewaySupAuthAccess } from "../fixtures/platform-supauth-access";

// These are deterministic fixture tests, not live GoTrue/SupAuth acceptance.
async function fixture(mode = "") {
  const ref = "acceptanceproject", subject = crypto.randomUUID(), clientId = crypto.randomUUID();
  const url = `https://${ref}.api.localhost`, issuer = `${url}/auth/v1`;
  const keys = await generateKeyPair("ES256");
  const keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "test", alg: "ES256" }] });
  const accessToken = await new SignJWT({ role: "authenticated", client_id: clientId })
    .setProtectedHeader({ alg: "ES256", kid: "test" }).setIssuer(issuer).setAudience("authenticated")
    .setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
  let org: { id: string; project_ref: string; name: string; slug: string } | null = null;
  let role: { id: string; name: string } | null = null;
  let member = false, assigned = false, permission = "";
  const assignmentId = crypto.randomUUID();
  const calls: string[] = [];
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), target = new URL(request.url);
    const facade = target.port === "3999", method = request.method;
    const path = facade ? target.pathname : target.pathname.replace(`/v1/projects/${ref}`, "");
    calls.push(`${facade ? "facade" : "canonical"} ${method} ${path}`);
    expect(request.headers.get("authorization")).toBe(`Bearer ${facade ? "facade-credential" : "management-credential"}`);
    expect(request.redirect).toBe("error");
    expect(request.headers.get("authorization")).not.toContain(accessToken);
    const body = method === "POST" ? await request.json() : undefined;
    if (!facade && !path) return json({ ref, name: "platform-app-acceptance-unit" });
    if (path === "/v1/health") return json({ project_ref: mode === "foreign" ? "foreign" : ref, runtime_mode: "gotrue" });
    if (path === "/v1/runtime/discovery") return json({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json` });
    if (path === "/v1/organizations" && method === "POST") {
      org = { id: crypto.randomUUID(), project_ref: ref, name: body.name, slug: body.slug };
      if (mode === "lost-org") throw new Error("lost create receipt");
      return json(org);
    }
    if (path === "/v1/roles" && method === "POST") {
      role = { id: `role_${crypto.randomUUID()}`, name: body.name };
      if (mode === "lost-role") throw new Error("lost create receipt");
      return json(role);
    }
    if (!facade && path === "/organizations") return json({ items: org ? [org] : [] });
    if (!facade && path === "/rbac/roles") return json({ items: role ? [role] : [] });
    if (path.endsWith("/organizations") && path.includes(`/auth/users/${subject}/`)) {
      return json({ items: member && org ? [org] : [] });
    }
    if (path === `/organizations/${org?.id}` || (!facade && path.startsWith("/organizations/") && !path.includes("/members/"))) {
      if (method === "DELETE") { expect(member).toBe(false); org = null; return json({ deleted: true }); }
      return org ? json(org) : json({}, 404);
    }
    if (path === `/rbac/roles/${role?.id}` || (!facade && path.startsWith("/rbac/roles/"))) {
      if (method === "DELETE") {
        if (mode === "cleanup-error") return json({}, 503);
        role = null; assigned = false; return json({ deleted: true });
      }
      return role ? json(role) : json({}, 404);
    }
    if (path === `/v1/roles/${role?.id}/permissions`) { permission = body.name; return json({ id: crypto.randomUUID() }); }
    if (path.includes("/members")) {
      if (method === "POST") { expect(body.user_id).toBe(subject); member = true; return json({ id: crypto.randomUUID() }); }
      expect(path.endsWith(subject)).toBe(true);
      const existed = member; member = false;
      return json({ deleted: existed }, existed ? 200 : 404);
    }
    if (path === `/v1/roles/${role?.id}/assign`) {
      expect(body).toEqual({ user_id: subject, organization_id: org?.id });
      assigned = true;
      return json({ id: `assign_${assignmentId}` });
    }
    if (path.endsWith(`/assign/assign_${assignmentId}`) && method === "DELETE") {
      assigned = false; return new Response(null, { status: 204 });
    }
    if (path.endsWith("/permissions")) {
      expect(path.includes(subject)).toBe(true);
      expect(target.searchParams.get("org_id")).toBe(org?.id ?? null);
      if (mode === "resolver-down" && facade) return json({}, 503);
      return json({ permissions: assigned || (mode === "stale" && facade) ? [permission] : [], roles: [] });
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  }) as typeof fetch;
  return {
    run: () => verifyGatewaySupAuthAccess({
      ref, url, subject, clientId, accessToken, keyResolver,
      supauthUrl: "http://127.0.0.1:3999", supauthBearer: "facade-credential",
      masterToken: "management-credential", transport,
    }),
    calls,
    remaining: () => ({ org, role, member, assigned }),
  };
}

test("fixture exercises signed identity, live resolver requests and separate role/membership revocation", async () => {
  const f = await fixture();
  expect(await f.run()).toEqual({
    supAuthLiveMembershipRbac: true, supAuthLiveRoleRevocation: true,
    supAuthLiveMembershipRevocation: true, supAuthGoTrueAuthorityPreserved: true, supAuthAccessCleanup: true,
  });
  expect(f.remaining()).toEqual({ org: null, role: null, member: false, assigned: false });
  expect(f.calls.filter(call => call.startsWith("facade GET /v1/users/")).length).toBe(2);
});

test("foreign SupAuth target fails before mutations", async () => {
  const f = await fixture("foreign");
  await expect(f.run()).rejects.toThrow();
  expect(f.calls.some(call => call.includes(" POST ") || call.includes(" DELETE "))).toBe(false);
});

test("stale or unavailable resolver cannot produce acceptance evidence and still cleans resources", async () => {
  for (const mode of ["stale", "resolver-down"]) {
    const f = await fixture(mode);
    await expect(f.run()).rejects.toThrow("SupAuth identity acceptance failed");
    expect(f.remaining()).toEqual({ org: null, role: null, member: false, assigned: false });
  }
});

test("lost create receipts are discovered by exact generated names for cleanup", async () => {
  for (const mode of ["lost-org", "lost-role"]) {
    const f = await fixture(mode);
    await expect(f.run()).rejects.toThrow("SupAuth identity acceptance failed");
    expect(f.remaining()).toEqual({ org: null, role: null, member: false, assigned: false });
  }
});

test("role cleanup failure does not skip organization cleanup or report success", async () => {
  const f = await fixture("cleanup-error");
  await expect(f.run()).rejects.toThrow("SupAuth identity acceptance failed");
  expect(f.remaining().org).toBeNull();
  expect(f.remaining().member).toBe(false);
  expect(f.remaining().role).not.toBeNull();
});
