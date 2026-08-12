import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const MUTATION_ID = "00000000-0000-4000-8000-000000000001";
const LEASE_TOKEN_SENTINEL = "00000000-0000-4000-8000-000000000099";
const JOURNAL_PAYLOAD_SENTINEL = "stored-journal-payload-must-not-be-public";
const readMutation = mock(() => Promise.resolve(null));
const reconcileMutation = mock(() => Promise.resolve({ kind: "not_found" as const }));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(undefined));
const verifiedPrincipal = mock(() => Promise.resolve({ type: "project" as const, id: "project:proj_1" }));

const mutationService = await import("../../src/services/project-mutation.service");
const reconciliationService = await import("../../src/services/project-mutation-reconciliation.service");
const authModule = await import("../../src/middleware/auth");
const { logger } = await import("../../src/utils/logger");
const { validationErrorResponse } = await import("../../src/utils/http-validation");
const readMutationSpy = spyOn(mutationService, "readProjectMutation").mockImplementation(
  readMutation as typeof mutationService.readProjectMutation,
);
const reconcileMutationSpy = spyOn(reconciliationService, "reconcileProjectMutationWithAudit").mockImplementation(
  reconcileMutation as typeof reconciliationService.reconcileProjectMutationWithAudit,
);
const authSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const principalSpy = spyOn(authModule, "getVerifiedRequestPrincipal").mockImplementation(
  verifiedPrincipal as typeof authModule.getVerifiedRequestPrincipal,
);
const loggerErrorSpy = spyOn(logger, "error");
const { projectMutationRoutes } = await import("../../src/routes/project-mutations");
const app = new Elysia().use(projectMutationRoutes);
const validationApp = new Elysia()
  .onError(({ code, error, set }) => {
    if (code === "VALIDATION") return validationErrorResponse(set);
    logger.error(`test error [${code}]`, error);
  })
  .use(projectMutationRoutes);

function mutationState() {
  return {
    projectRef: "proj_1",
    mutationId: MUTATION_ID,
    operation: "scheduled_functions.create",
    resourceKey: null,
    requestFingerprint: "a".repeat(64),
    principal: { type: "project" as const, id: "project:proj_1" },
    status: "succeeded" as const,
    checkpoint: { arbitrary_checkpoint: JOURNAL_PAYLOAD_SENTINEL },
    receipt: { arbitrary_receipt: JOURNAL_PAYLOAD_SENTINEL },
    responseStatus: 200,
    failureCode: null,
    leaseOwner: null,
    leaseToken: LEASE_TOKEN_SENTINEL,
    leaseExpiresAt: null,
    fencingEpoch: 1,
    completedAt: "2026-08-11T00:00:01.000Z",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:01.000Z",
  };
}

function request(path: string, init: RequestInit = {}, target = app): Promise<Response> {
  return target.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      authorization: "Bearer test",
      "x-request-id": "mutation-route-request",
      "user-agent": "mutation-route-test",
    },
  }));
}

