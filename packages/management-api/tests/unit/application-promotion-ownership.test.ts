import { expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  assertApplicationPromotionOwner, ApplicationPromotionOwnershipError,
  type ApplicationPromotionOwner, type ApplicationPromotionScope,
} from "../../src/services/application-promotion-ownership";
import { projectMutationResourceKey } from "../../src/services/project-mutation.service";
import { stableSha256 } from "../../src/utils/stable-json";

function fixture() {
  const scope: ApplicationPromotionScope = {
    projectRef: "production", applicationId: "reviews", environmentId: "production",
  };
  const owner: ApplicationPromotionOwner = {
    lease: {
      projectRef: scope.projectRef, mutationId: "01234567-89ab-4def-8123-456789abcdef",
      leaseToken: "11234567-89ab-4def-8123-456789abcdef", fencingEpoch: 3,
    },
    principal: { type: "admin", id: "release-admin" }, requestFingerprint: "a".repeat(64),
  };
  const stamp = "2026-10-11T00:00:00.000Z";
  const row = {
    project_ref: scope.projectRef, mutation_id: owner.lease.mutationId,
    operation: "application.release.promote",
    resource_key: projectMutationResourceKey({
      type: "application_release", id: stableSha256({
        applicationId: scope.applicationId, environmentId: scope.environmentId,
      }),
    }),
    request_fingerprint: owner.requestFingerprint, principal_type: owner.principal.type,
    principal_id: owner.principal.id, status: "running", checkpoint: {}, receipt: null,
    response_status: null, failure_code: null, lease_owner: "executor",
    lease_token: owner.lease.leaseToken, lease_expires_at: "2099-10-11T00:00:00.000Z",
    fencing_epoch: owner.lease.fencingEpoch, completed_at: null, created_at: stamp, updated_at: stamp,
  };
  let transactionOpen = false, resourceVisible = true, fail = false, present = true;
  const queries: Array<{ query: string; values: unknown[] }> = [];
  const transaction = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!transactionOpen) throw new Error("Query escaped the ownership transaction");
    const query = strings.join("?").replaceAll(/\s+/g, " ").trim();
    queries.push({ query, values });
    if (fail) throw new Error(`private-database-detail:${owner.lease.leaseToken}`);
    if (!present) return [];
    if (query.startsWith("SELECT mutation_id")) {
      const [projectRef, mutationId, leaseToken, epoch] = values;
      return row.project_ref === projectRef && row.mutation_id === mutationId
        && row.status === "running" && row.lease_token === leaseToken && row.fencing_epoch === epoch
        && Date.parse(row.lease_expires_at) > Date.now() ? [{ mutation_id: row.mutation_id }] : [];
    }
    if (query.includes("resource_key =")) {
      return resourceVisible && row.project_ref === values[0] && row.resource_key === values[1]
        ? [structuredClone(row)] : [];
    }
    return row.project_ref === values[0] && row.mutation_id === values[1] ? [structuredClone(row)] : [];
  };
  const database = Object.assign(transaction, {
    async begin<T>(callback: (value: SQL) => Promise<T>): Promise<T> {
      if (transactionOpen) throw new Error("Nested ownership transaction");
      transactionOpen = true;
      try { return await callback(transaction as unknown as SQL); }
      finally { transactionOpen = false; }
    },
  }) as unknown as SQL;
  return {
    scope, owner, row, database, queries,
    hideResource: () => { resourceVisible = false; },
    remove: () => { present = false; },
    fail: () => { fail = true; },
  };
}

test("ownership verifies the fenced row and canonical active resource in one read-only transaction", async () => {
  const f = fixture();
  await assertApplicationPromotionOwner(f.scope, f.owner, f.database);
  expect(f.queries).toHaveLength(3);
  expect(f.queries[0]!.query).toContain("lease_token = ? AND fencing_epoch = ?");
  expect(f.queries[0]!.query).toContain("lease_expires_at > clock_timestamp() FOR UPDATE");
  expect(f.queries[2]!.values).toEqual([f.scope.projectRef, f.row.resource_key]);
  expect(f.queries.every(({ query }) => query.startsWith("SELECT"))).toBe(true);
});

test.each(["expired", "token", "epoch", "missing", "not-running"] as const)(
  "ownership rejects a %s lease before reading the plan owner",
  async fault => {
    const f = fixture();
    if (fault === "expired") f.row.lease_expires_at = "2000-01-01T00:00:00.000Z";
    if (fault === "token") f.row.lease_token = "21234567-89ab-4def-8123-456789abcdef";
    if (fault === "epoch") f.row.fencing_epoch++;
    if (fault === "missing") f.remove();
    if (fault === "not-running") f.row.status = "outcome_unknown";
    await expect(assertApplicationPromotionOwner(f.scope, f.owner, f.database))
      .rejects.toBeInstanceOf(ApplicationPromotionOwnershipError);
    expect(f.queries).toHaveLength(1);
  },
);

test.each(["operation", "resource", "fingerprint", "principal-id", "principal-type", "active-resource"] as const)(
  "ownership rejects a changed %s binding while the lease itself remains valid",
  async fault => {
    const f = fixture();
    if (fault === "operation") f.row.operation = "application.release.activate";
    if (fault === "resource") f.row.resource_key = projectMutationResourceKey({
      type: "application_release", id: stableSha256({ applicationId: "reviews", environmentId: "other" }),
    });
    if (fault === "fingerprint") f.row.request_fingerprint = "b".repeat(64);
    if (fault === "principal-id") f.row.principal_id = "other-admin";
    if (fault === "principal-type") f.owner.principal.type = "master";
    if (fault === "active-resource") f.hideResource();
    await expect(assertApplicationPromotionOwner(f.scope, f.owner, f.database))
      .rejects.toThrow("APPLICATION_PROMOTION_OWNERSHIP_LOST");
    expect(f.queries).toHaveLength(fault === "active-resource" ? 3 : 2);
  },
);

test.each(["project", "scope", "fingerprint", "lease-token", "epoch"] as const)(
  "invalid %s identity never queries the database",
  async fault => {
    const f = fixture();
    if (fault === "project") f.scope.projectRef = "other";
    if (fault === "scope") f.scope.environmentId = "../production";
    if (fault === "fingerprint") f.owner.requestFingerprint = "";
    if (fault === "lease-token") f.owner.lease.leaseToken = "private-invalid-token";
    if (fault === "epoch") f.owner.lease.fencingEpoch = 0;
    await expect(assertApplicationPromotionOwner(f.scope, f.owner, f.database))
      .rejects.toThrow("APPLICATION_PROMOTION_OWNERSHIP_LOST");
    expect(f.queries).toHaveLength(0);
  },
);

test("ownership failures never reflect lease credentials or database details", async () => {
  const f = fixture();
  f.fail();
  await expect(assertApplicationPromotionOwner(f.scope, f.owner, f.database))
    .rejects.toThrow(/^APPLICATION_PROMOTION_OWNERSHIP_LOST$/);
});
