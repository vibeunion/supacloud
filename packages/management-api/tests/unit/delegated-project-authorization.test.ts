import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const collaboratorRoles = new Map<string, "owner" | "admin" | "member" | "viewer">();
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

const sql = Object.assign(
  mock((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("SELECT role FROM project_collaborators")) {
      const role = collaboratorRoles.get(String(values[1]));
      return Promise.resolve(role ? [{ role }] : []);
    }
    return Promise.resolve([]);
  }),
  { begin: mock((callback: (database: typeof transaction) => Promise<unknown>) => callback(transaction)) },
);

mock.module("../../src/db", () => ({
  sql,
  getProjectDb: mock(() => sql),
  resolveDbName: mock((ref: string) => Promise.resolve(ref)),
}));

const { config } = await import("../../src/config");
const { buildBffProofHeaders } = await import("../../src/services/bff-proof.service");
const {
  delegatedProjectCapability,
  requireProjectOrAdminAuth,
} = await import("../../src/middleware/auth");

const originalMasterToken = config.masterToken;
const originalSigningSecret = config.supaoauthBffSigningSecret;
let nonceSequence = 0;

function delegatedRequest(
  path: string,
  method: string,
  actorId: string,
  actorType = "admin",
): Request {
  const body = ["GET", "HEAD"].includes(method) ? undefined : "{}";
  const url = new URL(`http://localhost${path}`);
  nonceSequence += 1;
  const proofHeaders = buildBffProofHeaders({
    method,
    pathname: url.pathname,
    search: url.search,
    actorId,
    actorType,
    requestId: `request-${nonceSequence}`,
    nonce: `nonce-${String(nonceSequence).padStart(16, "0")}`,
    body,
  });
  return new Request(url, {
    method,
    headers: { ...proofHeaders, authorization: "Bearer master-token" },
    body,
  });
}

describe("delegated project authorization", () => {
  afterAll(() => {
    config.masterToken = originalMasterToken;
    config.supaoauthBffSigningSecret = originalSigningSecret;
  });

  beforeEach(() => {
    collaboratorRoles.clear();
    consumedNonces.clear();
    nonceSequence = 0;
    config.masterToken = "master-token";
    config.supaoauthBffSigningSecret = "delegated-auth-test-secret-0123456789";
  });

  test("rejects a valid delegated proof from a non-collaborator", async () => {
    const denied = await requireProjectOrAdminAuth(
      delegatedRequest("/v1/projects/proj_1/auth/users", "GET", "outsider"),
      "proj_1",
    );
    expect(denied).toEqual({
      status: 403,
      body: { error: "The current principal is not an active project collaborator" },
    });
  });

  test("maps every supported delegated control-plane family to an explicit capability", () => {
    const cases = [
      ["GET", "/auth/oauth-clients", "applications.read"],
      ["POST", "/auth/users", "users.manage"],
      ["GET", "/rbac/roles", "roles.read"],
      ["PATCH", "/auth/providers/github", "connectors.manage"],
      ["POST", "/auth/custom-providers", "connectors.manage"],
      ["GET", "/auth/hooks", "security.read"],
      ["POST", "/organizations", "organizations.manage"],
      ["POST", "/webhooks/one/replay", "webhooks.replay"],
      ["GET", "/audit", "audit.read"],
      ["GET", "/audit/log-one?include_sensitive=true", "audit.read_sensitive"],
      ["GET", "/audit/exports/export-one/download", "audit.export"],
      ["POST", "/audit/events", "audit.write"],
      ["GET", "/collaborators", "tenant.members.read"],
      ["PATCH", "/settings", "tenant.config.manage"],
      ["GET", "/capabilities", "tenant.capabilities.read"],
      ["PUT", "/domains/example.test", "tenant.domains.manage"],
      ["GET", "/cache", "operations.read"],
      ["POST", "/cache/operations", "operations.manage"],
      ["GET", "/tasks", "operations.read"],
      ["POST", "/pipelines", "operations.manage"],
      ["POST", "/database/migrations", "database.migrations.manage"],
      ["GET", "", "project.read"],
    ] as const;

    for (const [method, suffix, expectedCapability] of cases) {
      const request = new Request(`http://localhost/v1/projects/proj_1${suffix}`, { method });
      expect(delegatedProjectCapability(request, "proj_1")).toBe(expectedCapability);
    }
  });

  test("keeps viewer reads minimal and rejects mutations", async () => {
    collaboratorRoles.set("viewer-one", "viewer");
    await expect(requireProjectOrAdminAuth(
      delegatedRequest("/v1/projects/proj_1/organizations", "GET", "viewer-one"),
      "proj_1",
    )).resolves.toBeUndefined();

    const userRead = await requireProjectOrAdminAuth(
      delegatedRequest("/v1/projects/proj_1/auth/users", "GET", "viewer-one"),
      "proj_1",
    );
    expect(userRead?.body.error).toContain("users.read");

    const organizationWrite = await requireProjectOrAdminAuth(
      delegatedRequest("/v1/projects/proj_1/organizations", "POST", "viewer-one"),
      "proj_1",
    );
    expect(organizationWrite?.body.error).toContain("organizations.manage");
  });

  test("allows owner and admin reads and writes across new capability families", async () => {
    collaboratorRoles.set("owner-one", "owner");
    collaboratorRoles.set("admin-one", "admin");

    await expect(requireProjectOrAdminAuth(
      delegatedRequest("/v1/projects/proj_1/auth/users", "GET", "owner-one"),
      "proj_1",
    )).resolves.toBeUndefined();
    await expect(requireProjectOrAdminAuth(
      delegatedRequest("/v1/projects/proj_1/auth/oauth-clients", "POST", "admin-one"),
      "proj_1",
    )).resolves.toBeUndefined();
  });

  test("fails closed for an unknown delegated project path", async () => {
    collaboratorRoles.set("owner-one", "owner");
    const denied = await requireProjectOrAdminAuth(
      delegatedRequest("/v1/projects/proj_1/unknown-control", "GET", "owner-one"),
      "proj_1",
    );
    expect(denied).toEqual({
      status: 403,
      body: { error: "Delegated access is unavailable for this project route" },
    });
  });

  test("does not change direct master authorization without delegation", async () => {
    const request = new Request("http://localhost/v1/projects/proj_1/auth/users", {
      headers: { authorization: "Bearer master-token" },
    });
    await expect(requireProjectOrAdminAuth(request, "proj_1")).resolves.toBeUndefined();
  });
});
