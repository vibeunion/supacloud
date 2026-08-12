import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
  beginProjectMutation,
  checkpointProjectMutation,
  claimOrResumeProjectMutation,
  completeProjectMutationFailure,
  completeProjectMutationSuccess,
  projectMutationFingerprint,
  projectMutationResourceKey,
  reconcileProjectMutation,
} from "../../src/services/project-mutation.service";
import { appendAuditEventInTransaction } from "../../src/services/audit.service";

const database = new SQL({
  url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres",
  max: 5,
});
const projectRef = `mut${process.pid.toString(36)}${Date.now().toString(36)}`.slice(0, 20);
const projectActor = { type: "project" as const, id: `project:${projectRef}` };

async function installProjectFixture(): Promise<void> {
  await database`
    INSERT INTO projects (
      ref, name, db_name, db_user, db_password, jwt_secret,
      anon_key, service_role_key, s3_bucket, status
    ) VALUES (
      ${projectRef}, 'Mutation lease fixture', ${`db_${projectRef}`}, ${`user_${projectRef}`},
      'fixture-password', 'fixture-jwt-secret', 'fixture-anon-key',
      'fixture-service-role-key', ${`bucket-${projectRef}`}, 'active'
    )
  `;
}

async function beginAndClaim() {
  const mutationId = crypto.randomUUID();
  const leaseToken = crypto.randomUUID();
  await database.begin((transaction) => beginProjectMutation(transaction, {
    projectRef,
    mutationId,
    operation: "scheduled_functions.create",
    resource: { type: "scheduled-function", id: mutationId },
    requestFingerprint: projectMutationFingerprint({ project_ref: projectRef, mutation_id: mutationId }),
    principal: projectActor,
  }));
  const claim = await database.begin((transaction) => claimOrResumeProjectMutation(transaction, {
    projectRef, mutationId, leaseOwner: "original-worker", leaseToken, leaseSeconds: 30,
  }));
  if (claim.kind !== "claimed") throw new Error(`Fixture mutation was not claimed: ${claim.kind}`);
  return { mutationId, leaseToken, fencingEpoch: claim.mutation.fencingEpoch };
}

async function expireLease(mutationId: string): Promise<void> {
  await database`
    UPDATE project_mutations
    SET lease_expires_at = clock_timestamp() - INTERVAL '1 millisecond'
    WHERE project_ref = ${projectRef} AND mutation_id = ${mutationId}
  `;
}

beforeAll(installProjectFixture);

afterAll(async () => {
  await database`DELETE FROM projects WHERE ref = ${projectRef}`;
  await database.close();
}, 30_000);

