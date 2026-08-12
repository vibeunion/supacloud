import { beforeEach, describe, expect, mock, test } from "bun:test";

const PROJECT_REF = "proj_1";
const MUTATION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_MUTATION_ID = "00000000-0000-4000-8000-000000000002";
const LEASE_TOKEN_A = "00000000-0000-4000-8000-000000000003";
const LEASE_TOKEN_B = "00000000-0000-4000-8000-000000000004";
const CREATED_AT = "2026-08-11T00:00:00.000Z";
const ACTIVE_STATUSES = new Set(["pending", "running", "failed_retryable", "outcome_unknown"]);
let leaseTokenSequence = 100;

type MutationRow = Record<string, unknown> & {
  project_ref: string;
  mutation_id: string;
  resource_key: string | null;
  status: string;
};

const mutationRows = new Map<string, MutationRow>();
const executedQueries: string[] = [];

function mutationKey(projectRef: string, mutationId: string): string {
  return `${projectRef}:${mutationId}`;
}

function queryText(strings: TemplateStringsArray): string {
  return strings.join("?").replaceAll(/\s+/g, " ").trim();
}

function clonedRow(row: MutationRow | undefined): MutationRow[] {
  return row ? [structuredClone(row)] : [];
}

function insertedMutation(parameters: unknown[]): MutationRow[] {
  const [projectRef, mutationId, operation, resourceKey, fingerprint, principalType, principalId] = parameters;
  const key = mutationKey(String(projectRef), String(mutationId));
  if (mutationRows.has(key)) return [];
  const resourceBlocked = resourceKey !== null && [...mutationRows.values()].some((row) =>
    row.project_ref === projectRef && row.resource_key === resourceKey && ACTIVE_STATUSES.has(row.status)
  );
  if (resourceBlocked) return [];
  const row: MutationRow = {
    project_ref: String(projectRef), mutation_id: String(mutationId), operation: String(operation),
    resource_key: resourceKey === null ? null : String(resourceKey), request_fingerprint: String(fingerprint),
    principal_type: String(principalType), principal_id: String(principalId), status: "pending",
    checkpoint: {}, receipt: null, response_status: null, failure_code: null,
    lease_owner: null, lease_token: null, lease_expires_at: null, fencing_epoch: 0,
    recovery_not_before: new Date().toISOString(),
    completed_at: null, created_at: CREATED_AT, updated_at: CREATED_AT,
  };
  mutationRows.set(key, row);
  return clonedRow(row);
}

function claimedMutation(parameters: unknown[]): MutationRow[] {
  const [leaseOwner, leaseToken, leaseSeconds, projectRef, mutationId] = parameters;
  const row = mutationRows.get(mutationKey(String(projectRef), String(mutationId)));
  const leaseExpired = row?.status === "running"
    && Date.parse(String(row.lease_expires_at)) <= Date.now();
  if (!row || Number(row.fencing_epoch) >= Number.MAX_SAFE_INTEGER
    || (!["pending", "failed_retryable"].includes(row.status) && !leaseExpired)) return [];
  Object.assign(row, {
    status: "running", lease_owner: leaseOwner, lease_token: leaseToken,
    lease_expires_at: new Date(Date.now() + Number(leaseSeconds) * 1000).toISOString(),
    fencing_epoch: Number(row.fencing_epoch) + 1, completed_at: null,
  });
  return clonedRow(row);
}

function checkpointedMutation(parameters: unknown[]): Array<{ mutation_id: string }> {
  const [checkpoint, preserveRecoveryTime, recoveryNotBefore, leaseSeconds,
    projectRef, mutationId, leaseToken, fencingEpoch] = parameters;
  const row = mutationRows.get(mutationKey(String(projectRef), String(mutationId)));
  if (!row || row.status !== "running" || row.lease_token !== leaseToken
    || Number(row.fencing_epoch) !== Number(fencingEpoch)
    || Date.parse(String(row.lease_expires_at)) <= Date.now()) return [];
  row.checkpoint = structuredClone(checkpoint);
  if (!preserveRecoveryTime) row.recovery_not_before = recoveryNotBefore;
  row.lease_expires_at = new Date(Date.now() + Number(leaseSeconds) * 1000).toISOString();
  return [{ mutation_id: row.mutation_id }];
}

function finishedMutation(parameters: unknown[]): Array<{ mutation_id: string }> {
  const [status, receipt, responseStatus, failureCode, preserveRecoveryTime, recoveryNotBefore, ,
    projectRef, mutationId, leaseToken, fencingEpoch] = parameters;
  const row = mutationRows.get(mutationKey(String(projectRef), String(mutationId)));
  if (!row || row.status !== "running" || row.lease_token !== leaseToken
    || Number(row.fencing_epoch) !== Number(fencingEpoch)
    || Date.parse(String(row.lease_expires_at)) <= Date.now()) return [];
  Object.assign(row, {
    status, receipt: structuredClone(receipt), response_status: responseStatus, failure_code: failureCode,
    lease_owner: null, lease_token: null, lease_expires_at: null,
    recovery_not_before: preserveRecoveryTime ? row.recovery_not_before : recoveryNotBefore,
    completed_at: ["succeeded", "failed_terminal", "outcome_unknown"].includes(String(status))
      ? "2026-08-11T00:00:01.000Z" : null,
  });
  return [{ mutation_id: row.mutation_id }];
}

