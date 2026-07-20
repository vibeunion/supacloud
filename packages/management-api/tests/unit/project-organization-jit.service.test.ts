import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

type Membership = {
  organization_id: string;
  slug: string;
  role: string;
};

let authorityUser: { id: string; email: string | null } | null;
let memberships: Membership[];
let resolvedRefs: string[];
let jitInsertions: number;

const authorityDb = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join("?");
  if (!query.includes("FROM auth.users")) return Promise.resolve([]);
  if (!authorityUser || authorityUser.id !== values[0]) return Promise.resolve([]);
  return Promise.resolve([{ ...authorityUser }]);
});

const transaction = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join("?");
  if (query.includes("INSERT INTO project_business_organization_members") && query.includes("jit_enabled")) {
    const userId = String(values[0]);
    const domain = String(values[2]);
    if (domain === "example.com" && !memberships.some(({ organization_id }) => organization_id === "org-match")) {
      memberships.push({ organization_id: "org-match", slug: "matching-org", role: "member" });
      jitInsertions += 1;
    }
    expect(userId).toBe(authorityUser?.id);
    return Promise.resolve([]);
  }
  if (query.includes("SELECT organization.id::text AS organization_id")) {
    return Promise.resolve(memberships.slice(0, 50).map((membership) => ({
      ...membership,
      total: memberships.length,
    })));
  }
  return Promise.resolve([]);
});

const controlDb = Object.assign(
  mock((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM projects")) return Promise.resolve([{ ref: "business-project" }]);
    return Promise.resolve([]);
  }),
  { begin: mock(async (callback: (database: typeof transaction) => Promise<unknown>) => callback(transaction)) },
);

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

describe("project organization JIT reconciliation", () => {
  afterAll(() => {
    config.authRuntimeOwnerRef = originalOwnerRef;
  });

  beforeEach(() => {
    authorityUser = { id: "user-one", email: "user@example.com" };
    memberships = [];
    resolvedRefs = [];
    jitInsertions = 0;
    transaction.mockClear();
    controlDb.begin.mockClear();
    config.authRuntimeOwnerRef = "auth-owner";
  });

  test("returns no membership when the verified GoTrue email domain does not match", async () => {
    authorityUser = { id: "user-one", email: "user@other.example" };

    const reconciled = await projectOrganizationService.reconcileJitMemberships("business-project", "user-one");

    expect(reconciled).toEqual({ items: [], total: 0, limit: 50, truncated: false });
    expect(jitInsertions).toBe(0);
    expect(resolvedRefs).toEqual(["auth-owner"]);
  });

  test("materializes a matching membership idempotently through the shared authority", async () => {
    const first = await projectOrganizationService.reconcileJitMemberships("business-project", "user-one");
    const second = await projectOrganizationService.reconcileJitMemberships("business-project", "user-one");

    expect(first.items).toEqual([{ organization_id: "org-match", slug: "matching-org", role: "member" }]);
    expect(second).toEqual(first);
    expect(jitInsertions).toBe(1);
    expect(resolvedRefs).toEqual(["auth-owner", "auth-owner"]);
  });

  test("rejects ghost identities before touching organization membership state", async () => {
    authorityUser = null;

    await expect(
      projectOrganizationService.reconcileJitMemberships("business-project", "missing-user"),
    ).rejects.toThrow("GoTrue user");
    expect(controlDb.begin).not.toHaveBeenCalled();
  });

  test("bounds membership claims and reports truncation", async () => {
    memberships = Array.from({ length: 60 }, (_, index) => ({
      organization_id: `org-${index.toString().padStart(2, "0")}`,
      slug: `organization-${index}`,
      role: index === 0 ? "admin" : "member",
    }));
    authorityUser = { id: "user-one", email: null };

    const reconciled = await projectOrganizationService.reconcileJitMemberships("business-project", "user-one");

    expect(reconciled.items).toHaveLength(50);
    expect(reconciled.total).toBe(60);
    expect(reconciled.truncated).toBe(true);
    expect(reconciled.items[0]).toMatchObject({ role: "admin" });
  });
});
