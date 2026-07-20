import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

let resolvedRefs: string[] = [];
let controlQueries: Array<{ query: string; values: unknown[] }> = [];
let storedMembers: Array<Record<string, unknown>> = [];
let rejectOutboxInsert = false;
let memberMutationVersion = 0;

const authorityDb = mock((strings: TemplateStringsArray) => {
  const query = strings.join("?");
  if (query.includes("FROM auth.users")) return Promise.resolve([{ id: "user-one" }]);
  if (query.includes("FROM auth.oauth_clients")) return Promise.resolve([{ id: "app-one" }]);
  return Promise.resolve([]);
});

const controlQuery = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join("?");
  controlQueries.push({ query, values });
  if (query.includes("FROM projects")) return Promise.resolve([{ ref: "business-project" }]);
  if (query.includes("FROM project_business_organizations")) {
    return Promise.resolve([{ id: "org-one", project_ref: "business-project" }]);
  }
  if (query.includes("INSERT INTO project_business_organizations")) {
    return Promise.resolve([{ id: "org-one", project_ref: "business-project", name: values[1], slug: values[2] }]);
  }
  if (query.includes("INSERT INTO project_business_organization_members")) {
    const existing = storedMembers.find((member) => (
      member.organization_id === values[0] && member.user_id === values[1]
    ));
    if (existing?.role === values[2]) return Promise.resolve([]);
    if (existing) {
      existing.role = values[2];
      return Promise.resolve([existing]);
    }
    memberMutationVersion += 1;
    const timestamp = new Date(`2026-07-20T00:00:0${memberMutationVersion}.000Z`);
    const member = {
      id: "member-one",
      organization_id: values[0],
      user_id: values[1],
      role: values[2],
      created_at: timestamp,
      updated_at: timestamp,
    };
    storedMembers.push(member);
    return Promise.resolve([member]);
  }
  if (query.includes("UPDATE project_business_organization_members") && query.includes("SET role =")) {
    const member = storedMembers.find((candidate) => candidate.id === values[1]);
    if (!member) return Promise.resolve([]);
    memberMutationVersion += 1;
    member.role = values[0];
    member.updated_at = new Date(`2026-07-20T00:00:0${memberMutationVersion}.000Z`);
    return Promise.resolve([member]);
  }
  if (query.includes("DELETE FROM project_business_organization_members")) {
    const [member] = storedMembers.splice(0, 1);
    return Promise.resolve(member ? [member] : []);
  }
  if (query.includes("SELECT * FROM project_business_organization_members")) {
    const member = storedMembers.find((candidate) => {
      if (candidate.organization_id !== values[0]) return false;
      if (query.includes("id::text")) return candidate.id === values[1] || candidate.user_id === values[1];
      return candidate.user_id === values[1];
    });
    return Promise.resolve(member ? [member] : []);
  }
  if (query.includes("INSERT INTO project_business_organization_invitations")) {
    return Promise.resolve([{
      id: "invitation-one",
      organization_id: "org-one",
      email: values[1],
      role: values[2],
      token_hash: values[3],
      status: "pending",
      expires_at: values[5],
    }]);
  }
  if (query.includes("SELECT * FROM project_business_organization_invitations")) {
    return Promise.resolve([{
      id: "invitation-one",
      organization_id: "org-one",
      email: "new@example.test",
      role: "member",
      token_hash: createHash("sha256").update("one-time-token").digest("hex"),
      status: "pending",
      expires_at: new Date(Date.now() + 60_000),
    }]);
  }
  if (query.includes("INSERT INTO project_business_organization_applications")) {
    return Promise.resolve([{ id: "binding-one", application_id: values[1] }]);
  }
  if (query.includes("COUNT(*)::int AS count FROM project_webhooks w")) return Promise.resolve([{ count: 1 }]);
  if (query.includes("COUNT(*)::int AS count FROM webhook_outbox")) return Promise.resolve([{ count: 0 }]);
  if (query.includes("INSERT INTO webhook_outbox")) {
    if (rejectOutboxInsert) throw new Error("outbox unavailable");
    return Promise.resolve([{ event_id: "11111111-1111-4111-8111-111111111111" }]);
  }
  return Promise.resolve([]);
});
const controlDb = Object.assign(controlQuery, {
  begin: mock(async (callback: (transaction: typeof controlQuery) => Promise<unknown>) => {
    const memberSnapshot = structuredClone(storedMembers);
    try {
      return await callback(controlQuery);
    } catch (error) {
      storedMembers = memberSnapshot;
      throw error;
    }
  }),
});

mock.module("../../src/db", () => ({
  sql: controlDb,
  getProjectDb: () => authorityDb,
  resolveDbName: async (ref: string) => {
    resolvedRefs.push(ref);
    return `supa_${ref}`;
  },
}));

const { projectOrganizationService } = await import("../../src/services/project-organization.service");
const { config } = await import("../../src/config");
const originalOwnerRef = config.authRuntimeOwnerRef;