describe("project mutation status route", () => {
  afterAll(() => {
    readMutationSpy.mockRestore();
    reconcileMutationSpy.mockRestore();
    authSpy.mockRestore();
    principalSpy.mockRestore();
    loggerErrorSpy.mockRestore();
  });

  beforeEach(() => {
    readMutation.mockReset();
    readMutation.mockResolvedValue(null);
    reconcileMutation.mockReset();
    reconcileMutation.mockResolvedValue({ kind: "not_found" });
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(undefined);
    verifiedPrincipal.mockReset();
    verifiedPrincipal.mockResolvedValue({ type: "project", id: "project:proj_1" });
  });

  test("returns only fixed metadata and empty journal projections", async () => {
    readMutation.mockResolvedValue(mutationState());

    const response = await request(`/v1/projects/proj_1/mutations/${MUTATION_ID}`);
    const responseText = await response.text();
    const payload = JSON.parse(responseText);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      project_ref: "proj_1",
      mutation: {
        mutation_id: MUTATION_ID,
        operation: "scheduled_functions.create",
        status: "succeeded",
        response_status: 200,
        checkpoint: {},
        receipt: {},
        lease: { fencing_epoch: 1 },
      },
    });
    expect(Object.keys(payload).sort()).toEqual(["mutation", "project_ref"]);
    expect(responseText).not.toContain(LEASE_TOKEN_SENTINEL);
    expect(responseText).not.toContain(JOURNAL_PAYLOAD_SENTINEL);
  });

  test("returns 404 for an unknown project mutation", async () => {
    const response = await request(`/v1/projects/proj_1/mutations/${MUTATION_ID}`);

    expect(response.status).toBe(404);
  });

  test("rejects invalid mutation IDs without a database read", async () => {
    const response = await request("/v1/projects/proj_1/mutations/not-a-uuid");

    expect(response.status).toBe(400);
    expect(readMutation).not.toHaveBeenCalled();
  });

  test("preserves project authorization on status readback", async () => {
    requireProjectOrAdminAuth.mockResolvedValue({ status: 403, body: { error: "forbidden" } });

    const response = await request(`/v1/projects/proj_1/mutations/${MUTATION_ID}`);

    expect(response.status).toBe(403);
    expect(readMutation).not.toHaveBeenCalled();
  });

  test("reconciles an unknown outcome with fenced hashed evidence and a redacted response", async () => {
    const succeeded = { ...mutationState(), receipt: { evidence: JOURNAL_PAYLOAD_SENTINEL } };
    reconcileMutation.mockResolvedValue({ kind: "updated", mutation: succeeded });
    const body = {
      expected_fencing_epoch: 1,
      status: "succeeded",
      response_status: 200,
      evidence: {
        source: "scheduled_functions.provider_readback",
        observed_at: "2026-08-11T00:00:01.000Z",
        evidence_code: "RESOURCE_PRESENT",
        evidence_fingerprint: "b".repeat(64),
      },
    };

    const response = await request(`/v1/projects/proj_1/mutations/${MUTATION_ID}/reconcile`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(reconcileMutation).toHaveBeenCalledWith({
      actor: { type: "project", id: "project:proj_1" },
      requestId: "mutation-route-request",
      ipAddress: "unknown",
      userAgent: "mutation-route-test",
      mutation: {
        projectRef: "proj_1", mutationId: MUTATION_ID, expectedFencingEpoch: 1,
        status: "succeeded", responseStatus: 200, failureCode: undefined,
        evidence: {
          source: body.evidence.source,
          observedAt: body.evidence.observed_at,
          evidenceCode: body.evidence.evidence_code,
          evidenceFingerprint: body.evidence.evidence_fingerprint,
        },
      },
    });
    expect(responseText).toContain('"status":"succeeded"');
    expect(responseText).not.toContain(JOURNAL_PAYLOAD_SENTINEL);
  });

  test("requires project authorization before reconciliation", async () => {
    requireProjectOrAdminAuth.mockResolvedValue({ status: 403, body: { error: "forbidden" } });

    const response = await request(`/v1/projects/proj_1/mutations/${MUTATION_ID}/reconcile`, {
      method: "POST",
      body: JSON.stringify({
        expected_fencing_epoch: 1,
        status: "failed_terminal",
        response_status: 404,
        failure_code: "RESOURCE_NOT_FOUND",
        evidence: {
          source: "scheduled_functions.provider_readback",
          observed_at: "2026-08-11T00:00:01.000Z",
          evidence_code: "RESOURCE_ABSENT",
          evidence_fingerprint: "c".repeat(64),
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(reconcileMutation).not.toHaveBeenCalled();
  });

  test("returns the same state-free 403 when the authenticated principal does not own the journal", async () => {
    reconcileMutation.mockResolvedValue({ kind: "forbidden" });

    const response = await request(`/v1/projects/proj_1/mutations/${MUTATION_ID}/reconcile`, {
      method: "POST",
      body: JSON.stringify({
        expected_fencing_epoch: 1,
        status: "failed_terminal",
        response_status: 404,
        failure_code: "RESOURCE_NOT_FOUND",
        evidence: {
          source: "scheduled_functions.provider_readback",
          observed_at: "2026-08-11T00:00:01.000Z",
          evidence_code: "RESOURCE_ABSENT",
          evidence_fingerprint: "d".repeat(64),
        },
      }),
      headers: { "content-type": "application/json" },
    });
    const responseText = await response.text();

    expect(response.status).toBe(403);
    expect(JSON.parse(responseText)).toEqual({ error: "Mutation reconciliation is not permitted" });
    expect(responseText).not.toContain("outcome_unknown");
    expect(responseText).not.toContain("failed_terminal");
  });

  test.each([
    ["source", "private-source-sentinel", { evidence: { source: "private-source-sentinel/invalid" } }],
    ["code", "private-code-sentinel", { evidence: { evidence_code: "private-code-sentinel" } }],
    ["fingerprint", "private-fingerprint-sentinel", {
      evidence: { evidence_fingerprint: "private-fingerprint-sentinel" },
    }],
    ["type", "private-type-sentinel", { status: "private-type-sentinel" }],
    ["extra field", "private-extra-field-sentinel", { "private-extra-field-sentinel": true }],
    ["extra evidence field", "private-evidence-extra-sentinel", {
      evidence: { "private-evidence-extra-sentinel": true },
    }],
  ])("rejects an invalid reconciliation %s without response or log reflection", async (_field, sentinel, override) => {
    const baseBody = {
      expected_fencing_epoch: 1,
      status: "succeeded",
      response_status: 200,
      evidence: {
        source: "scheduled_functions.provider_readback",
        observed_at: "2026-08-11T00:00:01.000Z",
        evidence_code: "RESOURCE_PRESENT",
        evidence_fingerprint: "e".repeat(64),
      },
    };
    const evidenceOverride = "evidence" in override ? override.evidence : undefined;
    const body = {
      ...baseBody,
      ...override,
      evidence: { ...baseBody.evidence, ...evidenceOverride },
    };
    loggerErrorSpy.mockClear();
    const response = await request(`/v1/projects/proj_1/mutations/${MUTATION_ID}/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, validationApp);
    const responseText = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(responseText)).toEqual({ message: "Validation failed", code: "VALIDATION_ERROR" });
    expect(responseText).not.toContain(sentinel);
    expect(JSON.stringify(loggerErrorSpy.mock.calls)).not.toContain(sentinel);
    expect(reconcileMutation).not.toHaveBeenCalled();
  });

  test("rejects an unsafe fencing epoch with a fixed response before reconciliation", async () => {
    const unsafeEpoch = Number.MAX_SAFE_INTEGER + 1;
    const response = await request(`/v1/projects/proj_1/mutations/${MUTATION_ID}/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_fencing_epoch: unsafeEpoch,
        status: "succeeded",
        response_status: 200,
        evidence: {
          source: "scheduled_functions.provider_readback",
          observed_at: "2026-08-11T00:00:01.000Z",
          evidence_code: "RESOURCE_PRESENT",
          evidence_fingerprint: "f".repeat(64),
        },
      }),
    }, validationApp);
    const responseText = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(responseText)).toEqual({ message: "Validation failed", code: "VALIDATION_ERROR" });
    expect(responseText).not.toContain(String(unsafeEpoch));
    expect(reconcileMutation).not.toHaveBeenCalled();
  });
});
