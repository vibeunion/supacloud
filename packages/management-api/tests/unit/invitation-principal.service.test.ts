import { beforeEach, describe, expect, mock, test } from "bun:test";

let verifiedPayload: Record<string, unknown> | null;
const verifyProjectJwtPayload = mock(async () => (
  verifiedPayload ? { payload: verifiedPayload } : null
));
const authorityDb = mock(() => Promise.resolve([{
  id: "gotrue-user",
  email: "user@example.test",
}]));

mock.module("../../src/utils/project-jwt", () => ({ verifyProjectJwtPayload }));
mock.module("../../src/services/auth-runtime.service", () => ({
  getAuthRuntimeDescriptor: () => ({ authority_project_ref: "auth-owner" }),
}));
mock.module("../../src/db", () => ({
  getProjectDb: () => authorityDb,
  resolveDbName: async () => "supa_auth_owner",
}));

const { resolveInvitationPrincipal } = await import("../../src/services/invitation-principal.service");
const { verifiedAuditPrincipal } = await import("../../src/services/request-audit-principal.service");

function request(token?: string) {
  return new Request("http://localhost/v1/projects/proj_1/organizations/org/invitations/invite/accept", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("organization invitation GoTrue principal", () => {
  beforeEach(() => {
    verifiedPayload = {
      sub: "gotrue-user",
      role: "authenticated",
    };
    verifyProjectJwtPayload.mockClear();
    authorityDb.mockClear();
  });

  test("accepts only a live authenticated GoTrue subject", async () => {
    const invitationRequest = request("gotrue-access-token");
    await expect(resolveInvitationPrincipal(invitationRequest, "proj_1")).resolves.toEqual({
      id: "gotrue-user",
      email: "user@example.test",
    });
    expect(verifyProjectJwtPayload).toHaveBeenCalledWith("proj_1", "gotrue-access-token");
    expect(verifiedAuditPrincipal(invitationRequest)).toEqual({ id: "gotrue-user", type: "user" });
  });

  test("rejects a master or service-role bearer as an invitation principal", async () => {
    verifiedPayload = { sub: "service", role: "service_role" };

    await expect(resolveInvitationPrincipal(request("master-token"), "proj_1"))
      .rejects.toThrow("authenticated GoTrue user");
    expect(authorityDb).not.toHaveBeenCalled();
  });

  test("rejects missing bearer authorization", async () => {
    await expect(resolveInvitationPrincipal(request(), "proj_1"))
      .rejects.toThrow("GoTrue user access token");
  });
});