describe("project organization GoTrue authority", () => {
  afterAll(() => {
    config.authRuntimeOwnerRef = originalOwnerRef;
  });

  beforeEach(() => {
    resolvedRefs = [];
    controlQueries = [];
    storedMembers = [];
    rejectOutboxInsert = false;
    memberMutationVersion = 0;
    config.authRuntimeOwnerRef = "auth-owner";
  });

  test("validates users and OAuth applications against the shared auth authority", async () => {
    await projectOrganizationService.addMember("business-project", "org-one", {
      userId: "user-one",
      role: "member",
      actor: "admin",
    });
    await projectOrganizationService.bindApplication(
      "business-project",
      "org-one",
      "app-one",
      "admin",
    );

    expect(resolvedRefs).toEqual(["auth-owner", "auth-owner"]);
    expect(controlQueries.some(({ query }) => query.includes("INSERT INTO webhook_outbox"))).toBe(true);
    expect(controlQueries.flatMap(({ values }) => values)).toContain("organization.member_added:member-one");
  });

  test("rolls back member creation when the transactional outbox write fails", async () => {
    rejectOutboxInsert = true;

    await expect(projectOrganizationService.addMember("business-project", "org-one", {
      userId: "user-one",
      role: "member",
      actor: "admin",
    })).rejects.toThrow("outbox unavailable");

    expect(storedMembers).toEqual([]);
  });

  test("does not enqueue member-added again when the membership is unchanged", async () => {
    const first = await projectOrganizationService.addMember("business-project", "org-one", {
      userId: "user-one",
      role: "member",
      actor: "admin",
    });
    const second = await projectOrganizationService.addMember("business-project", "org-one", {
      userId: "user-one",
      role: "member",
      actor: "admin",
    });

    expect(second).toEqual(first);
    expect(controlQueries.filter(({ query }) => query.includes("INSERT INTO webhook_outbox"))).toHaveLength(1);
  });

  test("emits a uniquely versioned member-updated event for a real role change", async () => {
    await projectOrganizationService.addMember("business-project", "org-one", {
      userId: "user-one",
      role: "member",
      actor: "admin",
    });
    await projectOrganizationService.addMember("business-project", "org-one", {
      userId: "user-one",
      role: "admin",
      actor: "admin",
    });

    const eventKeys = controlQueries
      .flatMap(({ values }) => values)
      .filter((value): value is string => typeof value === "string" && value.startsWith("organization.member_"));
    expect(eventKeys).toContain("organization.member_added:member-one");
    expect(eventKeys).toContain("organization.member_updated:member-one:2026-07-20T00:00:02.000Z");
    expect(storedMembers[0]?.role).toBe("admin");
  });

  test("keeps an unchanged member PATCH free of updates and outbox writes", async () => {
    await projectOrganizationService.addMember("business-project", "org-one", {
      userId: "user-one",
      role: "member",
      actor: "admin",
    });
    const queriesBeforePatch = controlQueries.length;

    await projectOrganizationService.updateMember("business-project", "org-one", "member-one", {
      role: "member",
      actor: "admin",
    });

    const patchQueries = controlQueries.slice(queriesBeforePatch);
    expect(patchQueries.some(({ query }) => query.includes("UPDATE project_business_organization_members"))).toBe(false);
    expect(patchQueries.some(({ query }) => query.includes("INSERT INTO webhook_outbox"))).toBe(false);
  });

  test("rolls back a member PATCH when its transactional outbox write fails", async () => {
    await projectOrganizationService.addMember("business-project", "org-one", {
      userId: "user-one",
      role: "member",
      actor: "admin",
    });
    rejectOutboxInsert = true;

    await expect(projectOrganizationService.updateMember("business-project", "org-one", "user-one", {
      role: "admin",
      actor: "patch-admin",
    })).rejects.toThrow("outbox unavailable");

    expect(storedMembers[0]?.role).toBe("member");
    const eventKeys = controlQueries.flatMap(({ values }) => values);
    expect(eventKeys).toContain("organization.member_updated:member-one:2026-07-20T00:00:02.000Z");
    expect(eventKeys).toContain("patch-admin");
  });

  test("uses returned resource ids for every organization event idempotency key", async () => {
    await projectOrganizationService.create("business-project", { name: "Acme" }, "admin");
    await projectOrganizationService.addMember("business-project", "org-one", {
      userId: "user-one",
      role: "member",
      actor: "admin",
    });
    await projectOrganizationService.removeMember("business-project", "org-one", "member-one", "admin");
    await projectOrganizationService.invite({
      ref: "business-project",
      organizationId: "org-one",
      email: "new@example.test",
      role: "member",
      actor: "admin",
    });
    await projectOrganizationService.acceptInvitation({
      ref: "business-project",
      organizationId: "org-one",
      invitationId: "invitation-one",
      token: "one-time-token",
      principal: { id: "accepted-user", email: "new@example.test" },
    });

    const queryValues = controlQueries.flatMap(({ values }) => values);
    expect(queryValues).toContain("organization.created:org-one");
    expect(queryValues).toContain("organization.member_added:member-one");
    expect(queryValues).toContain("organization.member_removed:member-one");
    expect(queryValues).toContain("organization.invitation_created:invitation-one");
  });
});
