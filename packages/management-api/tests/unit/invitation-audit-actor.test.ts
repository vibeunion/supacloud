import { describe, expect, mock, test } from "bun:test";

let persistedActor: { id: string; type: string } | null = null;
const transactionQueries: string[] = [];
const transaction = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join("?");
  transactionQueries.push(query);
  if (query.includes("SELECT last_event_hash")) return Promise.resolve([]);
  if (query.includes("INSERT INTO audit_logs")) {
    persistedActor = { id: String(values[2]), type: String(values[3]) };
    return Promise.resolve([{ id: values[0] }]);
  }
  return Promise.resolve([]);
});
const sql = Object.assign(mock(() => Promise.resolve([])), {
  begin: mock(async (callback: (database: typeof transaction) => Promise<unknown>) => callback(transaction)),
});

mock.module("../../src/db", () => ({ sql }));
mock.module("../../src/middleware/auth", () => ({
  getVerifiedRequestPrincipal: mock(async () => null),
}));
mock.module("../../src/services/bff-proof.service", () => ({
  resolveTrustedPrincipal: mock(async () => {
    throw new Error("delegated proof must not replace an invitation principal");
  }),
}));

const { logAuditEvent } = await import("../../src/services/audit.service");
const { registerVerifiedAuditPrincipal } = await import("../../src/services/request-audit-principal.service");

describe("invitation acceptance audit actor", () => {
  test("persists the verified GoTrue user instead of anonymous", async () => {
    const request = new Request(
      "http://localhost/v1/projects/proj_1/organizations/org-one/invitations/invite-one/accept",
      { method: "POST", headers: { "x-request-id": "request-one" } },
    );
    registerVerifiedAuditPrincipal(request, { id: "gotrue-user", type: "user" });

    await logAuditEvent({ request, status: 200 });

    expect(persistedActor).toEqual({ id: "gotrue-user", type: "user" });
    expect(persistedActor?.id).not.toBe("anonymous");
    expect(transactionQueries[0]).toContain("pg_advisory_xact_lock_shared");
    expect(transactionQueries[1]).toContain("pg_advisory_xact_lock(hashtext(");
    expect(transactionQueries.findIndex((query) => query.includes("INSERT INTO audit_logs")))
      .toBeGreaterThan(1);
  });
});