describe("project mutation PostgreSQL lease fencing", () => {
  test("rejects an expired checkpoint racing a replacement claim", async () => {
    const fixture = await beginAndClaim();
    await expireLease(fixture.mutationId);
    const replacementToken = crypto.randomUUID();

    const [checkpoint, replacement] = await Promise.all([
      database.begin((transaction) => checkpointProjectMutation(transaction, {
        projectRef, mutationId: fixture.mutationId, leaseToken: fixture.leaseToken,
        fencingEpoch: fixture.fencingEpoch, leaseSeconds: 30, checkpoint: { phase: "stale" },
      })),
      database.begin((transaction) => claimOrResumeProjectMutation(transaction, {
        projectRef, mutationId: fixture.mutationId, leaseOwner: "replacement-worker",
        leaseToken: replacementToken, leaseSeconds: 30,
      })),
    ]);
    const [stored] = await database`
      SELECT checkpoint, lease_token, fencing_epoch, recovery_not_before, resource_key
      FROM project_mutations WHERE project_ref = ${projectRef} AND mutation_id = ${fixture.mutationId}
    `;

    expect(checkpoint).toBe("lease_lost");
    expect(replacement.kind).toBe("claimed");
    expect(stored).toMatchObject({
      checkpoint: {},
      lease_token: replacementToken,
      recovery_not_before: expect.any(Date),
      resource_key: projectMutationResourceKey({ type: "scheduled-function", id: fixture.mutationId }),
    });
    expect(Number(stored.fencing_epoch)).toBe(fixture.fencingEpoch + 1);
  }, 30_000);

  test("rejects an expired success racing a replacement claim", async () => {
    const fixture = await beginAndClaim();
    await expireLease(fixture.mutationId);
    const replacementToken = crypto.randomUUID();

    const [completion, replacement] = await Promise.all([
      database.begin((transaction) => completeProjectMutationSuccess(transaction, {
        projectRef, mutationId: fixture.mutationId, leaseToken: fixture.leaseToken,
        fencingEpoch: fixture.fencingEpoch, responseStatus: 200, receipt: { created: true },
      })),
      database.begin((transaction) => claimOrResumeProjectMutation(transaction, {
        projectRef, mutationId: fixture.mutationId, leaseOwner: "replacement-worker",
        leaseToken: replacementToken, leaseSeconds: 30,
      })),
    ]);
    const [stored] = await database`
      SELECT status, receipt, lease_token, fencing_epoch
      FROM project_mutations WHERE project_ref = ${projectRef} AND mutation_id = ${fixture.mutationId}
    `;

    expect(completion).toBe("lease_lost");
    expect(replacement.kind).toBe("claimed");
    expect(stored).toMatchObject({ status: "running", receipt: null, lease_token: replacementToken });
    expect(Number(stored.fencing_epoch)).toBe(fixture.fencingEpoch + 1);
  }, 30_000);

  test("preserves an active ceiling lease and reports exhaustion after expiry", async () => {
    const fixture = await beginAndClaim();
    await database`
      UPDATE project_mutations
      SET fencing_epoch = 9007199254740991,
          lease_expires_at = clock_timestamp() + INTERVAL '1 minute'
      WHERE project_ref = ${projectRef} AND mutation_id = ${fixture.mutationId}
    `;

    const resumed = await database.begin((transaction) => claimOrResumeProjectMutation(transaction, {
      projectRef, mutationId: fixture.mutationId, leaseOwner: "original-worker",
      leaseToken: fixture.leaseToken, leaseSeconds: 30,
    }));
    const competing = await database.begin((transaction) => claimOrResumeProjectMutation(transaction, {
      projectRef, mutationId: fixture.mutationId, leaseOwner: "competing-worker",
      leaseToken: crypto.randomUUID(), leaseSeconds: 30,
    }));

    expect(resumed.kind).toBe("claimed");
    expect(competing.kind).toBe("busy");

    await expireLease(fixture.mutationId);
    await expect(database.begin((transaction) => claimOrResumeProjectMutation(transaction, {
      projectRef, mutationId: fixture.mutationId, leaseOwner: "replacement-worker",
      leaseToken: crypto.randomUUID(), leaseSeconds: 30,
    }))).rejects.toThrow("fencing epoch is exhausted");
    const [stored] = await database`
      SELECT status, lease_token, fencing_epoch
      FROM project_mutations WHERE project_ref = ${projectRef} AND mutation_id = ${fixture.mutationId}
    `;

    expect(stored).toMatchObject({ status: "running", lease_token: fixture.leaseToken });
    expect(Number(stored.fencing_epoch)).toBe(Number.MAX_SAFE_INTEGER);
  }, 30_000);

  test("allows exactly one reconciliation writer for an unknown outcome epoch", async () => {
    const fixture = await beginAndClaim();
    const unknownOutcome = await database.begin((transaction) => completeProjectMutationFailure(transaction, {
      projectRef, mutationId: fixture.mutationId, leaseToken: fixture.leaseToken,
      fencingEpoch: fixture.fencingEpoch, status: "outcome_unknown", failureCode: "PROVIDER_OUTCOME_UNKNOWN",
    }));
    expect(unknownOutcome).toBe("updated");
    const [unknown] = await database`
      SELECT completed_at
      FROM project_mutations WHERE project_ref = ${projectRef} AND mutation_id = ${fixture.mutationId}
    `;
    const baseEvidence = {
      source: "scheduled_functions.provider_readback",
      observedAt: new Date(unknown.completed_at).toISOString(),
    };

    const reconciliations = await Promise.all([
      database.begin((transaction) => reconcileProjectMutation(transaction, projectActor, {
        projectRef, mutationId: fixture.mutationId, expectedFencingEpoch: fixture.fencingEpoch,
        status: "succeeded", responseStatus: 200,
        evidence: { ...baseEvidence, evidenceCode: "RESOURCE_PRESENT", evidenceFingerprint: "a".repeat(64) },
      })),
      database.begin((transaction) => reconcileProjectMutation(transaction, projectActor, {
        projectRef, mutationId: fixture.mutationId, expectedFencingEpoch: fixture.fencingEpoch,
        status: "failed_terminal", responseStatus: 404, failureCode: "RESOURCE_NOT_FOUND",
        evidence: { ...baseEvidence, evidenceCode: "RESOURCE_ABSENT", evidenceFingerprint: "b".repeat(64) },
      })),
    ]);
    const [stored] = await database`
      SELECT status, receipt, fencing_epoch
      FROM project_mutations WHERE project_ref = ${projectRef} AND mutation_id = ${fixture.mutationId}
    `;

    expect(reconciliations.map((entry) => entry.kind).sort()).toEqual(["not_reconcilable", "updated"]);
    expect(["succeeded", "failed_terminal"]).toContain(stored.status);
    expect(Number(stored.fencing_epoch)).toBe(fixture.fencingEpoch);
    expect(stored.receipt.reconciliation.target_status).toBe(stored.status);
  }, 30_000);

  test("rolls reconciliation back when the audit insert fails", async () => {
    const fixture = await beginAndClaim();
    await database.begin((transaction) => completeProjectMutationFailure(transaction, {
      projectRef, mutationId: fixture.mutationId, leaseToken: fixture.leaseToken,
      fencingEpoch: fixture.fencingEpoch, status: "outcome_unknown",
      failureCode: "PROVIDER_OUTCOME_UNKNOWN",
    }));
    const connection = await database.reserve();
    await connection.unsafe("BEGIN");
    try {
      const [unknown] = await connection`
        SELECT completed_at
        FROM project_mutations WHERE project_ref = ${projectRef} AND mutation_id = ${fixture.mutationId}
      `;
      await connection.unsafe("SAVEPOINT before_reconciliation");
      let auditFailure: unknown = null;
      try {
        await reconcileProjectMutation(connection as unknown as SQL, projectActor, {
          projectRef, mutationId: fixture.mutationId, expectedFencingEpoch: fixture.fencingEpoch,
          status: "succeeded", responseStatus: 200,
          evidence: {
            source: "scheduled_functions.provider_readback",
            observedAt: new Date(unknown.completed_at).toISOString(),
            evidenceCode: "RESOURCE_PRESENT",
            evidenceFingerprint: "c".repeat(64),
          },
        });
        await appendAuditEventInTransaction(connection as unknown as SQL, {
          projectRef,
          actor: projectActor.id,
          actorType: projectActor.type,
          action: "project_mutation.reconciled",
          method: "AUDIT_INSERT_FAILPOINT",
          path: `/v1/projects/${projectRef}/mutations/${fixture.mutationId}/reconcile`,
          status: 200,
          requestId: "audit-insert-failpoint",
        });
      } catch (error) {
        auditFailure = error;
        await connection.unsafe("ROLLBACK TO SAVEPOINT before_reconciliation");
      }
      const [stored] = await connection`
        SELECT status, receipt
        FROM project_mutations WHERE project_ref = ${projectRef} AND mutation_id = ${fixture.mutationId}
      `;

      expect(auditFailure).toBeInstanceOf(Error);
      expect(stored.status).toBe("outcome_unknown");
      expect(stored.receipt).toEqual({});
    } finally {
      await connection.unsafe("ROLLBACK");
      connection.release();
    }
  }, 30_000);
});