function reconciledMutation(parameters: unknown[]): MutationRow[] {
  const [status, receipt, responseStatus, failureCode, projectRef, mutationId,
    principalType, principalId, expectedEpoch] = parameters;
  const row = mutationRows.get(mutationKey(String(projectRef), String(mutationId)));
  if (!row || row.status !== "outcome_unknown"
    || row.principal_type !== principalType || row.principal_id !== principalId
    || Number(row.fencing_epoch) !== Number(expectedEpoch)) return [];
  Object.assign(row, {
    status, receipt: structuredClone(receipt), response_status: responseStatus,
    failure_code: failureCode, recovery_not_before: null,
    completed_at: "2026-08-11T00:00:02.000Z", updated_at: "2026-08-11T00:00:02.000Z",
  });
  return clonedRow(row);
}

function generatedLeaseToken(): string {
  const suffix = String(leaseTokenSequence++).padStart(12, "0");
  return `00000000-0000-4000-8000-${suffix}`;
}

function recoverableMutations(parameters: unknown[]): MutationRow[] {
  const [operations, limit, leaseOwner, leaseSeconds] = parameters;
  const operationNames = new Set(operations as string[]);
  const claimed = [...mutationRows.values()]
    .filter((row) => operationNames.has(String(row.operation))
      && row.recovery_not_before !== null
      && Date.parse(String(row.recovery_not_before)) <= Date.now()
      && (["pending", "failed_retryable"].includes(row.status)
        || row.status === "running" && Date.parse(String(row.lease_expires_at)) <= Date.now()))
    .sort((left, right) => String(left.recovery_not_before).localeCompare(String(right.recovery_not_before))
      || String(left.updated_at).localeCompare(String(right.updated_at))
      || left.project_ref.localeCompare(right.project_ref)
      || left.mutation_id.localeCompare(right.mutation_id))
    .slice(0, Number(limit));
  for (const row of claimed) Object.assign(row, {
    status: "running", lease_owner: leaseOwner, lease_token: generatedLeaseToken(),
    lease_expires_at: new Date(Date.now() + Number(leaseSeconds) * 1000).toISOString(),
    fencing_epoch: Number(row.fencing_epoch) + 1, completed_at: null,
  });
  return claimed.map((row) => structuredClone(row));
}

const database = mock(async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
  const query = queryText(strings);
  executedQueries.push(query);
  if (query.startsWith("INSERT INTO project_mutations")) return insertedMutation(parameters);
  if (query.startsWith("WITH candidates AS")) return recoverableMutations(parameters);
  if (query.includes("SET status = 'running'")) return claimedMutation(parameters);
  if (query.includes("SET checkpoint =")) return checkpointedMutation(parameters);
  if (query.includes("AND status = 'outcome_unknown'")) return reconciledMutation(parameters);
  if (query.includes("SET status = ?")) return finishedMutation(parameters);
  if (query.includes("resource_key = ?")) {
    const [projectRef, resourceKey] = parameters;
    return clonedRow([...mutationRows.values()].find((row) =>
      row.project_ref === projectRef && row.resource_key === resourceKey && ACTIVE_STATUSES.has(row.status)
    ));
  }
  const [projectRef, mutationId] = parameters;
  const row = mutationRows.get(mutationKey(String(projectRef), String(mutationId)));
  if (query.startsWith("SELECT mutation.*, clock_timestamp() AS database_now")) {
    return row ? [{ ...structuredClone(row), database_now: "2026-08-11T00:05:00.000Z" }] : [];
  }
  if (query.includes("lease_active")) {
    return row ? [{ ...structuredClone(row), lease_active: Date.parse(String(row.lease_expires_at)) > Date.now() }] : [];
  }
  if (query.includes("FROM project_mutations")) return clonedRow(row);
  throw new Error(`Unexpected mutation query: ${query}`);
});

Object.assign(database, {
  begin: async <T>(callback: (transaction: typeof database) => Promise<T>) => {
    const snapshot = structuredClone([...mutationRows.entries()]);
    try {
      return await callback(database);
    } catch (error) {
      mutationRows.clear();
      for (const [key, row] of snapshot) mutationRows.set(key, row);
      throw error;
    }
  },
  array: (values: unknown[]) => values,
});

mock.module("../../src/db", () => ({ sql: database }));

const mutationService = await import(
  new URL("../../src/services/project-mutation.service.ts?project-mutation-test", import.meta.url).href
);

