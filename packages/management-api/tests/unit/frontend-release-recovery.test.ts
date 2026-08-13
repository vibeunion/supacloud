import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

const recoveryClaims: Array<Array<Record<string, unknown>>> = [];
let unresolved = false;
const claimRecoverableFrontendReleases = mock(async () => recoveryClaims.shift() ?? []);
const hasUnresolvedFrontendReleaseActivations = mock(async () => unresolved);
const completeFailure = mock(async () => "updated" as const);
const resume = mock(async () => ({}));
const expectedFingerprint = "f".repeat(64);
const frontendReleaseActivationFingerprint = mock(() => expectedFingerprint);
const frontendReleaseActivationResourceKey = mock((deploymentId: string) =>
  `v1/frontend_release/${Buffer.from(deploymentId).toString("base64url")}`);
const assertActivationCheckpointIdentity = mock((
  checkpoint: Record<string, unknown>,
  identity: { projectRef: string; mutationId: string },
) => {
  const previous = checkpoint.previous_authority as Record<string, unknown> | null | undefined;
  if (checkpoint.activation_id !== identity.mutationId
    || previous && previous.project_ref !== identity.projectRef) {
    throw new Error("Frontend release activation checkpoint identity is invalid");
  }
});

mock.module("../../src/services/frontend-release-contract", () => ({
  assertActivationCheckpointIdentity,
  frontendReleaseMutationPlatformSupported: () => true,
  parseActivationCheckpoint: (checkpoint: unknown) => checkpoint,
}));
mock.module("../../src/services/frontend-release-activation", () => ({
  frontendReleaseActivationFingerprint,
  frontendReleaseActivationResourceKey,
  FrontendReleaseActivationService: class {
    resume = resume;
  },
}));
mock.module("../../src/services/frontend-release-mutation", () => ({
  claimRecoverableFrontendReleases,
  frontendReleaseMutationStore: () => ({ completeFailure }),
  hasUnresolvedFrontendReleaseActivations,
}));
mock.module("../../src/services/frontend-release-storage", () => ({
  FrontendReleaseStorage: class {},
}));
mock.module("../../src/services/gateway.service", () => ({ gatewayService: {} }));
mock.module("../../src/utils/logger", () => ({ logger: { error: () => undefined } }));

const recoveryWorker = await import(
  new URL("../../src/workers/frontend-release-recovery.worker.ts?startup-recovery-test", import.meta.url).href
);

const indexSource = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
const workerSource = readFileSync(
  new URL("../../src/workers/frontend-release-recovery.worker.ts", import.meta.url),
  "utf8",
);
const selfHostCompose = readFileSync(
  new URL("../../../../docker/self-host/docker-compose.yml", import.meta.url),
  "utf8",
);

function recoveryCheckpoint(mutationId: string): Record<string, unknown> {
  return {
    deployment_id: "fa-web",
    release_id: "a".repeat(64),
    expected_active_release_id: "absent",
    activation_id: mutationId,
    expected_activation_id: "absent",
    previous_authority: null,
  };
}

function recoveryClaim(
  mutationId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    projectRef: "project_ref",
    mutationId,
    operation: "frontend.release.activate",
    resourceKey: frontendReleaseActivationResourceKey("fa-web"),
    requestFingerprint: expectedFingerprint,
    principal: { type: "project", id: "project:project_ref" },
    checkpoint: recoveryCheckpoint(mutationId),
    leaseToken: mutationId.replace("8000", "8001"),
    fencingEpoch: 1,
    ...overrides,
  };
}

