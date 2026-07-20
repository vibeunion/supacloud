import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TrustedPrincipal } from "../../src/services/bff-proof.service";

let ownerCount = 1;
let actorRole: "owner" | "admin" | "member" | "viewer" | null = null;
let updatedRows: Array<Record<string, unknown>> = [];
let acceptedCollaboratorInsert = "";
let acceptedExistingRole: "owner" | "admin" | "member" | "viewer" | null = "owner";
let acceptedExistingStatus: "active" | "suspended" | null = "active";
let gotrueUserExists = true;
let resolvedAuthorityRefs: string[] = [];

const platformAdmin: TrustedPrincipal = {
  id: "platform-admin",
  type: "admin",
  requestId: "req-admin",
  platformAdmin: true,
};

const delegatedActor: TrustedPrincipal = {
  id: "delegated-user",
  type: "user",
  requestId: "req-delegated",
  platformAdmin: false,
};

const txMock = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join("?");
  if (text.includes("SELECT pg_advisory_xact_lock")) return Promise.resolve([]);
  if (text.includes("FROM project_collaborator_invitations") && text.includes("FOR UPDATE")) {
    return Promise.resolve([{
      id: "invite-one",
      email: "owner@example.test",
      role: "member",
      status: "pending",
      token_hash: createHash("sha256").update("valid-token").digest("hex"),
      invited_by: "platform-admin",
      expires_at: new Date(Date.now() + 60_000),
    }]);
  }
  if (text.includes("SELECT * FROM project_collaborators") && text.includes("principal_id") && text.includes("FOR UPDATE")) {
    return acceptedExistingRole
      ? Promise.resolve([{
        id: "existing-user",
        project_ref: "proj_1",
        principal_id: "owner",
        role: acceptedExistingRole,
        status: acceptedExistingStatus,
      }])
      : Promise.resolve([]);
  }
  if (text.includes("SELECT * FROM project_collaborators") && text.includes("FOR UPDATE")) {
    return Promise.resolve([{
      id: "owner-one",
      project_ref: "proj_1",
      principal_id: "owner",
      role: "owner",
      status: "active",
    }]);
  }
  if (text.includes("COUNT(*)::int AS count")) return Promise.resolve([{ count: ownerCount }]);
  if (text.includes("UPDATE project_collaborators")) {
    const row = { id: "owner-one", role: values[0] ?? "owner", status: "active" };
    updatedRows.push(row);
    return Promise.resolve([row]);
  }
  if (text.includes("DELETE FROM project_collaborators")) {
    return Promise.resolve([{ id: "owner-one", role: "owner", status: "active" }]);
  }
  if (text.includes("INSERT INTO project_collaborators")) {
    acceptedCollaboratorInsert = text;
    return Promise.resolve([{ id: "owner-one", role: "owner", status: "active" }]);
  }
  return Promise.resolve([]);
});

const sqlMock = Object.assign(
  mock((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("FROM projects")) return Promise.resolve([{ ref: "proj_1" }]);
    if (text.includes("SELECT role FROM project_collaborators")) {
      return Promise.resolve(actorRole ? [{ role: actorRole }] : []);
    }
    if (text.includes("SELECT * FROM project_collaborators")) return Promise.resolve([]);
    if (text.includes("INSERT INTO project_collaborators")) {
      return Promise.resolve([{ id: "created-one", role: values[3], status: "active" }]);
    }
    return Promise.resolve([]);
  }),
  { begin: mock((callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock)) },
);

const tenantDbMock = mock((strings: TemplateStringsArray) => {
  const text = strings.join("?");
  if (text.includes("FROM auth.users")) return Promise.resolve(gotrueUserExists ? [{ id: "new-owner" }] : []);
  return Promise.resolve([]);
});

mock.module("../../src/db", () => ({
  sql: sqlMock,
  getProjectDb: () => tenantDbMock,
  resolveDbName: async (ref: string) => {
    resolvedAuthorityRefs.push(ref);
    return `supa_${ref}`;
  },
}));
const { projectCollaboratorService } = await import("../../src/services/project-collaborator.service");
const { config } = await import("../../src/config");
const originalOwnerRef = config.authRuntimeOwnerRef;

