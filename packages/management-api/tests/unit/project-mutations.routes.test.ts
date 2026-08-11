import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const MUTATION_ID = "00000000-0000-4000-8000-000000000001";
const LEASE_TOKEN_SENTINEL = "00000000-0000-4000-8000-000000000099";
const JOURNAL_PAYLOAD_SENTINEL = "stored-journal-payload-must-not-be-public";
const readMutation = mock(() => Promise.resolve(null));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(undefined));

const mutationService = await import("../../src/services/project-mutation.service");
const authModule = await import("../../src/middleware/auth");
const readMutationSpy = spyOn(mutationService, "readProjectMutation").mockImplementation(
  readMutation as typeof mutationService.readProjectMutation,
);
const authSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const { projectMutationRoutes } = await import("../../src/routes/project-mutations");
const app = new Elysia().use(projectMutationRoutes);

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

function request(path: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, {
    headers: { authorization: "Bearer test" },
  }));
}

describe("project mutation status route", () => {
  afterAll(() => {
    readMutationSpy.mockRestore();
    authSpy.mockRestore();
  });

  beforeEach(() => {
    readMutation.mockReset();
    readMutation.mockResolvedValue(null);
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
});
