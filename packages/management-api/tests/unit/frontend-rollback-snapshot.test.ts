import { afterEach, expect, spyOn, test } from "bun:test";
import { FrontendReleaseService } from "../../src/services/frontend-release.service";
import { FrontendReleaseStorage } from "../../src/services/frontend-release-storage";
import {
  FRONTEND_ACTIVE_RELEASE_SCHEMA, FRONTEND_ACTIVATION_CHECKPOINT_SCHEMA, FRONTEND_RELEASE_SCHEMA,
  type FrontendActiveReleaseRecord, type FrontendReleaseRecord,
} from "../../src/services/frontend-release-contract";
import type { FrontendReleaseMutationStore } from "../../src/services/frontend-release-mutation";
import {
  frontendReleaseActivationFingerprint, frontendReleaseActivationResourceKey,
} from "../../src/services/frontend-release-activation";
import type { ProjectMutationState } from "../../src/services/project-mutation.service";
import type { FrontendDeployment } from "../../src/types/frontend";

const REF = "project";
const ID = "web";
const CURRENT = "a".repeat(64);
const PREVIOUS = "f".repeat(64);
const ACTIVATION = "00000000-0000-4000-8000-000000000002";
const PREVIOUS_ACTIVATION = "00000000-0000-4000-8000-000000000001";
const TIME = "2026-10-10T00:00:00.000Z";
const restores: Array<() => void> = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

function fixture() {
  const release = (id: string): FrontendReleaseRecord => ({
    schema: FRONTEND_RELEASE_SCHEMA, project_ref: REF, deployment_id: ID,
    release_id: id, sha256: id, tree_sha256: id,
    size_bytes: 1, file_count: 1, created_at: TIME, kind: "prebuilt_static", archive_format: "tar.zst",
  });
  const authority = (id: string, activation: string): FrontendActiveReleaseRecord => ({
    schema: FRONTEND_ACTIVE_RELEASE_SCHEMA, project_ref: REF, deployment_id: ID,
    release_id: id, sha256: id, tree_sha256: id,
    activation_id: activation, mutation_id: activation, activated_at: TIME,
  });
  const previous = authority(PREVIOUS, PREVIOUS_ACTIVATION);
  const active = authority(CURRENT, ACTIVATION);
  const input = {
    projectRef: REF, deploymentId: ID, releaseId: CURRENT, mutationId: ACTIVATION,
    expectedActiveReleaseId: PREVIOUS, expectedActivationId: PREVIOUS_ACTIVATION,
    principal: { type: "project" as const, id: `project:${REF}` },
  };
  const mutation: ProjectMutationState = {
    projectRef: REF, mutationId: ACTIVATION, operation: "frontend.release.activate",
    resourceKey: frontendReleaseActivationResourceKey(ID),
    requestFingerprint: frontendReleaseActivationFingerprint(input), principal: input.principal,
    status: "succeeded", responseStatus: 200, failureCode: null,
    receipt: {
      project_ref: REF, deployment_id: ID, active_release_id: CURRENT,
      release_id: CURRENT, sha256: CURRENT, tree_sha256: CURRENT, activation_id: ACTIVATION,
    },
    checkpoint: {
      schema: FRONTEND_ACTIVATION_CHECKPOINT_SCHEMA, phase: "route_applied",
      deployment_id: ID, release_id: CURRENT, expected_active_release_id: PREVIOUS,
      activation_id: ACTIVATION, expected_activation_id: PREVIOUS_ACTIVATION,
      activated_at: TIME, previous_authority: previous, previous_route: "release",
    },
    fencingEpoch: 1, leaseOwner: null, leaseExpiresAt: null,
    completedAt: TIME, createdAt: TIME, updatedAt: TIME,
  };
  const state = {
    active: active as FrontendActiveReleaseRecord | null,
    mutation: mutation as ProjectMutationState | null,
    unresolved: false, corruptPrevious: false,
    route: `/var/supacloud/frontends/${REF}/${ID}/releases/${CURRENT}/build`,
    locked: false, lockCalls: 0, releaseReads: [] as string[],
  };
  const assertLocked = () => { expect(state.locked).toBe(true); };
  const deployment: FrontendDeployment = {
    id: ID, project_ref: REF, name: ID, framework: "static", domain: "web.example.test",
    custom_domains: [], build_command: "", output_dir: "dist", install_command: "",
    node_version: "20", env_vars: {}, status: "success", created_at: TIME, updated_at: TIME,
    deployment_url: "https://web.example.test",
  };
  const deploymentRead = spyOn(FrontendReleaseStorage.prototype, "deployment")
    .mockImplementation(async () => { assertLocked(); return deployment; });
  const activeRead = spyOn(FrontendReleaseStorage.prototype, "activeRelease")
    .mockImplementation(async () => { assertLocked(); return state.active; });
  const releaseRead = spyOn(FrontendReleaseStorage.prototype, "releaseRecord")
    .mockImplementation(async (_ref, _id, id) => {
      assertLocked();
      state.releaseReads.push(id);
      if (state.corruptPrevious && id === PREVIOUS) throw new Error("Previous artifact is corrupt");
      return release(id);
    });
  restores.push(() => deploymentRead.mockRestore(), () => activeRead.mockRestore(), () => releaseRead.mockRestore());
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected mutation"); };
  const mutations: FrontendReleaseMutationStore = {
    read: async () => { assertLocked(); return state.mutation; },
    activeForDeployment: async () => { assertLocked(); return state.unresolved ? mutation : null; },
    beginAndClaim: unexpected, checkpoint: unexpected, completeFailure: unexpected,
    completeSuccess: unexpected, withLease: unexpected,
  };
  const service = new FrontendReleaseService({
    mutations,
    gateway: {
      configureFrontendRoute: unexpected, removeFrontendRoute: unexpected,
      readFrontendStaticRoot: async () => { assertLocked(); return state.route; },
    },
    deploymentLock: async (ref, id, operation) => {
      expect([ref, id]).toEqual([REF, ID]);
      state.lockCalls++;
      state.locked = true;
      try { return await operation(); } finally { state.locked = false; }
    },
  });
  return { service, state, mutation };
}

