import { logger } from "../utils/logger";
import {
  frontendReleaseActivationFingerprint,
  frontendReleaseActivationResourceKey,
  FrontendReleaseActivationService,
} from "../services/frontend-release-activation";
import {
  assertActivationCheckpointIdentity,
  frontendReleaseMutationPlatformSupported,
  parseActivationCheckpoint,
  type ActivateFrontendReleaseInput,
} from "../services/frontend-release-contract";
import { gatewayService } from "../services/gateway.service";
import {
  claimRecoverableFrontendReleases,
  frontendReleaseMutationStore,
  hasUnresolvedFrontendReleaseActivations,
} from "../services/frontend-release-mutation";
import type { RecoverableProjectMutationClaim } from "../services/project-mutation.service";
import { FrontendReleaseStorage } from "../services/frontend-release-storage";

const POLL_INTERVAL_MS = 30_000;
const RECOVERY_BATCH_SIZE = 16;
const FRONTEND_RESOURCE_KEY_PATTERN = /^v1\/frontend_release\/[A-Za-z0-9_-]{2,171}$/;
const REQUEST_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
let timer: ReturnType<typeof setInterval> | null = null;
let recoveryRun: Promise<number> | null = null;

function recoveryInput(
  projectRef: string,
  mutationId: string,
  principal: ActivateFrontendReleaseInput["principal"],
  checkpoint: NonNullable<ReturnType<typeof parseActivationCheckpoint>>,
): ActivateFrontendReleaseInput {
  return {
    projectRef,
    deploymentId: checkpoint.deployment_id,
    releaseId: checkpoint.release_id,
    expectedActiveReleaseId: checkpoint.expected_active_release_id,
    expectedActivationId: checkpoint.expected_activation_id,
    mutationId,
    principal,
  };
}

function recoveryServices() {
  const mutations = frontendReleaseMutationStore();
  const activation = new FrontendReleaseActivationService({
    storage: new FrontendReleaseStorage(),
    gateway: gatewayService,
    mutations,
  });
  return { activation, mutations };
}

function assertRecoveryClaimEnvelope(claim: RecoverableProjectMutationClaim): void {
  if (claim.operation !== "frontend.release.activate"
    || claim.resourceKey === null
    || !FRONTEND_RESOURCE_KEY_PATTERN.test(claim.resourceKey)
    || !REQUEST_FINGERPRINT_PATTERN.test(claim.requestFingerprint)
    || !["master", "admin", "project"].includes(claim.principal.type)
    || !claim.principal.id
    || claim.principal.id.trim() !== claim.principal.id) {
    throw new Error("Frontend release recovery claim identity is invalid");
  }
}

async function finalizeEmptyCheckpoint(
  claim: RecoverableProjectMutationClaim,
  mutations: ReturnType<typeof frontendReleaseMutationStore>,
): Promise<void> {
  const completed = await mutations.completeFailure({
    projectRef: claim.projectRef,
    mutationId: claim.mutationId,
    leaseToken: claim.leaseToken,
    fencingEpoch: claim.fencingEpoch,
    status: "failed_terminal",
    failureCode: "ACTIVATION_NOT_STARTED",
    responseStatus: 409,
    receipt: { project_ref: claim.projectRef },
  });
  if (completed !== "updated") throw new Error("Empty activation recovery could not be finalized");
}

async function recoverClaim(
  claim: RecoverableProjectMutationClaim,
  services: ReturnType<typeof recoveryServices>,
): Promise<void> {
  assertRecoveryClaimEnvelope(claim);
  const checkpoint = parseActivationCheckpoint(claim.checkpoint);
  if (!checkpoint) return finalizeEmptyCheckpoint(claim, services.mutations);
  assertActivationCheckpointIdentity(checkpoint, {
    projectRef: claim.projectRef,
    mutationId: claim.mutationId,
  });
  const input = recoveryInput(
    claim.projectRef,
    claim.mutationId,
    claim.principal,
    checkpoint,
  );
  const expectedResourceKey = frontendReleaseActivationResourceKey(input.deploymentId);
  const expectedFingerprint = frontendReleaseActivationFingerprint(input);
  if (claim.resourceKey !== expectedResourceKey
    || claim.requestFingerprint !== expectedFingerprint) {
    throw new Error("Frontend release recovery claim identity is invalid");
  }
  await services.activation.resume(input, {
    leaseToken: claim.leaseToken,
    fencingEpoch: claim.fencingEpoch,
    replayed: false,
    preparedNow: false,
    checkpoint,
  });
}

async function recoverAvailableBatch(): Promise<number> {
  const claims = await claimRecoverableFrontendReleases(
    `management-api:frontend-release-recovery:${process.pid}`,
    RECOVERY_BATCH_SIZE,
  );
  const services = recoveryServices();
  for (const claim of claims) await recoverClaim(claim, services);
  return claims.length;
}

function serializedRecoveryBatch(): Promise<number> {
  if (recoveryRun) return recoveryRun;
  const run = recoverAvailableBatch().finally(() => {
    if (recoveryRun === run) recoveryRun = null;
  });
  recoveryRun = run;
  return run;
}

async function recoverBackgroundBatch(): Promise<void> {
  try {
    await serializedRecoveryBatch();
  } catch (error: unknown) {
    logger.error("[frontend-release-recovery] recovery scan failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function recoverFrontendReleasesBeforeServe(): Promise<void> {
  if (!frontendReleaseMutationPlatformSupported()) return;
  while (await serializedRecoveryBatch() === RECOVERY_BATCH_SIZE) {
    // Drain every immediately recoverable activation before opening the listener.
  }
  if (await hasUnresolvedFrontendReleaseActivations()) {
    throw new Error("Frontend release activation remains unresolved after startup recovery");
  }
}

export function startFrontendReleaseRecoveryWorker(): void {
  if (timer || !frontendReleaseMutationPlatformSupported()) return;
  timer = setInterval(() => void recoverBackgroundBatch(), POLL_INTERVAL_MS);
}

export function stopFrontendReleaseRecoveryWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