describe("project collaborator authorization and owner protection", () => {
  afterAll(() => {
    config.authRuntimeOwnerRef = originalOwnerRef;
  });

  beforeEach(() => {
    ownerCount = 1;
    actorRole = null;
    updatedRows = [];
    acceptedCollaboratorInsert = "";
    acceptedExistingRole = "owner";
    acceptedExistingStatus = "active";
    gotrueUserExists = true;
    resolvedAuthorityRefs = [];
    config.authRuntimeOwnerRef = "";
    txMock.mockClear();
    sqlMock.mockClear();
  });

  test("rejects demoting the last active owner", async () => {
    await expect(projectCollaboratorService.update(
      "proj_1",
      "owner-one",
      { role: "admin" },
      platformAdmin,
    )).rejects.toThrow("at least one active owner");
    expect(updatedRows).toHaveLength(0);
  });

  test("rejects deleting the last active owner", async () => {
    await expect(projectCollaboratorService.remove(
      "proj_1",
      "owner-one",
      platformAdmin,
    )).rejects.toThrow("last active owner");
  });

  test("allows demotion after a second active owner exists", async () => {
    ownerCount = 2;
    expect(await projectCollaboratorService.update(
      "proj_1",
      "owner-one",
      { role: "admin" },
      platformAdmin,
    )).toMatchObject({ id: "owner-one", role: "admin" });
  });

  test("allows viewers to read collaborators but denies member management", async () => {
    actorRole = "viewer";
    await expect(projectCollaboratorService.list("proj_1", delegatedActor)).resolves.toMatchObject({
      scope: "project",
      total: 0,
    });
    await expect(projectCollaboratorService.invite(
      "proj_1",
      { email: "new@example.test", role: "member" },
      delegatedActor,
    )).rejects.toThrow("tenant.members.manage");
  });

  test("requires owner transfer permission when assigning the owner role", async () => {
    actorRole = "admin";
    await expect(projectCollaboratorService.create(
      "proj_1",
      { principal_id: "new-owner", role: "owner" },
      delegatedActor,
    )).rejects.toThrow("tenant.owner.transfer");

    actorRole = "owner";
    await expect(projectCollaboratorService.create(
      "proj_1",
      { principal_id: "new-owner", role: "owner" },
      delegatedActor,
    )).resolves.toMatchObject({ role: "owner" });
  });

  test("rejects creating a collaborator for a missing GoTrue user", async () => {
    gotrueUserExists = false;
    await expect(projectCollaboratorService.create(
      "proj_1",
      { principal_id: "missing-user", role: "owner" },
      platformAdmin,
    )).rejects.toThrow("GoTrue user not found");
  });

  test("resolves collaborator principals from the auth authority project", async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    await projectCollaboratorService.create(
      "proj_1",
      { principal_id: "new-owner", role: "owner" },
      platformAdmin,
    );
    expect(resolvedAuthorityRefs).toContain("auth-owner");
  });

  test("rejects delegated actors that are not active collaborators", async () => {
    await expect(projectCollaboratorService.list("proj_1", delegatedActor))
      .rejects.toThrow("not an active project collaborator");
  });

  test("rejects an invitation when the authoritative GoTrue email differs", async () => {
    await expect(projectCollaboratorService.accept({
      ref: "proj_1",
      invitationId: "invite-one",
      token: "valid-token",
      principal: { id: "user-one", email: "other@example.test" },
    })).rejects.toThrow("Invitation email does not match");
  });

  test("does not demote an existing owner through invitation acceptance", async () => {
    await expect(projectCollaboratorService.accept({
      ref: "proj_1",
      invitationId: "invite-one",
      token: "valid-token",
      principal: { id: "owner", email: "owner@example.test" },
    })).resolves.toMatchObject({ role: "owner" });
    expect(acceptedCollaboratorInsert).toBe("");
  });

  test("does not let a suspended owner self-reactivate through an invitation", async () => {
    acceptedExistingStatus = "suspended";
    await expect(projectCollaboratorService.accept({
      ref: "proj_1",
      invitationId: "invite-one",
      token: "valid-token",
      principal: { id: "owner", email: "owner@example.test" },
    })).rejects.toThrow("must be reactivated by an authorized project owner or admin");
  });

  test("does not change an existing collaborator role through invitation acceptance", async () => {
    acceptedExistingRole = "admin";
    await expect(projectCollaboratorService.accept({
      ref: "proj_1",
      invitationId: "invite-one",
      token: "valid-token",
      principal: { id: "owner", email: "owner@example.test" },
    })).resolves.toMatchObject({ role: "admin" });
    expect(acceptedCollaboratorInsert).toBe("");
  });
});
