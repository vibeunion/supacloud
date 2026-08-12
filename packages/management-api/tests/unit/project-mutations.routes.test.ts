import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const MUTATION_ID = "00000000-0000-4000-8000-000000000001";
const LEASE_TOKEN_SENTINEL = "00000000-0000-4000-8000-000000000099";
const JOURNAL_PAYLOAD_SENTINEL = "stored-journal-payload-must-not-be-public";
const readMutation = mock(() => Promise.resolve(null));
const reconcileMutation = mock(() => Promise.resolve({ kind: "not_found" as const }));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(undefined));

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
      authorization: "Bearer test",
      "x-request-id": "mutation-route-request",
      "user-agent": "mutation-route-test",
      ...Object.fromEntries(new Headers(init.headers)),
    },
  }));
}

describe("project mutation status route", () => {
  afterAll(() => {
    readMutationSpy.mockRestore();
    reconcileMutationSpy.mockRestore();
    authSpy.mockRestore();
    loggerErrorSpy.mockRestore();
  });

  beforeEach(() => {
    readMutation.mockReset();
    readMutation.mockResolvedValue(null);
    reconcileMutation.mockReset();
    reconcileMutation.mockResolvedValue({ kind: "not_found" });
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(undefined);
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

  test.each([
    ["project", "project-service-role"],
    ["admin", "admin-token"],
    ["master", "master-token"],
  ])("returns the same fixed 403 for an authenticated %s caller", async (_role, credential) => {
    const response = await request(`/v1/projects/proj_1/mutations/${MUTATION_ID}/reconcile`, {
      method: "POST",
      body: JSON.stringify({ status: "succeeded" }),
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Mutation reconciliation is not permitted" });
    expect(requireProjectOrAdminAuth).not.toHaveBeenCalled();
    expect(readMutation).not.toHaveBeenCalled();
    expect(reconcileMutation).not.toHaveBeenCalled();
  });

  test("returns the fixed denial without authenticating an anonymous caller", async () => {
    const response = await app.handle(new Request(
      `http://localhost/v1/projects/proj_1/mutations/${MUTATION_ID}/reconcile`, {
        method: "POST",
        body: "private-unauthenticated-body-sentinel",
        headers: { "content-type": "application/json" },
      },
    ));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Mutation reconciliation is not permitted" });
    expect(requireProjectOrAdminAuth).not.toHaveBeenCalled();
    expect(readMutation).not.toHaveBeenCalled();
    expect(reconcileMutation).not.toHaveBeenCalled();
  });

  test.each([
    ["valid JSON", "private-valid-body-sentinel", '{"private-valid-body-sentinel":true}'],
    ["malformed JSON", "private-malformed-body-sentinel", '{"private-malformed-body-sentinel"'],
  ])("does not parse or reflect a %s reconciliation body", async (_shape, sentinel, body) => {
    loggerErrorSpy.mockClear();
    const response = await request(`/v1/projects/proj_1/mutations/${MUTATION_ID}/reconcile`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    }, validationApp);
    const responseText = await response.text();

    expect(response.status).toBe(403);
    expect(JSON.parse(responseText)).toEqual({ error: "Mutation reconciliation is not permitted" });
    expect(responseText).not.toContain(sentinel);
    expect(JSON.stringify(loggerErrorSpy.mock.calls)).not.toContain(sentinel);
    expect(requireProjectOrAdminAuth).not.toHaveBeenCalled();
    expect(readMutation).not.toHaveBeenCalled();
    expect(reconcileMutation).not.toHaveBeenCalled();
  });

  test("does not validate mutation IDs on the disabled reconciliation route", async () => {
    const response = await request("/v1/projects/proj_1/mutations/not-a-uuid/reconcile", {
      method: "POST",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Mutation reconciliation is not permitted" });
    expect(requireProjectOrAdminAuth).not.toHaveBeenCalled();
    expect(readMutation).not.toHaveBeenCalled();
    expect(reconcileMutation).not.toHaveBeenCalled();
  });
});