test("reads only the journal-selected previous release in one deployment lock", async () => {
  const { service, state } = fixture();
  expect(await service.rollbackSnapshot(REF, ID)).toMatchObject({
    schema: "supacloud.frontend-rollback-snapshot.v1", project_ref: REF, deployment_id: ID,
    active_release_id: CURRENT, active_activation_id: ACTIVATION,
    previous_release: { release_id: PREVIOUS }, previous_activation_id: PREVIOUS_ACTIVATION,
  });
  expect(state.lockCalls).toBe(1);
  expect(state.releaseReads).toEqual([CURRENT, CURRENT, PREVIOUS]);
});

test("an absent active release has no invented rollback target", async () => {
  const { service, state } = fixture();
  state.active = null;
  expect(await service.rollbackSnapshot(REF, ID)).toMatchObject({
    active_release_id: null, active_activation_id: null,
    previous_release: null, previous_activation_id: null,
  });
  expect(state.releaseReads).toEqual([]);
});

test("an initial or legacy activation has no invented previous artifact", async () => {
  const { service, mutation } = fixture();
  mutation.checkpoint = {
    ...mutation.checkpoint, expected_active_release_id: "absent", expected_activation_id: "absent",
    previous_authority: null, previous_route: "legacy",
  };
  mutation.requestFingerprint = frontendReleaseActivationFingerprint({
    projectRef: REF, deploymentId: ID, releaseId: CURRENT, mutationId: ACTIVATION,
    expectedActiveReleaseId: "absent", expectedActivationId: "absent", principal: mutation.principal,
  });
  expect(await service.rollbackSnapshot(REF, ID)).toMatchObject({
    previous_release: null, previous_activation_id: null,
  });
});

test("refuses a snapshot during an unresolved activation", async () => {
  const { service, state } = fixture();
  state.unresolved = true;
  await expect(service.rollbackSnapshot(REF, ID)).rejects.toMatchObject({ code: "FRONTEND_RELEASE_BUSY" });
  expect(state.releaseReads).toEqual([]);
});

test.each(["missing", "foreign", "fingerprint", "failed", "checkpoint", "receipt", "route", "tree"])(
  "refuses an unproven rollback snapshot: %s",
  async (fault) => {
    const { service, state, mutation } = fixture();
    switch (fault) {
      case "missing": state.mutation = null; break;
      case "foreign": mutation.projectRef = "other"; break;
      case "fingerprint": mutation.requestFingerprint = "0".repeat(64); break;
      case "failed": mutation.status = "outcome_unknown"; break;
      case "checkpoint": mutation.checkpoint = { ...mutation.checkpoint, phase: "prepared" }; break;
      case "receipt": mutation.receipt = { ...mutation.receipt, token: "must-not-escape" }; break;
      case "route": state.route = "/wrong"; break;
      case "tree":
        mutation.checkpoint = {
          ...mutation.checkpoint,
          previous_authority: { ...(mutation.checkpoint.previous_authority as FrontendActiveReleaseRecord), tree_sha256: "0".repeat(64) },
        };
        break;
    }
    await expect(service.rollbackSnapshot(REF, ID)).rejects.toMatchObject({
      code: fault === "tree"
        ? "FRONTEND_RELEASE_AUTHORITY_INVALID"
        : fault === "route"
          ? "FRONTEND_RELEASE_READBACK_MISMATCH"
          : "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
    });
  },
);

test("refuses an unreadable previous artifact without modifying the deployment", async () => {
  const { service, state } = fixture();
  state.corruptPrevious = true;
  await expect(service.rollbackSnapshot(REF, ID)).rejects.toThrow("Previous artifact is corrupt");
});