describe("frontend release startup recovery", () => {
  beforeEach(() => {
    recoveryClaims.length = 0;
    unresolved = false;
    claimRecoverableFrontendReleases.mockClear();
    hasUnresolvedFrontendReleaseActivations.mockClear();
    completeFailure.mockClear();
    resume.mockClear();
    assertActivationCheckpointIdentity.mockClear();
    frontendReleaseActivationFingerprint.mockClear();
    frontendReleaseActivationResourceKey.mockClear();
  });

  test("settles activation recovery before gateway reconciliation and HTTP listen", () => {
    const durableGateIndex = indexSource.indexOf("await waitForGatewayBeforeServe()");
    const strictHydrateIndex = indexSource.indexOf("gatewayService.ensureGatewayReady", indexSource.indexOf("async function waitForGatewayBeforeServe"));
    const recoveryIndex = indexSource.indexOf("await recoverFrontendReleasesBeforeServe()");
    const gatewayIndex = indexSource.indexOf("await reconcileGatewayBeforeServe()", recoveryIndex);
    const serveIndex = indexSource.indexOf("Bun.serve({");

    expect(durableGateIndex).toBeGreaterThan(-1);
    expect(strictHydrateIndex).toBeGreaterThan(-1);
    expect(recoveryIndex).toBeGreaterThan(durableGateIndex);
    expect(recoveryIndex).toBeGreaterThan(-1);
    expect(gatewayIndex).toBeGreaterThan(recoveryIndex);
    expect(serveIndex).toBeGreaterThan(gatewayIndex);
  });

  test("propagates recovery failures and refuses every unresolved activation", () => {
    const startupStart = workerSource.indexOf("export async function recoverFrontendReleasesBeforeServe");
    const startupEnd = workerSource.indexOf("export function startFrontendReleaseRecoveryWorker", startupStart);
    const startupSource = workerSource.slice(startupStart, startupEnd);

    expect(startupSource).toContain("await serializedRecoveryBatch()");
    expect(startupSource).toContain("await hasUnresolvedFrontendReleaseActivations()");
    expect(startupSource).toContain("throw new Error");
    expect(startupSource).not.toContain("catch (");
  });

  test("keeps later recovery on an interval without an unawaited initial sweep", () => {
    const workerStart = workerSource.indexOf("export function startFrontendReleaseRecoveryWorker");
    const workerEnd = workerSource.indexOf("export function stopFrontendReleaseRecoveryWorker", workerStart);
    const startSource = workerSource.slice(workerStart, workerEnd);

    expect(startSource).toContain("setInterval");
    expect(startSource).not.toContain("void recoverAvailableBatch()");
    expect(startSource).not.toContain("void serializedRecoveryBatch()");
  });

  test("starts the Caddy Admin API independently from Management", () => {
    const caddyStart = selfHostCompose.indexOf("\n  caddy:\n");
    const caddySource = selfHostCompose.slice(caddyStart, selfHostCompose.indexOf("\nvolumes:\n", caddyStart));

    expect(caddyStart).toBeGreaterThan(-1);
    expect(caddySource).not.toContain("depends_on:");
    expect(caddySource).toContain("127.0.0.1:2019/config/");
    expect(caddySource).not.toContain("edge-runtime:");
    expect(caddySource).not.toContain("condition: service_healthy");
  });

  test("drains every full recovery batch before accepting a settled state", async () => {
    recoveryClaims.push(Array.from({ length: 16 }, (_, index) => recoveryClaim(
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    )), []);

    await recoveryWorker.recoverFrontendReleasesBeforeServe();

    expect(claimRecoverableFrontendReleases).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledTimes(16);
    expect(hasUnresolvedFrontendReleaseActivations).toHaveBeenCalledTimes(1);
  });

  test("propagates a recovery failure without reading it as settled", async () => {
    recoveryClaims.push([recoveryClaim("00000000-0000-4000-8000-000000000001")]);
    resume.mockRejectedValueOnce(new Error("route recovery failed"));

    await expect(recoveryWorker.recoverFrontendReleasesBeforeServe())
      .rejects.toThrow("route recovery failed");
    expect(hasUnresolvedFrontendReleaseActivations).not.toHaveBeenCalled();
  });

  test("fails closed while a fresh lease or unknown outcome remains unresolved", async () => {
    recoveryClaims.push([]);
    unresolved = true;

    await expect(recoveryWorker.recoverFrontendReleasesBeforeServe())
      .rejects.toThrow("remains unresolved");
    expect(resume).not.toHaveBeenCalled();
  });

  test("rejects a mismatched recovery identity before activation I/O", async () => {
    const mutationId = "00000000-0000-4000-8000-000000000001";
    recoveryClaims.push([recoveryClaim(mutationId, {
      requestFingerprint: "e".repeat(64),
    })]);

    await expect(recoveryWorker.recoverFrontendReleasesBeforeServe())
      .rejects.toThrow("claim identity is invalid");
    expect(resume).not.toHaveBeenCalled();
    expect(completeFailure).not.toHaveBeenCalled();
  });

  test("validates an empty-checkpoint claim envelope before terminalizing it", async () => {
    const mutationId = "00000000-0000-4000-8000-000000000001";
    recoveryClaims.push([recoveryClaim(mutationId, {
      operation: "frontend.release.delete",
      checkpoint: {},
    })]);

    await expect(recoveryWorker.recoverFrontendReleasesBeforeServe())
      .rejects.toThrow("claim identity is invalid");
    expect(completeFailure).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});
