import assert from "node:assert/strict";
import type { JWTVerifyGetKey } from "jose";
import { createSupAuthRequestContext } from "../../../elysia/src/identity";

// Called only by the opt-in PKCE fixture with a GoTrue-issued access token.
// SupAuth owns the management facade; GoTrue remains the only signing authority.
export async function verifyGatewaySupAuthAccess(input: {
  ref: string; url: string; subject: string; clientId: string; accessToken: string;
  keyResolver: JWTVerifyGetKey; supauthUrl: string; supauthBearer: string; masterToken: string;
  transport?: typeof fetch;
}) {
  const { ref, subject, clientId } = input;
  assert.match(ref, /^[a-z0-9]{10,32}$/);
  assert.equal(input.url, `https://${ref}.api.localhost`);
  const facadeUrl = new URL(input.supauthUrl);
  assert.ok(["http:", "https:"].includes(facadeUrl.protocol)
    && ["127.0.0.1", "[::1]"].includes(facadeUrl.hostname)
    && facadeUrl.pathname === "/" && !facadeUrl.search && !facadeUrl.hash
    && !facadeUrl.username && !facadeUrl.password, "SupAuth acceptance requires a loopback origin");
  assert.ok(input.masterToken && input.supauthBearer);
  const transport = input.transport ?? fetch;
  const issuer = `${input.url}/auth/v1`;
  const marker = `identity-${crypto.randomUUID()}`;
  const permission = `${marker}.read`;
  const managementUrl = `http://127.0.0.1:9090/v1/projects/${ref}`;
  const errors: unknown[] = [];
  let organizationId: string | undefined, roleId: string | undefined;
  let organizationAttempted = false, roleAttempted = false;

  async function call(facade: boolean, method: string, path: string, body?: unknown, absent = false) {
    const response = await transport(`${facade ? facadeUrl.origin : managementUrl}${path}`, {
      method, redirect: "error",
      headers: {
        authorization: `Bearer ${facade ? input.supauthBearer : input.masterToken}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // Revocation synchronizes unavailable and final GoTrue projections before
      // returning. A read-sized deadline can expire after the write committed.
      signal: AbortSignal.timeout(method === "GET" ? 15_000 : 60_000),
    });
    if (absent && response.status === 404) return null;
    // Do not include response bodies, credentials or user metadata in failures.
    assert.ok(response.ok, `Identity acceptance ${method} failed (${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) as unknown : null;
  }
  const record = (value: unknown): Record<string, unknown> => {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), "Invalid identity response");
    return value as Record<string, unknown>;
  };
  const items = (value: unknown) => {
    const rows = record(value).items;
    assert.ok(Array.isArray(rows), "Invalid identity inventory");
    return rows.map(record);
  };
  const uuid = (value: unknown) => {
    const candidate = record(value).id;
    assert.ok(typeof candidate === "string" && /^[a-f0-9-]{36}$/i.test(candidate), "Invalid identity resource ID");
    return candidate;
  };
  const resourceId = (value: unknown, prefix: string) => {
    const candidate = record(value).id;
    assert.ok(typeof candidate === "string" && candidate.startsWith(`${prefix}_`), "Invalid identity resource ID");
    return candidate;
  };
  const denied = (error: unknown) => error !== null && typeof error === "object"
    && "status" in error && error.status === 403 && "code" in error && error.code === "APPLICATION_ACCESS_DENIED";

  // Fail before mutations if the facade is routed to another project or issuer.
  const project = record(await call(false, "GET", ""));
  assert.equal(project.ref, ref);
  assert.ok(typeof project.name === "string" && project.name.startsWith("platform-app-acceptance-"));
  const health = record(await call(true, "GET", "/v1/health"));
  assert.equal(health.project_ref, ref);
  assert.equal(health.runtime_mode, "gotrue");
  const discovery = record(await call(true, "GET", "/v1/runtime/discovery"));
  assert.equal(discovery.issuer, issuer);
  assert.equal(discovery.jwks_uri, `${issuer}/.well-known/jwks.json`);

  try {
    organizationAttempted = true;
    organizationId = uuid(await call(true, "POST", "/v1/organizations", { name: marker, slug: marker }));
    const persistedOrg = record(await call(false, "GET", `/organizations/${organizationId}`));
    assert.equal(persistedOrg.project_ref, ref);
    assert.equal(persistedOrg.name, marker);
    roleAttempted = true;
    roleId = resourceId(await call(true, "POST", "/v1/roles", { name: marker }), "role");
    assert.equal(record(await call(false, "GET", `/rbac/roles/${roleId}`)).name, marker);
    await call(true, "POST", `/v1/roles/${roleId}/permissions`, { name: permission });

    const resolveAccess = async (identity: { subject: string }) => {
      // Membership is read from the canonical store used by SupAuth's adapter.
      const memberships = items(await call(false, "GET",
        `/auth/users/${encodeURIComponent(identity.subject)}/organizations`));
      if (!memberships.some(entry => entry.id === organizationId && entry.project_ref === ref)) return null;
      const query = `?org_id=${encodeURIComponent(organizationId!)}`;
      const access = record(await call(true, "GET",
        `/v1/users/${encodeURIComponent(identity.subject)}/permissions${query}`));
      assert.ok(Array.isArray(access.permissions) && access.permissions.every(value => typeof value === "string"),
        "Invalid SupAuth permission response");
      const canonical = record(await call(false, "GET",
        `/auth/users/${encodeURIComponent(identity.subject)}/permissions${query}`));
      assert.deepEqual(access.permissions, canonical.permissions, "SupAuth resolver differs from canonical RBAC");
      return { projectId: ref, tenantId: organizationId!, permissions: access.permissions as string[] };
    };
    const context = createSupAuthRequestContext({
      issuer, audience: "authenticated", clientId, projectId: ref,
      jwksUrl: `${issuer}/.well-known/jwks.json`, keyResolver: input.keyResolver, resolveAccess,
    });
    const request = () => new Request(`${input.url}/application`, {
      headers: { authorization: `Bearer ${input.accessToken}`, "x-tenant-id": "forged", "x-user-id": "forged" },
    });
    await assert.rejects(context(request()), denied);
    await call(true, "POST", `/v1/organizations/${organizationId}/members`, { user_id: subject, role: "member" });
    const assignmentId = resourceId(await call(true, "POST", `/v1/roles/${roleId}/assign`, {
      user_id: subject, organization_id: organizationId,
    }), "assign");
    const granted = await context(request());
    assert.equal(granted.identity.subject, subject);
    assert.equal(granted.identity.issuer, issuer);
    assert.equal(granted.identity.clientId, clientId);
    assert.equal(granted.access.tenantId, organizationId);
    assert.ok(granted.access.permissions.includes(permission));
    assert.ok(!JSON.stringify(granted).includes(input.accessToken), "Context serialized a credential");

    await call(true, "DELETE", `/v1/roles/${roleId}/assign/${assignmentId}`);
    const revoked = await context(request());
    assert.ok(!revoked.access.permissions.includes(permission), "Revoked permission survived resolver readback");
    // Revoking a role removes permissions, not membership. Removing membership denies access.
    await call(true, "DELETE", `/v1/organizations/${organizationId}/members/${encodeURIComponent(subject)}`);
    await assert.rejects(context(request()), denied);
    const after = record(await call(true, "GET", "/v1/runtime/discovery"));
    assert.equal(after.issuer, issuer);
    assert.equal(after.jwks_uri, discovery.jwks_uri);
  } catch (error) {
    errors.push(error);
  } finally {
    // Discover lost create receipts by this run's exact unique name. Cleanup
    // uses the canonical API even if the SupAuth facade has become unavailable.
    const cleanup = async (action: () => Promise<void>) => {
      try { await action(); } catch (error) { errors.push(error); }
    };
    await cleanup(async () => {
      if (!roleAttempted) return;
      if (!roleId) {
        const found = items(await call(false, "GET", "/rbac/roles")).filter(entry => entry.name === marker);
        assert.ok(found.length <= 1, "Ambiguous acceptance role cleanup");
        if (found[0]) roleId = resourceId(found[0], "role");
      }
      if (roleId) {
        await call(false, "DELETE", `/rbac/roles/${roleId}`, undefined, true);
        assert.equal(await call(false, "GET", `/rbac/roles/${roleId}`, undefined, true), null);
      }
    });
    await cleanup(async () => {
      if (!organizationAttempted) return;
      if (!organizationId) {
        const found = items(await call(false, "GET", `/organizations?search=${marker}&limit=100`))
          .filter(entry => entry.name === marker && entry.slug === marker);
        assert.ok(found.length <= 1, "Ambiguous acceptance organization cleanup");
        if (found[0]) organizationId = uuid(found[0]);
      }
      if (organizationId) {
        await call(false, "DELETE", `/organizations/${organizationId}/members/${encodeURIComponent(subject)}`, undefined, true);
        await call(false, "DELETE", `/organizations/${organizationId}`, undefined, true);
        assert.equal(await call(false, "GET", `/organizations/${organizationId}`, undefined, true), null);
      }
    });
  }
  if (errors.length) throw new AggregateError(errors, "SupAuth identity acceptance failed");
  return {
    supAuthLiveMembershipRbac: true, supAuthLiveRoleRevocation: true,
    supAuthLiveMembershipRevocation: true, supAuthGoTrueAuthorityPreserved: true, supAuthAccessCleanup: true,
  };
}