function beginInput(overrides: Record<string, unknown> = {}) {
  return {
    projectRef: PROJECT_REF,
    mutationId: MUTATION_ID,
    operation: "scheduled_functions.create",
    requestFingerprint: mutationService.projectMutationFingerprint({ action: "create", name: "Nightly" }),
    principal: { type: "project" as const, id: `project:${PROJECT_REF}` },
    ...overrides,
  };
}

async function beginAndClaim() {
  await mutationService.beginProjectMutation(database as never, beginInput());
  return mutationService.claimOrResumeProjectMutation(database as never, {
    projectRef: PROJECT_REF,
    mutationId: MUTATION_ID,
    leaseOwner: "scheduled-worker",
    leaseToken: LEASE_TOKEN_A,
    leaseSeconds: 30,
  });
}

async function recordUnknownOutcome(): Promise<number> {
  const claim = await beginAndClaim();
  const fencingEpoch = claim.kind === "claimed" ? claim.mutation.fencingEpoch : 0;
  await mutationService.completeProjectMutationFailure(database as never, {
    projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseToken: LEASE_TOKEN_A,
    fencingEpoch, status: "outcome_unknown", failureCode: "PROVIDER_OUTCOME_UNKNOWN",
    responseStatus: 503,
  });
  return fencingEpoch;
}

