import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const authModule = await import("../../src/middleware/auth");
const dbModule = await import("../../src/db");
const invitationPrincipalModule = await import("../../src/services/invitation-principal.service");
const serviceModule = await import("../../src/services/project-collaborator.service");

const requireAuth = spyOn(authModule, "requireProjectOrAdminAuth").mockResolvedValue(undefined);
const authContext = spyOn(authModule, "getTransportAuthContextForDelegatedProof").mockResolvedValue({
  role: "admin",
  source: "bearer",
  principalId: "admin-one",
});
const nonceTransaction = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join("?");
  return Promise.resolve(query.includes("INSERT INTO supaoauth_bff_proof_nonces")
    ? [{ nonce: values[0] }]
    : []);
});
const nonceBegin = spyOn(dbModule.sql, "begin").mockImplementation(
  async (callback: (database: typeof nonceTransaction) => Promise<unknown>) => callback(nonceTransaction),
);
const invitationPrincipal = spyOn(
  invitationPrincipalModule,
  "resolveInvitationPrincipal",
).mockResolvedValue({ id: "gotrue-user", email: "new@example.test" });
const list = spyOn(serviceModule.projectCollaboratorService, "list").mockResolvedValue({
  items: [],
  total: 0,
  scope: "project",
} as never);
const invite = spyOn(serviceModule.projectCollaboratorService, "invite").mockResolvedValue({
  id: "invite-one",
  token: "one-time",
  scope: "project",
} as never);
const update = spyOn(serviceModule.projectCollaboratorService, "update").mockResolvedValue({
  id: "collab-one",
  role: "admin",
  capabilities: ["tenant.members.manage"],
} as never);
const accept = spyOn(serviceModule.projectCollaboratorService, "accept").mockResolvedValue({
  id: "collab-one",
  role: "member",
} as never);

const { buildBffProofHeaders } = await import("../../src/services/bff-proof.service");
const { bffProofBodyCapture } = await import("../../src/middleware/bff-proof-body");
const { projectCollaboratorRoutes } = await import("../../src/routes/project-collaborators");
const app = new Elysia().use(bffProofBodyCapture).use(projectCollaboratorRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: "Bearer management-token",
      "content-type": "application/json",
      "x-request-id": "req-admin",
      ...(init.headers || {}),
    },
  }));
}

describe("project collaborator route authorization", () => {
  afterAll(() => {
    requireAuth.mockRestore();
    authContext.mockRestore();
    nonceBegin.mockRestore();
    invitationPrincipal.mockRestore();
    list.mockRestore();
    invite.mockRestore();
    update.mockRestore();
    accept.mockRestore();
  });

  beforeEach(() => {
    requireAuth.mockReset();
    requireAuth.mockResolvedValue(undefined);
    authContext.mockReset();
    authContext.mockResolvedValue({ role: "admin", source: "bearer", principalId: "admin-one" });
    nonceBegin.mockClear();
    invitationPrincipal.mockReset();
    invitationPrincipal.mockResolvedValue({ id: "gotrue-user", email: "new@example.test" });
    list.mockClear();
    invite.mockClear();
    update.mockClear();
    accept.mockClear();
  });

  test("rejects forged delegated headers instead of using platform privileges", async () => {
    const response = await request("/v1/projects/proj_1/collaborators", {
      headers: {
        "x-supaoauth-actor-id": "forged-owner",
        "x-supaoauth-actor-type": "owner",
      },
    });
    expect(response.status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  test("uses platform privileges only when no delegation is attempted", async () => {
    const response = await request("/v1/projects/proj_1/collaborators");

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith("proj_1", {
      id: "admin-one",
      type: "admin",
      requestId: "req-admin",
      platformAdmin: true,
    });
  });

  test("accepts a valid delegated BFF proof from a project-scoped token", async () => {
    authContext.mockResolvedValueOnce({
      role: "project",
      ref: "proj_1",
      principalId: "project:proj_1",
    });
    const body = JSON.stringify({ email: "new@example.test", role: "member" });
    const proofHeaders = buildBffProofHeaders({
      method: "POST",
      pathname: "/v1/projects/proj_1/collaborator-invitations",
      actorId: "collaborator-admin",
      actorType: "user",
      requestId: "req-delegated",
      body,
    });
    const response = await request("/v1/projects/proj_1/collaborator-invitations", {
      method: "POST",
      headers: proofHeaders,
      body,
    });
    expect(response.status).toBe(201);
    expect(invite).toHaveBeenCalledWith(
      "proj_1",
      expect.objectContaining({ email: "new@example.test" }),
      {
        id: "collaborator-admin",
        type: "user",
        requestId: "req-delegated",
        platformAdmin: false,
      },
    );
  });

  test("rejects a project-scoped token without a delegated BFF proof", async () => {
    authContext.mockResolvedValueOnce({
      role: "project",
      ref: "proj_1",
      principalId: "project:proj_1",
    });
    const response = await request("/v1/projects/proj_1/collaborator-invitations", {
      method: "POST",
      body: JSON.stringify({ email: "new@example.test", role: "member" }),
    });
    expect(response.status).toBe(403);
    expect(invite).not.toHaveBeenCalled();
  });

  test("rejects an unversioned BFF signature", async () => {
    authContext.mockResolvedValueOnce({
      role: "project",
      ref: "proj_1",
      principalId: "project:proj_1",
    });
    const body = JSON.stringify({ email: "new@example.test", role: "member" });
    const proofHeaders = buildBffProofHeaders({
      method: "POST",
      pathname: "/v1/projects/proj_1/collaborator-invitations",
      actorId: "collaborator-admin",
      actorType: "user",
      requestId: "req-unversioned",
      body,
    });
    proofHeaders["x-supaoauth-actor-signature"] = proofHeaders[
      "x-supaoauth-actor-signature"
    ].slice(3);
    const response = await request("/v1/projects/proj_1/collaborator-invitations", {
      method: "POST",
      headers: proofHeaders,
      body,
    });
    expect(response.status).toBe(403);
    expect(invite).not.toHaveBeenCalled();
  });

  test("accepts invitations only through the resolved GoTrue principal", async () => {
    const response = await request(
      "/v1/projects/proj_1/collaborator-invitations/invite-one/accept",
      {
        method: "POST",
        headers: { authorization: "Bearer gotrue-user-token" },
        body: JSON.stringify({ token: "one-time" }),
      },
    );
    expect(response.status).toBe(200);
    expect(requireAuth).not.toHaveBeenCalled();
    expect(invitationPrincipal).toHaveBeenCalledWith(expect.any(Request), "proj_1");
    expect(accept).toHaveBeenCalledWith({
      ref: "proj_1",
      invitationId: "invite-one",
      token: "one-time",
      principal: { id: "gotrue-user", email: "new@example.test" },
    });
  });

  test("keeps server-computed role capabilities in update responses", async () => {
    const response = await request("/v1/projects/proj_1/collaborators/collab-one", {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" }),
    });
    expect(await response.json()).toMatchObject({ capabilities: ["tenant.members.manage"] });
  });
});
