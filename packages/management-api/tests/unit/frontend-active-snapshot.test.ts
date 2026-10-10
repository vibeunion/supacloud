import { afterEach, expect, spyOn, test } from "bun:test";
import { FrontendReleaseService } from "../../src/services/frontend-release.service";
import { FrontendReleaseStorage } from "../../src/services/frontend-release-storage";
import {
  FRONTEND_RELEASE_SCHEMA, type FrontendReleaseInventory,
} from "../../src/services/frontend-release-contract";
import type { FrontendReleaseMutationStore } from "../../src/services/frontend-release-mutation";
import type { ProjectMutationState } from "../../src/services/project-mutation.service";

const REF = "project";
const ID = "web";
const RELEASE = "a".repeat(64);
const ACTIVATION = "00000000-0000-4000-8000-000000000001";
const restorers: Array<() => void> = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
});

function fixture() {
  const inventory: FrontendReleaseInventory = {
    project_ref: REF, deployment_id: ID,
    active_release_id: RELEASE, active_activation_id: ACTIVATION, next_cursor: null,
    releases: [{
      schema: FRONTEND_RELEASE_SCHEMA, project_ref: REF, deployment_id: ID,
      release_id: RELEASE, sha256: RELEASE, tree_sha256: "b".repeat(64),
      size_bytes: 1, file_count: 1, created_at: "2026-10-11T00:00:00.000Z",
      kind: "prebuilt_static", archive_format: "tar.zst",
    }],
  };
  const state = {
    locked: false, locks: 0, inventoryReads: 0, mutationReads: 0, routeReads: 0,
    unresolved: null as ProjectMutationState["status"] | null,
    mutationError: false, routeError: false,
    route: `/var/supacloud/frontends/${REF}/${ID}/releases/${RELEASE}/build` as string | null,
  };
  const assertLocked = () => expect(state.locked).toBe(true);
  const snapshot = spyOn(FrontendReleaseStorage.prototype, "activeReleaseSnapshot")
    .mockImplementation(async (ref, id) => {
      assertLocked();
      expect([ref, id]).toEqual([REF, ID]);
      state.inventoryReads++;
      return inventory;
    });
  restorers.push(() => snapshot.mockRestore());
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected write"); };
  const mutations: FrontendReleaseMutationStore = {
    activeForDeployment: async (ref, id) => {
      assertLocked();
      expect([ref, id]).toEqual([REF, ID]);
      state.mutationReads++;
      if (state.mutationError) throw new Error("Mutation state unavailable");
      return state.unresolved ? {
        projectRef: REF, mutationId: ACTIVATION, operation: "frontend.release.activate",
        resourceKey: "v1/frontend_release/d2Vi", requestFingerprint: "c".repeat(64),
        principal: { type: "project", id: `project:${REF}` },
        status: state.unresolved, responseStatus: null, failureCode: null,
        checkpoint: {}, receipt: {}, fencingEpoch: 1, leaseOwner: null, leaseExpiresAt: null,
        completedAt: null, createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z",
      } : null;
    },
    read: unexpected, beginAndClaim: unexpected, checkpoint: unexpected,
    completeSuccess: unexpected, completeFailure: unexpected, withLease: unexpected,
  };
  const service = new FrontendReleaseService({
    mutations,
    gateway: {
      configureFrontendRoute: unexpected, removeFrontendRoute: unexpected,
      readFrontendStaticRoot: async (ref, id) => {
        assertLocked();
        expect([ref, id]).toEqual([REF, ID]);
        state.routeReads++;
        if (state.routeError) throw new Error("Route state unavailable");
        return state.route;
      },
    },
    deploymentLock: async (ref, id, operation) => {
      expect([ref, id]).toEqual([REF, ID]);
      state.locks++;
      state.locked = true;
      try { return await operation(); } finally { state.locked = false; }
    },
  });
  return { service, state, inventory };
}

test("verifies mutation state, current artifact and live route in one read-only deployment lock", async () => {
  const { service, state, inventory } = fixture();
  expect(await service.activeReleaseSnapshot(REF, ID)).toEqual(inventory);
  expect(state).toMatchObject({ locks: 1, mutationReads: 1, inventoryReads: 1, routeReads: 1 });
});

test.each(["pending", "running", "failed_retryable", "outcome_unknown"] as const)(
  "refuses a no-op snapshot while activation is %s, before inspecting artifacts",
  async (status) => {
    const { service, state } = fixture();
    state.unresolved = status;
    await expect(service.activeReleaseSnapshot(REF, ID)).rejects.toMatchObject({ code: "FRONTEND_RELEASE_BUSY" });
    expect(state).toMatchObject({ inventoryReads: 0, routeReads: 0 });
  },
);

test.each([null, "/legacy/build", `/var/supacloud/frontends/${REF}/${ID}/releases/${"c".repeat(64)}/build`])(
  "refuses an active snapshot whose live route is %s",
  async (route) => {
    const { service, state } = fixture();
    state.route = route;
    await expect(service.activeReleaseSnapshot(REF, ID)).rejects.toMatchObject({
      code: "FRONTEND_RELEASE_READBACK_MISMATCH",
    });
  },
);

test.each(["mutation", "route"])("fails closed when %s observation is unavailable", async (fault) => {
  const { service, state } = fixture();
  state.mutationError = fault === "mutation";
  state.routeError = fault === "route";
  await expect(service.activeReleaseSnapshot(REF, ID)).rejects.toThrow("state unavailable");
});

test("keeps initial immutable deployment possible without treating legacy routing as immutable authority", async () => {
  const { service, state, inventory } = fixture();
  inventory.active_release_id = null;
  inventory.active_activation_id = null;
  inventory.releases = [];
  state.route = "/legacy/build";
  expect(await service.activeReleaseSnapshot(REF, ID)).toEqual(inventory);
  expect(state).toMatchObject({ mutationReads: 1, inventoryReads: 1, routeReads: 0 });
});