describe("project mutation journal", () => {
  beforeEach(() => {
    mutationRows.clear();
    executedQueries.length = 0;
    leaseTokenSequence = 100;
    database.mockClear();
  });

  test("uses canonical full-request SHA-256 fingerprints", () => {
    const first = mutationService.projectMutationFingerprint({
      operation: "scheduled_functions.create", project_ref: "proj",
      mutation_id: "00000000-0000-4000-8000-000000000001",
      name: "夜班", slug: "worker", cron: "0 2 * * *", method: "POST",
      body: { z: null, a: [true, 2, "é"] }, headers: { "x-z": "last", "x-a": "first" },
    });
    const reordered = mutationService.projectMutationFingerprint({
      body: { a: [true, 2, "é"], z: null }, method: "POST",
      headers: { "x-a": "first", "x-z": "last" }, cron: "0 2 * * *",
      slug: "worker", name: "夜班",
      mutation_id: "00000000-0000-4000-8000-000000000001", project_ref: "proj",
      operation: "scheduled_functions.create",
    });
    const changed = mutationService.projectMutationFingerprint({
      operation: "scheduled_functions.create", project_ref: "proj",
      mutation_id: "00000000-0000-4000-8000-000000000001",
      name: "夜班", slug: "worker", cron: "0 2 * * *", method: "POST",
      body: { z: null, a: [true, 3, "é"] }, headers: { "x-z": "last", "x-a": "first" },
    });

    expect(first).toBe(reordered);
    expect(first).not.toBe(changed);
    expect(first).toBe("4ea6441de7a05686e3dada9aa2ca3cde155a42d4d7b459a9137c557c11261b80");
  });

  test.each([
    "body", "headers", "code", "secret", "token", "password", "credential_value",
    "jwt", "session", "signing_key",
  ])(
    "rejects nested sensitive projection key %s without reflecting its value",
    (sensitiveKey) => {
      const sentinel = "private-value-must-not-appear";
      let errorMessage = "";
      try {
        mutationService.assertPublicMutationPayload({ nested: { [sensitiveKey]: sentinel } });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      expect(errorMessage).toContain(sensitiveKey);
      expect(errorMessage).not.toContain(sentinel);
    },
  );

  test("allows explicitly public receipt metadata fields", () => {
    expect(() => mutationService.assertPublicMutationPayload({
      header_names: ["x-job-id"], body_empty: false, request_fingerprint: "a".repeat(64),
      failure_code: "PROVIDER_UNAVAILABLE", project_ref: PROJECT_REF,
    })).not.toThrow();
  });

  test("rejects an oversized public projection before persistence without reflecting content", () => {
    const oversizedSentinel = `private-oversized-${"x".repeat(70_000)}`;
    const queryCount = executedQueries.length;
    let errorMessage = "";
    try {
      mutationService.assertPublicMutationPayload({ summary: oversizedSentinel });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toBe("Mutation public projection exceeds 64 KiB");
    expect(errorMessage).not.toContain(oversizedSentinel.slice(0, 32));
    expect(executedQueries).toHaveLength(queryCount);
  });

  test("replays the same fingerprint and rejects ID reuse with changed request or principal", async () => {
    const started = await mutationService.beginProjectMutation(database as never, beginInput());
    const replay = await mutationService.beginProjectMutation(database as never, beginInput());
    const changed = await mutationService.beginProjectMutation(database as never, beginInput({
      requestFingerprint: "a".repeat(64),
    }));
    const otherPrincipal = await mutationService.beginProjectMutation(database as never, beginInput({
      principal: { type: "admin", id: "admin" },
    }));

    expect(started.kind).toBe("started");
    expect(replay.kind).toBe("replay");
    expect(changed).toEqual({ kind: "fingerprint_conflict" });
    expect(otherPrincipal).toEqual({ kind: "principal_conflict" });
  });

  test("serializes structured resource identities into one canonical lock key", async () => {
    const resource = { type: "edge-function", id: "夜班/worker" };
    const expectedKey = "v1/edge-function/5aSc54-tL3dvcmtlcg";
    await mutationService.beginProjectMutation(database as never, beginInput({ resource }));
    const blocked = await mutationService.beginProjectMutation(database as never, beginInput({
      mutationId: OTHER_MUTATION_ID,
      resource,
      requestFingerprint: "b".repeat(64),
    }));

    expect(mutationService.projectMutationResourceKey(resource)).toBe(expectedKey);
    expect(mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))?.resource_key).toBe(expectedKey);
    expect(blocked).toEqual({ kind: "resource_busy", mutationId: MUTATION_ID, status: "pending" });
  });

  test.each(["\ud800", "\udfff"])(
    "rejects the non-canonical UTF-8 resource id %p before persistence",
    async (resourceId) => {
      const queryCount = executedQueries.length;

      await expect(mutationService.beginProjectMutation(database as never, beginInput({
        resource: { type: "edge-function", id: resourceId },
      }))).rejects.toThrow("well-formed Unicode");

      expect(executedQueries).toHaveLength(queryCount);
    },
  );

  test.each([
    ["C0 control-character", "\u0001"],
    ["DEL control-character", "\u007f"],
    ["C1 NEL control-character", "\u0085"],
    ["C1 APC control-character", "\u009f"],
  ])(
    "rejects the %s resource id before persistence",
    async (_case, resourceId) => {
      const queryCount = executedQueries.length;

      await expect(mutationService.beginProjectMutation(database as never, beginInput({
        resource: { type: "edge-function", id: `worker${resourceId}` },
      }))).rejects.toThrow("Mutation resource id is invalid");

      expect(executedQueries).toHaveLength(queryCount);
    },
  );

  test("keeps well-formed Unicode resource ids injective through the 128-byte boundary", () => {
    const replacementKey = mutationService.projectMutationResourceKey({ type: "edge-function", id: "\ufffd" });
    const astralKey = mutationService.projectMutationResourceKey({ type: "edge-function", id: "😀" });
    const boundaryId = "界".repeat(42) + "é";

    expect(Buffer.byteLength(boundaryId, "utf8")).toBe(128);
    expect(replacementKey).not.toBe(astralKey);
    expect(mutationService.projectMutationResourceKey({ type: "edge-function", id: boundaryId }))
      .toMatch(/^v1\/edge-function\/[A-Za-z0-9_-]{171}$/);
    expect(() => mutationService.projectMutationResourceKey({ type: "edge-function", id: `${boundaryId}a` }))
      .toThrow("exceeds 128 bytes");
  });

  test("rejects legacy raw resource keys before persistence", async () => {
    const queryCount = executedQueries.length;

    await expect(mutationService.beginProjectMutation(database as never, beginInput({
      resourceKey: "edge-function:worker",
    }))).rejects.toThrow("structured resource contract");

    expect(executedQueries).toHaveLength(queryCount);
  });

  test("uses lease takeover fencing to reject a stale worker checkpoint", async () => {
    const firstClaim = await beginAndClaim();
    const firstEpoch = firstClaim.kind === "claimed" ? firstClaim.mutation.fencingEpoch : 0;
    mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))!.lease_expires_at = "2026-08-10T00:00:00.000Z";
    const takeover = await mutationService.claimOrResumeProjectMutation(database as never, {
      projectRef: PROJECT_REF,
      mutationId: MUTATION_ID,
      leaseOwner: "replacement-worker",
      leaseToken: LEASE_TOKEN_B,
      leaseSeconds: 30,
    });
    const takeoverEpoch = takeover.kind === "claimed" ? takeover.mutation.fencingEpoch : 0;
    const staleWrite = await mutationService.checkpointProjectMutation(database as never, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseToken: LEASE_TOKEN_A,
      fencingEpoch: firstEpoch, leaseSeconds: 30, checkpoint: { phase: "stale" },
    });
    const currentWrite = await mutationService.checkpointProjectMutation(database as never, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseToken: LEASE_TOKEN_B,
      fencingEpoch: takeoverEpoch, leaseSeconds: 30, checkpoint: { phase: "preheated" },
    });

    expect(takeoverEpoch).toBe(firstEpoch + 1);
    expect(staleWrite).toBe("lease_lost");
    expect(currentWrite).toBe("updated");
  });

  test("rejects checkpoint and completion after lease expiry before any takeover", async () => {
    const firstClaim = await beginAndClaim();
    const fencingEpoch = firstClaim.kind === "claimed" ? firstClaim.mutation.fencingEpoch : 0;
    const row = mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))!;
    row.lease_expires_at = "2026-08-10T00:00:00.000Z";

    const checkpoint = await mutationService.checkpointProjectMutation(database as never, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseToken: LEASE_TOKEN_A,
      fencingEpoch, leaseSeconds: 30, checkpoint: { phase: "stale" },
    });
    const completion = await mutationService.completeProjectMutationSuccess(database as never, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseToken: LEASE_TOKEN_A,
      fencingEpoch, responseStatus: 200, receipt: { created: true },
    });

    expect(checkpoint).toBe("lease_lost");
    expect(completion).toBe("lease_lost");
    expect(row).toMatchObject({ status: "running", checkpoint: {}, receipt: null });
    const leaseWrites = executedQueries.filter((query) =>
      query.includes("SET checkpoint =") || query.includes("SET status = ?")
    );
    expect(leaseWrites.every((query) => query.includes("lease_expires_at > clock_timestamp()"))).toBe(true);
  });

  test("atomically claims only due exact-operation rows within the requested limit", async () => {
    const exactFirst = "00000000-0000-4000-8000-000000000010";
    const exactSecond = "00000000-0000-4000-8000-000000000011";
    const prefixedOperation = "00000000-0000-4000-8000-000000000012";
    const unknownOutcome = "00000000-0000-4000-8000-000000000013";
    const immediateRecovery = "00000000-0000-4000-8000-000000000014";
    for (const [mutationId, operation] of [
      [exactFirst, "scheduled_functions.create"], [exactSecond, "scheduled_functions.create"],
      [prefixedOperation, "scheduled_functions.create.child"], [unknownOutcome, "scheduled_functions.create"],
      [immediateRecovery, "scheduled_functions.create"],
    ]) {
      await mutationService.beginProjectMutation(database as never, beginInput({ mutationId, operation }));
    }
    mutationRows.get(mutationKey(PROJECT_REF, exactFirst))!.recovery_not_before = "2026-08-10T00:00:00.000Z";
    mutationRows.get(mutationKey(PROJECT_REF, exactSecond))!.recovery_not_before = "2026-08-10T00:00:01.000Z";
    mutationRows.get(mutationKey(PROJECT_REF, prefixedOperation))!.recovery_not_before = "2026-08-10T00:00:00.000Z";
    Object.assign(mutationRows.get(mutationKey(PROJECT_REF, unknownOutcome))!, {
      status: "outcome_unknown", recovery_not_before: "2026-08-10T00:00:00.000Z",
      completed_at: "2026-08-10T00:00:00.000Z",
    });

    const claimed = await mutationService.claimRecoverableProjectMutations({
      operations: ["scheduled_functions.create"], leaseOwner: "recovery-worker",
      leaseSeconds: 30, limit: 1,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.mutationId).toBe(exactFirst);
    expect(Object.keys(claimed[0]!).sort()).toEqual([
      "checkpoint", "fencingEpoch", "leaseExpiresAt", "leaseToken", "mutationId", "operation",
      "projectRef", "recoveryNotBefore", "resourceKey",
    ]);
    expect(mutationRows.get(mutationKey(PROJECT_REF, exactSecond))?.status).toBe("pending");
    expect(mutationRows.get(mutationKey(PROJECT_REF, prefixedOperation))?.status).toBe("pending");
    expect(mutationRows.get(mutationKey(PROJECT_REF, unknownOutcome))?.status).toBe("outcome_unknown");
    expect(mutationRows.get(mutationKey(PROJECT_REF, immediateRecovery))).toMatchObject({
      status: "pending",
      recovery_not_before: expect.any(String),
    });
    const claimQuery = executedQueries.find((query) => query.startsWith("WITH candidates AS"))!;
    expect(claimQuery).toContain("operation = ANY(?)");
    expect(claimQuery).toContain("FOR UPDATE SKIP LOCKED");
    expect(claimQuery).toContain("ORDER BY recovery_not_before ASC, updated_at ASC, project_ref ASC, mutation_id ASC");
    expect(claimQuery).not.toContain("LIKE");
  });

  test("concurrent recovery scanners receive disjoint fenced claims", async () => {
    const firstId = "00000000-0000-4000-8000-000000000020";
    const secondId = "00000000-0000-4000-8000-000000000021";
    for (const mutationId of [firstId, secondId]) {
      await mutationService.beginProjectMutation(database as never, beginInput({ mutationId }));
      mutationRows.get(mutationKey(PROJECT_REF, mutationId))!.recovery_not_before = "2026-08-10T00:00:00.000Z";
    }
    const claimInput = {
      operations: ["scheduled_functions.create"], leaseSeconds: 30, limit: 1,
    } as const;
    const [scannerA, scannerB] = await Promise.all([
      mutationService.claimRecoverableProjectMutations({ ...claimInput, leaseOwner: "scanner-a" }),
      mutationService.claimRecoverableProjectMutations({ ...claimInput, leaseOwner: "scanner-b" }),
    ]);
    const claimedIds = [...scannerA, ...scannerB].map((claim) => claim.mutationId);

    expect(claimedIds).toHaveLength(2);
    expect(new Set(claimedIds).size).toBe(2);
    expect(new Set([...scannerA, ...scannerB].map((claim) => claim.leaseToken)).size).toBe(2);
  });

  test("rejects wildcard operations and unbounded recovery batches before querying", async () => {
    const queryCount = executedQueries.length;
    await expect(mutationService.claimRecoverableProjectMutations({
      operations: ["scheduled_functions.*"], leaseOwner: "scanner-a", leaseSeconds: 30, limit: 1,
    })).rejects.toThrow("exact operation names");
    await expect(mutationService.claimRecoverableProjectMutations({
      operations: ["scheduled_functions.create"], leaseOwner: "scanner-a", leaseSeconds: 30, limit: 101,
    })).rejects.toThrow("limit must be 1-100");
    expect(executedQueries).toHaveLength(queryCount);
  });

  test("fails closed when a recoverable checkpoint contains a sensitive field", async () => {
    const privateSentinel = "recovery-checkpoint-private-value";
    await mutationService.beginProjectMutation(database as never, beginInput());
    Object.assign(mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))!, {
      recovery_not_before: "2026-08-10T00:00:00.000Z",
      checkpoint: { stage: { token: privateSentinel } },
    });
    let errorMessage = "";

    try {
      await mutationService.claimRecoverableProjectMutations({
        operations: ["scheduled_functions.create"], leaseOwner: "scanner-a",
        leaseSeconds: 30, limit: 1,
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain("token");
    expect(errorMessage).not.toContain(privateSentinel);
  });

  test("fails closed when status readback encounters an unsafe stored projection", async () => {
    const privateSentinel = "stored-status-private-value";
    await mutationService.beginProjectMutation(database as never, beginInput());
    mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))!.checkpoint = {
      nested: { token: privateSentinel },
    };
    let errorMessage = "";

    try {
      await mutationService.readProjectMutation({ projectRef: PROJECT_REF, mutationId: MUTATION_ID });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain("token");
    expect(errorMessage).not.toContain(privateSentinel);
  });

  test("recovery scanner fences an expired lease and leaves an active lease untouched", async () => {
    const expiredId = "00000000-0000-4000-8000-000000000030";
    const activeId = "00000000-0000-4000-8000-000000000031";
    for (const mutationId of [expiredId, activeId]) {
      await mutationService.beginProjectMutation(database as never, beginInput({ mutationId }));
      const row = mutationRows.get(mutationKey(PROJECT_REF, mutationId))!;
      Object.assign(row, {
        status: "running", recovery_not_before: "2026-08-10T00:00:00.000Z",
        lease_owner: "original-worker", lease_token: LEASE_TOKEN_A, fencing_epoch: 3,
      });
    }
    mutationRows.get(mutationKey(PROJECT_REF, expiredId))!.lease_expires_at = "2026-08-10T00:00:00.000Z";
    mutationRows.get(mutationKey(PROJECT_REF, activeId))!.lease_expires_at = "2099-08-10T00:00:00.000Z";

    const claimed = await mutationService.claimRecoverableProjectMutations({
      operations: ["scheduled_functions.create"], leaseOwner: "replacement-worker",
      leaseSeconds: 30, limit: 10,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ mutationId: expiredId, fencingEpoch: 4 });
    expect(claimed[0]?.leaseToken).not.toBe(LEASE_TOKEN_A);
    expect(mutationRows.get(mutationKey(PROJECT_REF, activeId))).toMatchObject({
      lease_owner: "original-worker", lease_token: LEASE_TOKEN_A, fencing_epoch: 3,
    });
  });

  test("persists a terminal safe receipt and reads it back without the lease token", async () => {
    const claim = await beginAndClaim();
    const fencingEpoch = claim.kind === "claimed" ? claim.mutation.fencingEpoch : 0;
    const completed = await mutationService.completeProjectMutationSuccess(database as never, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseToken: LEASE_TOKEN_A, fencingEpoch,
      responseStatus: 200, receipt: { project_ref: PROJECT_REF, created: true },
    });
    const readback = await mutationService.readProjectMutation({ projectRef: PROJECT_REF, mutationId: MUTATION_ID });
    const publicReadback = mutationService.publicProjectMutation(readback!);

    expect(completed).toBe("updated");
    expect(readback).toMatchObject({ status: "succeeded", receipt: { created: true }, responseStatus: 200 });
    expect(JSON.stringify(publicReadback)).not.toContain(LEASE_TOKEN_A);
    expect(publicReadback).toMatchObject({ mutation_id: MUTATION_ID, status: "succeeded" });
  });

  test.each([null, 199, 200.5, 300, 500] as const)(
    "rejects succeeded response status %s before updating the journal",
    async (responseStatus) => {
      const claim = await beginAndClaim();
      const fencingEpoch = claim.kind === "claimed" ? claim.mutation.fencingEpoch : 0;
      const queryCount = executedQueries.length;

      await expect(mutationService.completeProjectMutationSuccess(database as never, {
        projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseToken: LEASE_TOKEN_A, fencingEpoch,
        responseStatus: responseStatus as number, receipt: {},
      })).rejects.toThrow("Mutation response status is invalid");

      expect(executedQueries).toHaveLength(queryCount);
      expect(mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))?.status).toBe("running");
    },
  );

  test("rolls a retryable failure into a new fenced lease", async () => {
    const claim = await beginAndClaim();
    const firstEpoch = claim.kind === "claimed" ? claim.mutation.fencingEpoch : 0;
    const retryAfter = "2099-08-11T00:00:00.000Z";
    await mutationService.completeProjectMutationFailure(database as never, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseToken: LEASE_TOKEN_A,
      fencingEpoch: firstEpoch, status: "failed_retryable", failureCode: "DATABASE_UNAVAILABLE",
      recoveryNotBefore: retryAfter,
    });
    const automaticRetry = await mutationService.claimRecoverableProjectMutations({
      operations: ["scheduled_functions.create"], leaseOwner: "automatic-retry-worker",
      leaseSeconds: 30, limit: 1,
    });
    const resumed = await mutationService.claimOrResumeProjectMutation(database as never, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseOwner: "retry-worker",
      leaseToken: LEASE_TOKEN_B, leaseSeconds: 30,
    });

    expect(automaticRetry).toEqual([]);
    expect(mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))?.recovery_not_before)
      .toEqual(new Date(retryAfter));
    expect(resumed.kind).toBe("claimed");
    if (resumed.kind === "claimed") expect(resumed.mutation.fencingEpoch).toBe(firstEpoch + 1);
  });

  test("rejects a private receipt before any journal update", async () => {
    const privateSentinel = "private-body-sentinel";
    const claim = await beginAndClaim();
    const fencingEpoch = claim.kind === "claimed" ? claim.mutation.fencingEpoch : 0;
    const queryCount = executedQueries.length;

    await expect(mutationService.completeProjectMutationSuccess(database as never, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseToken: LEASE_TOKEN_A, fencingEpoch,
      responseStatus: 200, receipt: { schedule: { body: { private: privateSentinel } } },
    })).rejects.toThrow("body");
    expect(executedQueries).toHaveLength(queryCount);
    expect(JSON.stringify([...mutationRows.values()])).not.toContain(privateSentinel);
  });

  test("reconciles only an observed outcome-unknown epoch with hashed evidence", async () => {
    const fencingEpoch = await recordUnknownOutcome();
    const evidenceFingerprint = "c".repeat(64);

    const reconciled = await mutationService.reconcileProjectMutation(database as never, beginInput().principal, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, expectedFencingEpoch: fencingEpoch,
      status: "succeeded", responseStatus: 200,
      evidence: {
        source: "scheduled_functions.provider_readback",
        observedAt: "2026-08-11T00:00:01.000Z",
        evidenceCode: "RESOURCE_PRESENT",
        evidenceFingerprint,
      },
    });

    expect(reconciled.kind).toBe("updated");
    expect(mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))).toMatchObject({
      status: "succeeded",
      response_status: 200,
      failure_code: null,
      receipt: {
        reconciliation: {
          source: "scheduled_functions.provider_readback",
          evidence_code: "RESOURCE_PRESENT",
          evidence_fingerprint: evidenceFingerprint,
          target_status: "succeeded",
        },
      },
    });
  });

  test("rejects stale reconciliation epochs and non-unknown states without mutation", async () => {
    const fencingEpoch = await recordUnknownOutcome();
    const evidence = {
      source: "scheduled_functions.provider_readback",
      observedAt: "2026-08-11T00:00:01.000Z",
      evidenceCode: "RESOURCE_ABSENT",
      evidenceFingerprint: "d".repeat(64),
    };
    const stale = await mutationService.reconcileProjectMutation(database as never, beginInput().principal, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, expectedFencingEpoch: fencingEpoch + 1,
      status: "failed_terminal", responseStatus: 404, failureCode: "RESOURCE_NOT_FOUND", evidence,
    });
    const current = mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))!;
    current.status = "failed_terminal";
    const repeated = await mutationService.reconcileProjectMutation(database as never, beginInput().principal, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, expectedFencingEpoch: fencingEpoch,
      status: "failed_terminal", responseStatus: 404, failureCode: "RESOURCE_NOT_FOUND", evidence,
    });

    expect(stale.kind).toBe("cas_conflict");
    expect(repeated.kind).toBe("not_reconcilable");
    expect(current.receipt).toEqual({});
  });

  test.each([
    [{ type: "admin" as const, id: "admin" }, { type: "project" as const, id: `project:${PROJECT_REF}` }],
    [{ type: "master" as const, id: "master" }, { type: "admin" as const, id: "admin" }],
  ])("allows only the exact %s journal principal to reconcile", async (owner, otherActor) => {
    const fencingEpoch = await recordUnknownOutcome();
    const row = mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))!;
    Object.assign(row, { principal_type: owner.type, principal_id: owner.id });
    const reconciliation = {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, expectedFencingEpoch: fencingEpoch,
      status: "succeeded" as const, responseStatus: 200,
      evidence: {
        source: "scheduled_functions.provider_readback",
        observedAt: "2026-08-11T00:00:01.000Z",
        evidenceCode: "RESOURCE_PRESENT",
        evidenceFingerprint: "e".repeat(64),
      },
    };

    const forbidden = await mutationService.reconcileProjectMutation(database as never, otherActor, reconciliation);
    const allowed = await mutationService.reconcileProjectMutation(database as never, owner, reconciliation);

    expect(forbidden).toEqual({ kind: "forbidden" });
    expect(allowed.kind).toBe("updated");
  });

  test.each([
    "2026-08-11T00:00:00.999Z",
    "2026-08-11T00:10:00.001Z",
  ])("rejects reconciliation evidence outside the database-clock window: %s", async (observedAt) => {
    const fencingEpoch = await recordUnknownOutcome();

    const reconciliation = await mutationService.reconcileProjectMutation(
      database as never,
      beginInput().principal,
      {
        projectRef: PROJECT_REF, mutationId: MUTATION_ID, expectedFencingEpoch: fencingEpoch,
        status: "succeeded", responseStatus: 200,
        evidence: {
          source: "scheduled_functions.provider_readback", observedAt,
          evidenceCode: "RESOURCE_PRESENT", evidenceFingerprint: "f".repeat(64),
        },
      },
    );

    expect(reconciliation).toEqual({ kind: "invalid_evidence_time" });
    expect(mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))?.status).toBe("outcome_unknown");
  });

  test("fails closed instead of incrementing beyond the safe fencing epoch", async () => {
    await mutationService.beginProjectMutation(database as never, beginInput());
    const row = mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))!;
    row.fencing_epoch = Number.MAX_SAFE_INTEGER;

    await expect(mutationService.claimOrResumeProjectMutation(database as never, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseOwner: "scanner-a",
      leaseToken: LEASE_TOKEN_A, leaseSeconds: 30,
    })).rejects.toThrow("fencing epoch is exhausted");

    expect(row.fencing_epoch).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("preserves active lease ownership at the safe fencing epoch ceiling", async () => {
    await beginAndClaim();
    const row = mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))!;
    row.fencing_epoch = Number.MAX_SAFE_INTEGER;
    row.lease_expires_at = new Date(Date.now() + 60_000).toISOString();

    const resumed = await mutationService.claimOrResumeProjectMutation(database as never, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseOwner: "scheduled-worker",
      leaseToken: LEASE_TOKEN_A, leaseSeconds: 30,
    });
    const competing = await mutationService.claimOrResumeProjectMutation(database as never, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseOwner: "competing-worker",
      leaseToken: LEASE_TOKEN_B, leaseSeconds: 30,
    });

    expect(resumed.kind).toBe("claimed");
    expect(competing.kind).toBe("busy");
    expect(row.fencing_epoch).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("reports an exhausted fencing epoch after a running lease expires", async () => {
    await beginAndClaim();
    const row = mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))!;
    row.fencing_epoch = Number.MAX_SAFE_INTEGER;
    row.lease_expires_at = "2026-08-10T00:00:00.000Z";

    await expect(mutationService.claimOrResumeProjectMutation(database as never, {
      projectRef: PROJECT_REF, mutationId: MUTATION_ID, leaseOwner: "replacement-worker",
      leaseToken: LEASE_TOKEN_B, leaseSeconds: 30,
    })).rejects.toThrow("fencing epoch is exhausted");

    expect(row).toMatchObject({
      status: "running",
      fencing_epoch: Number.MAX_SAFE_INTEGER,
      lease_token: LEASE_TOKEN_A,
    });
  });

  test("rolls back a recovery scan that encounters a legacy raw resource key", async () => {
    await mutationService.beginProjectMutation(database as never, beginInput());
    const row = mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID))!;
    row.resource_key = "legacy:scheduled-function:nightly";
    row.recovery_not_before = "2026-08-10T00:00:00.000Z";

    await expect(mutationService.claimRecoverableProjectMutations({
      operations: ["scheduled_functions.create"], leaseOwner: "scanner-a",
      leaseSeconds: 30, limit: 1,
    })).rejects.toThrow("Stored mutation resource key is invalid");

    expect(mutationRows.get(mutationKey(PROJECT_REF, MUTATION_ID)))
      .toMatchObject({ status: "pending", fencing_epoch: 0, lease_token: null });
  });
});
