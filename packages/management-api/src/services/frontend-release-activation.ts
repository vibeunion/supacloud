import type { FrontendDeployment } from "../types/frontend";
import {
  assertActivationCheckpointIdentity,
  assertExpectedActiveReleaseId,
  assertExpectedFrontendActivationId,
  assertFrontendIdentity,
  assertReleaseId,
  FRONTEND_ACTIVE_RELEASE_SCHEMA,
  FRONTEND_ACTIVATION_CHECKPOINT_SCHEMA,
  MUTATION_ID_PATTERN,
  frontendReleaseError,
  isFrontendGatewayDurabilityUnknown,
  parseActivationCheckpoint,
  type ActivateFrontendReleaseInput,
  type FrontendActivationCheckpoint,
  type FrontendActiveReleaseRecord,
  type FrontendReleaseActivation,
  type FrontendReleaseGateway,
  type FrontendReleaseRecord,
  type FrontendReleaseStoragePort,
} from "./frontend-release-contract";
import {
  frontendReleaseMutationStore,
  type FrontendReleaseMutationStore,
} from "./frontend-release-mutation";
import {
  projectMutationFingerprint,
  projectMutationResourceKey,
  type ProjectMutationState,
} from "./project-mutation.service";
import {
  withFrontendDeploymentLock,
  type FrontendDeploymentLock,
} from "./frontend-deployment-lock";

const MUTATION_LEASE_SECONDS = 300;

export function frontendReleaseActivationResourceKey(deploymentId: string): string {
  return projectMutationResourceKey({ type: "frontend_release", id: deploymentId });
}

export function frontendReleaseActivationFingerprint(input: ActivateFrontendReleaseInput): string {
  return projectMutationFingerprint({
    project_ref: input.projectRef,
    deployment_id: input.deploymentId,
    release_id: input.releaseId,
    expected_active_release_id: input.expectedActiveReleaseId,
    activation_id: input.mutationId,
    expected_activation_id: input.expectedActivationId,
  });
}

export interface ClaimedActivation {
  leaseToken: string;
  fencingEpoch: number;
  replayed: boolean;
  preparedNow: boolean;
  checkpoint: FrontendActivationCheckpoint | null;
}

interface FrontendReleaseActivationOptions {
  storage: FrontendReleaseStoragePort;
  gateway: FrontendReleaseGateway;
  mutations?: FrontendReleaseMutationStore;
  deploymentLock?: FrontendDeploymentLock;
  now?: () => Date;
  interruption?: (phase: "after_prepared" | "after_authority" | "after_route") => void;
}

function desiredAuthority(
  input: ActivateFrontendReleaseInput,
  release: FrontendReleaseRecord,
  activatedAt: string,
): FrontendActiveReleaseRecord {
  return {
    schema: FRONTEND_ACTIVE_RELEASE_SCHEMA,
    project_ref: input.projectRef,
    deployment_id: input.deploymentId,
    release_id: release.release_id,
    sha256: release.sha256,
    tree_sha256: release.tree_sha256,
    activation_id: input.mutationId,
    activated_at: activatedAt,
    mutation_id: input.mutationId,
  };
}

function receipt(input: ActivateFrontendReleaseInput, release: FrontendReleaseRecord): Record<string, unknown> {
  return {
    project_ref: input.projectRef,
    deployment_id: input.deploymentId,
    active_release_id: release.release_id,
    release_id: release.release_id,
    sha256: release.sha256,
    tree_sha256: release.tree_sha256,
    activation_id: input.mutationId,
  };
}

function activationResponse(
  input: ActivateFrontendReleaseInput,
  release: FrontendReleaseRecord,
  replayed: boolean,
): FrontendReleaseActivation {
  return {
    project_ref: input.projectRef,
    deployment_id: input.deploymentId,
    active_release_id: release.release_id,
    activation_id: input.mutationId,
    release,
    mutation: { mutation_id: input.mutationId, status: "succeeded", replayed },
  };
}

function checkpointMatchesInput(
  checkpoint: FrontendActivationCheckpoint,
  input: ActivateFrontendReleaseInput,
): boolean {
  return checkpoint.deployment_id === input.deploymentId
    && checkpoint.release_id === input.releaseId
    && checkpoint.expected_active_release_id === input.expectedActiveReleaseId
    && checkpoint.activation_id === input.mutationId
    && checkpoint.expected_activation_id === input.expectedActivationId;
}

function recordsExactlyMatch(
  candidate: Record<string, unknown> | null,
  expected: Record<string, unknown>,
): boolean {
  if (!candidate) return false;
  const candidateKeys = Object.keys(candidate);
  const expectedKeys = Object.keys(expected);
  return candidateKeys.length === expectedKeys.length
    && candidateKeys.every((key) => Object.hasOwn(expected, key) && candidate[key] === expected[key]);
}

export class FrontendReleaseActivationService {
  private readonly storage: FrontendReleaseStoragePort;
  private readonly gateway: FrontendReleaseGateway;
  private readonly mutations: FrontendReleaseMutationStore;
  private readonly deploymentLock: FrontendDeploymentLock;
  private readonly now: () => Date;
  private readonly interruption?: FrontendReleaseActivationOptions["interruption"];

  constructor(options: FrontendReleaseActivationOptions) {
    this.storage = options.storage;
    this.gateway = options.gateway;
    this.mutations = options.mutations ?? frontendReleaseMutationStore();
    this.deploymentLock = options.deploymentLock ?? withFrontendDeploymentLock;
    this.now = options.now ?? (() => new Date());
    this.interruption = options.interruption;
  }

  private assertInput(input: ActivateFrontendReleaseInput): void {
    assertFrontendIdentity(input.projectRef, input.deploymentId);
    assertReleaseId(input.releaseId);
    assertExpectedActiveReleaseId(input.expectedActiveReleaseId);
    assertExpectedFrontendActivationId(input.expectedActivationId);
    if (!MUTATION_ID_PATTERN.test(input.mutationId)) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_MUTATION_ID_INVALID",
        400,
        "mutation_id must be a UUIDv4",
      );
    }
  }

  private async claim(
    input: ActivateFrontendReleaseInput,
    initialCheckpoint?: FrontendActivationCheckpoint,
  ): Promise<ClaimedActivation> {
    const leaseToken = crypto.randomUUID();
    const { begun, claimed } = await this.mutations.beginAndClaim({
      projectRef: input.projectRef,
      mutationId: input.mutationId,
      operation: "frontend.release.activate",
      resource: { type: "frontend_release", id: input.deploymentId },
      requestFingerprint: frontendReleaseActivationFingerprint(input),
      principal: input.principal,
    }, {
      leaseOwner: `management-api:frontend-release:${process.pid}`,
      leaseToken,
      leaseSeconds: MUTATION_LEASE_SECONDS,
      ...(initialCheckpoint ? { initialCheckpoint: { ...initialCheckpoint } } : {}),
    });
    if (begun.kind === "fingerprint_conflict" || begun.kind === "principal_conflict") {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_MUTATION_CONFLICT",
        409,
        "Frontend release mutation identity conflicts with an existing request",
      );
    }
    if (begun.kind === "resource_busy") {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_BUSY",
        409,
        "Another frontend release activation is still unresolved",
      );
    }
    if (begun.kind === "replay" && begun.mutation.status === "succeeded") {
      return {
        leaseToken: "",
        fencingEpoch: begun.mutation.fencingEpoch,
        replayed: true,
        preparedNow: false,
        checkpoint: parseActivationCheckpoint(begun.mutation.checkpoint),
      };
    }
    if (begun.kind === "replay" && ["failed_terminal", "outcome_unknown"].includes(begun.mutation.status)) {
      const code = begun.mutation.status === "outcome_unknown"
        ? "FRONTEND_RELEASE_OUTCOME_UNKNOWN"
        : "FRONTEND_RELEASE_MUTATION_FAILED";
      throw frontendReleaseError(code, 409, "Frontend release mutation is already terminal");
    }
    if (!claimed) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
        503,
        "Frontend release mutation could not be claimed",
      );
    }
    if (claimed.kind === "busy") {
      throw frontendReleaseError("FRONTEND_RELEASE_BUSY", 409, "Frontend release activation is already running");
    }
    if (claimed.kind === "not_found") {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
        503,
        "Frontend release mutation could not be read back",
      );
    }
    if (claimed.kind === "terminal") {
      if (claimed.mutation.status === "succeeded") {
        return {
          leaseToken: "",
          fencingEpoch: claimed.mutation.fencingEpoch,
          replayed: true,
          preparedNow: false,
          checkpoint: parseActivationCheckpoint(claimed.mutation.checkpoint),
        };
      }
      throw frontendReleaseError(
        "FRONTEND_RELEASE_MUTATION_FAILED",
        409,
        "Frontend release mutation is already terminal",
      );
    }
    const checkpoint = parseActivationCheckpoint(claimed.mutation.checkpoint);
    if (checkpoint) {
      assertActivationCheckpointIdentity(checkpoint, {
        projectRef: input.projectRef,
        mutationId: input.mutationId,
      });
      if (!checkpointMatchesInput(checkpoint, input)) {
        throw frontendReleaseError(
          "FRONTEND_RELEASE_CHECKPOINT_INVALID",
          503,
          "Frontend release activation checkpoint does not match the request",
        );
      }
    }
    return {
      leaseToken,
      fencingEpoch: claimed.mutation.fencingEpoch,
      replayed: false,
      preparedNow: begun.kind === "started",
      checkpoint,
    };
  }

  private async saveCheckpoint(
    input: ActivateFrontendReleaseInput,
    claim: ClaimedActivation,
    checkpoint: FrontendActivationCheckpoint,
  ): Promise<void> {
    const updated = await this.mutations.checkpoint({
      projectRef: input.projectRef,
      mutationId: input.mutationId,
      leaseToken: claim.leaseToken,
      fencingEpoch: claim.fencingEpoch,
      checkpoint: { ...checkpoint },
      leaseSeconds: MUTATION_LEASE_SECONDS,
    });
    if (updated !== "updated") {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
        503,
        "Frontend release activation lease was lost",
      );
    }
  }

  private async withLease<T>(
    input: ActivateFrontendReleaseInput,
    claim: ClaimedActivation,
    operation: () => Promise<T>,
  ): Promise<T> {
    const executed = await this.mutations.withLease({
      projectRef: input.projectRef,
      mutationId: input.mutationId,
      leaseToken: claim.leaseToken,
      fencingEpoch: claim.fencingEpoch,
    }, operation);
    if (executed.kind === "lease_lost") {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
        503,
        "Frontend release activation lease was lost",
      );
    }
    return executed.value;
  }

  private async currentRouteKind(
    input: ActivateFrontendReleaseInput,
    currentActive: FrontendActiveReleaseRecord | null,
  ): Promise<"absent" | "legacy" | "release"> {
    const currentRoot = await this.gateway.readFrontendStaticRoot(input.projectRef, input.deploymentId);
    if (currentActive) {
      const expectedRoot = this.storage.releaseBuildDir(
        input.projectRef,
        input.deploymentId,
        currentActive.release_id,
      );
      if (currentRoot !== expectedRoot) this.readbackMismatch();
      return "release";
    }
    if (currentRoot === null) return "absent";
    if (currentRoot === this.storage.legacyBuildDir(input.projectRef, input.deploymentId)) return "legacy";
    this.readbackMismatch();
  }

  private readbackMismatch(): never {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_READBACK_MISMATCH",
      503,
      "Frontend active release and Caddy route do not match",
    );
  }

  private recoveryStateUnknown(): never {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
      503,
      "Frontend activation checkpoint and live state cannot be reconciled",
    );
  }

  private async preparedCheckpoint(
    input: ActivateFrontendReleaseInput,
    currentActive: FrontendActiveReleaseRecord | null,
  ): Promise<FrontendActivationCheckpoint> {
    const currentReleaseId = currentActive?.release_id ?? "absent";
    const currentActivationId = currentActive?.activation_id ?? "absent";
    if (currentReleaseId !== input.expectedActiveReleaseId
      || currentActivationId !== input.expectedActivationId) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_REVISION_CONFLICT",
        409,
        "Frontend active release revision conflict",
      );
    }
    const previousRoute = await this.currentRouteKind(input, currentActive);
    return {
      schema: FRONTEND_ACTIVATION_CHECKPOINT_SCHEMA,
      phase: "prepared",
      deployment_id: input.deploymentId,
      release_id: input.releaseId,
      expected_active_release_id: input.expectedActiveReleaseId,
      activation_id: input.mutationId,
      expected_activation_id: input.expectedActivationId,
      activated_at: this.now().toISOString(),
      previous_authority: currentActive,
      previous_route: previousRoute,
    };
  }

  private async reconciledCheckpoint(
    input: ActivateFrontendReleaseInput,
    checkpoint: FrontendActivationCheckpoint,
  ): Promise<FrontendActivationCheckpoint> {
    const active = await this.storage.activeRelease(input.projectRef, input.deploymentId);
    const activeReleaseId = active?.release_id ?? "absent";
    const activeActivationId = active?.activation_id ?? "absent";
    const previousMatches = activeReleaseId === checkpoint.expected_active_release_id
      && activeActivationId === checkpoint.expected_activation_id;
    const desiredMatches = activeReleaseId === checkpoint.release_id
      && activeActivationId === checkpoint.activation_id;
    if (!previousMatches && !desiredMatches) this.recoveryStateUnknown();
    const currentRoot = await this.gateway.readFrontendStaticRoot(input.projectRef, input.deploymentId);
    const desiredRoot = this.storage.releaseBuildDir(input.projectRef, input.deploymentId, checkpoint.release_id);
    const previousRoot = this.previousRoot(input, checkpoint);
    if (previousMatches) {
      if (currentRoot !== previousRoot) this.recoveryStateUnknown();
      return { ...checkpoint, phase: "prepared" };
    }
    if (currentRoot === desiredRoot) return { ...checkpoint, phase: "route_applied" };
    if (currentRoot === previousRoot) return { ...checkpoint, phase: "authority_applied" };
    return this.recoveryStateUnknown();
  }

  private async configureDesiredRoute(
    deployment: FrontendDeployment,
    release: FrontendReleaseRecord,
  ): Promise<void> {
    const route = {
      projectRef: deployment.project_ref,
      deploymentId: deployment.id,
      hosts: [deployment.domain, ...deployment.custom_domains],
      root: this.storage.releaseBuildDir(deployment.project_ref, deployment.id, release.release_id),
      mode: "static" as const,
    };
    await this.gateway.configureFrontendRoute(route);
  }

  private previousRoot(input: ActivateFrontendReleaseInput, checkpoint: FrontendActivationCheckpoint): string | null {
    if (checkpoint.previous_route === "absent") return null;
    if (checkpoint.previous_route === "legacy") {
      return this.storage.legacyBuildDir(input.projectRef, input.deploymentId);
    }
    return this.storage.releaseBuildDir(
      input.projectRef,
      input.deploymentId,
      checkpoint.previous_authority!.release_id,
    );
  }

  private async restorePreviousAuthority(
    input: ActivateFrontendReleaseInput,
    checkpoint: FrontendActivationCheckpoint,
  ): Promise<void> {
    const restored = await this.storage.compareAndSwapActiveRelease(
      input.projectRef,
      input.deploymentId,
      checkpoint.release_id,
      checkpoint.activation_id,
      checkpoint.previous_authority,
    );
    if (restored !== "updated") this.readbackMismatch();
  }

  private async handleRouteFailure(
    input: ActivateFrontendReleaseInput,
    checkpoint: FrontendActivationCheckpoint,
    routeError: unknown,
  ): Promise<void> {
    if (isFrontendGatewayDurabilityUnknown(routeError)) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
        503,
        "Frontend route durability could not be proven",
      );
    }
    let liveRoot: string | null;
    try {
      liveRoot = await this.gateway.readFrontendStaticRoot(input.projectRef, input.deploymentId);
    } catch {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
        503,
        "Frontend route outcome could not be proven",
      );
    }
    const desiredRoot = this.storage.releaseBuildDir(input.projectRef, input.deploymentId, checkpoint.release_id);
    if (liveRoot === desiredRoot) return;
    if (liveRoot === this.previousRoot(input, checkpoint)) {
      await this.restorePreviousAuthority(input, checkpoint);
      throw frontendReleaseError(
        "FRONTEND_RELEASE_ROUTE_REJECTED",
        503,
        "Frontend route change failed and the previous release remains authoritative",
      );
    }
    throw frontendReleaseError(
      "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
      503,
      "Frontend route outcome could not be proven",
    );
  }

  private async ensureAuthority(
    input: ActivateFrontendReleaseInput,
    release: FrontendReleaseRecord,
    checkpoint: FrontendActivationCheckpoint,
  ): Promise<void> {
    const current = await this.storage.activeRelease(input.projectRef, input.deploymentId);
    if (current?.release_id === release.release_id && current.mutation_id === input.mutationId
      && current.activation_id === input.mutationId) return;
    const expected = current?.release_id ?? "absent";
    const expectedActivation = current?.activation_id ?? "absent";
    if (expected !== checkpoint.expected_active_release_id
      || expectedActivation !== checkpoint.expected_activation_id) this.readbackMismatch();
    await this.storage.writeActiveRelease(
      input.projectRef,
      input.deploymentId,
      desiredAuthority(input, release, checkpoint.activated_at),
    );
  }

  private async verifiedActivation(
    input: ActivateFrontendReleaseInput,
    release: FrontendReleaseRecord,
    checkpoint: FrontendActivationCheckpoint,
  ): Promise<void> {
    const active = await this.storage.activeRelease(input.projectRef, input.deploymentId);
    const root = await this.gateway.readFrontendStaticRoot(input.projectRef, input.deploymentId);
    const expectedRoot = this.storage.releaseBuildDir(input.projectRef, input.deploymentId, release.release_id);
    const expectedAuthority = desiredAuthority(input, release, checkpoint.activated_at);
    if (!recordsExactlyMatch(
      active as unknown as Record<string, unknown> | null,
      expectedAuthority as unknown as Record<string, unknown>,
    )
      || root !== expectedRoot) this.readbackMismatch();
    const storedRelease = await this.storage.releaseRecord(
      input.projectRef,
      input.deploymentId,
      release.release_id,
    );
    if (!recordsExactlyMatch(
      storedRelease as unknown as Record<string, unknown>,
      release as unknown as Record<string, unknown>,
    )) this.readbackMismatch();
  }

  private async applyPhases(
    input: ActivateFrontendReleaseInput,
    deployment: FrontendDeployment,
    release: FrontendReleaseRecord,
    claim: ClaimedActivation,
    initialCheckpoint: FrontendActivationCheckpoint,
  ): Promise<void> {
    let checkpoint = await this.reconciledCheckpoint(input, initialCheckpoint);
    if (checkpoint.phase !== initialCheckpoint.phase) await this.saveCheckpoint(input, claim, checkpoint);
    if (checkpoint.phase === "prepared") {
      await this.withLease(input, claim, () => this.ensureAuthority(input, release, checkpoint));
      checkpoint = { ...checkpoint, phase: "authority_applied" };
      await this.saveCheckpoint(input, claim, checkpoint);
      this.interruption?.("after_authority");
    }
    if (checkpoint.phase === "authority_applied") {
      await this.withLease(input, claim, async () => {
        try {
          await this.configureDesiredRoute(deployment, release);
        } catch (error: unknown) {
          await this.handleRouteFailure(input, checkpoint, error);
        }
      });
      checkpoint = { ...checkpoint, phase: "route_applied" };
      await this.saveCheckpoint(input, claim, checkpoint);
      this.interruption?.("after_route");
    }
    await this.withLease(input, claim, () => this.verifiedActivation(input, release, checkpoint));
  }

  private async resolveSuccessfulReplay(
    input: ActivateFrontendReleaseInput,
    release: FrontendReleaseRecord,
  ): Promise<FrontendReleaseActivation> {
    await this.verifiedSuccessfulMutation(input, release);
    return activationResponse(input, release, true);
  }

  private successJournalInvalid(): never {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
      503,
      "Frontend release success journal is invalid",
    );
  }

  private successfulCheckpoint(
    mutation: ProjectMutationState,
    input: ActivateFrontendReleaseInput,
  ): FrontendActivationCheckpoint {
    const checkpoint = parseActivationCheckpoint(mutation.checkpoint);
    if (!checkpoint) return this.successJournalInvalid();
    assertActivationCheckpointIdentity(checkpoint, {
      projectRef: input.projectRef,
      mutationId: input.mutationId,
    });
    if (checkpoint.phase !== "route_applied" || !checkpointMatchesInput(checkpoint, input)) {
      return this.successJournalInvalid();
    }
    return checkpoint;
  }

  private successfulMutationMatches(
    mutation: ProjectMutationState,
    input: ActivateFrontendReleaseInput,
    release: FrontendReleaseRecord,
  ): boolean {
    return mutation.projectRef === input.projectRef
      && mutation.mutationId === input.mutationId
      && mutation.operation === "frontend.release.activate"
      && mutation.resourceKey === frontendReleaseActivationResourceKey(input.deploymentId)
      && mutation.requestFingerprint === frontendReleaseActivationFingerprint(input)
      && mutation.principal.type === input.principal.type
      && mutation.principal.id === input.principal.id
      && mutation.status === "succeeded"
      && mutation.responseStatus === 200
      && mutation.failureCode === null
      && recordsExactlyMatch(mutation.receipt, receipt(input, release));
  }

  private async verifiedSuccessfulMutation(
    input: ActivateFrontendReleaseInput,
    release: FrontendReleaseRecord,
  ): Promise<void> {
    const mutation = await this.mutations.read(input.projectRef, input.mutationId);
    if (!mutation || !this.successfulMutationMatches(mutation, input, release)) {
      return this.successJournalInvalid();
    }
    const checkpoint = this.successfulCheckpoint(mutation, input);
    await this.verifiedActivation(input, release, checkpoint);
  }

  private async completeSuccess(
    input: ActivateFrontendReleaseInput,
    release: FrontendReleaseRecord,
    claim: ClaimedActivation,
  ): Promise<void> {
    const completed = await this.mutations.completeSuccess({
      projectRef: input.projectRef,
      mutationId: input.mutationId,
      leaseToken: claim.leaseToken,
      fencingEpoch: claim.fencingEpoch,
      receipt: receipt(input, release),
      responseStatus: 200,
    });
    if (completed !== "updated") {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
        503,
        "Frontend release success could not be recorded",
      );
    }
    await this.verifiedSuccessfulMutation(input, release);
  }

  private async completeRevisionConflict(
    input: ActivateFrontendReleaseInput,
    claim: ClaimedActivation,
  ): Promise<void> {
    const completed = await this.mutations.completeFailure({
      projectRef: input.projectRef,
      mutationId: input.mutationId,
      leaseToken: claim.leaseToken,
      fencingEpoch: claim.fencingEpoch,
      status: "failed_terminal",
      failureCode: "ACTIVE_RELEASE_CONFLICT",
      responseStatus: 409,
      receipt: {
        project_ref: input.projectRef,
        deployment_id: input.deploymentId,
        release_id: input.releaseId,
        expected_active_release_id: input.expectedActiveReleaseId,
        activation_id: input.mutationId,
        expected_activation_id: input.expectedActivationId,
      },
    });
    if (completed !== "updated") {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
        503,
        "Frontend release mutation completion could not be proven",
      );
    }
  }

  private terminalState(error: unknown): error is Error & { code: string } {
    return error instanceof Error && "code" in error
      && ["FRONTEND_RELEASE_REVISION_CONFLICT", "FRONTEND_RELEASE_MUTATION_CONFLICT"].includes(
        String((error as Error & { code?: unknown }).code),
      );
  }

  private async preserveRecoverableFailure(
    input: ActivateFrontendReleaseInput,
    claim: ClaimedActivation,
    error: unknown,
  ): Promise<never> {
    const terminal = await this.mutations.read(input.projectRef, input.mutationId).catch(() => null);
    if (terminal?.status === "succeeded") {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
        503,
        "Frontend release activation succeeded but its response could not be proven",
      );
    }
    const unknown = error instanceof Error && "code" in error
      && String((error as Error & { code?: unknown }).code) === "FRONTEND_RELEASE_OUTCOME_UNKNOWN";
    const routeRejected = error instanceof Error && "code" in error
      && String((error as Error & { code?: unknown }).code) === "FRONTEND_RELEASE_ROUTE_REJECTED";
    const completed = await this.mutations.completeFailure({
      projectRef: input.projectRef,
      mutationId: input.mutationId,
      leaseToken: claim.leaseToken,
      fencingEpoch: claim.fencingEpoch,
      status: unknown ? "outcome_unknown" : routeRejected ? "failed_terminal" : "failed_retryable",
      failureCode: unknown ? "ROUTE_OUTCOME_UNKNOWN"
        : routeRejected ? "ROUTE_APPLY_REJECTED" : "ACTIVATION_INTERRUPTED",
      responseStatus: 503,
      ...(unknown || routeRejected ? {} : { recoveryNotBefore: this.now() }),
      receipt: {
        project_ref: input.projectRef,
        deployment_id: input.deploymentId,
        release_id: input.releaseId,
        expected_active_release_id: input.expectedActiveReleaseId,
        activation_id: input.mutationId,
        expected_activation_id: input.expectedActivationId,
      },
    });
    if (completed !== "updated") {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
        503,
        "Frontend release activation outcome is unknown",
      );
    }
    if (this.terminalState(error) || unknown || routeRejected) throw error;
    throw frontendReleaseError(
      "FRONTEND_RELEASE_ACTIVATION_RETRYABLE",
      503,
      "Frontend release activation was interrupted and can be retried with the same mutation_id",
    );
  }

  private async executeClaimed(
    input: ActivateFrontendReleaseInput,
    claim: ClaimedActivation,
    preparedDeployment?: FrontendDeployment,
    preparedRelease?: FrontendReleaseRecord,
  ): Promise<FrontendReleaseActivation> {
    this.assertInput(input);
    try {
      const deployment = preparedDeployment
        ?? await this.storage.deployment(input.projectRef, input.deploymentId);
      const release = preparedRelease
        ?? await this.storage.releaseRecord(input.projectRef, input.deploymentId, input.releaseId);
      if (claim.replayed) return this.resolveSuccessfulReplay(input, release);
      let checkpoint = claim.checkpoint;
      if (claim.preparedNow && checkpoint) this.interruption?.("after_prepared");
      if (!checkpoint) {
        checkpoint = await this.preparedCheckpoint(
          input,
          await this.storage.activeRelease(input.projectRef, input.deploymentId),
        );
        await this.saveCheckpoint(input, claim, checkpoint);
        this.interruption?.("after_prepared");
      }
      await this.applyPhases(input, deployment, release, claim, checkpoint);
      await this.completeSuccess(input, release, claim);
      return activationResponse(input, release, false);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error
        && String((error as Error & { code?: unknown }).code) === "FRONTEND_RELEASE_REVISION_CONFLICT") {
        await this.completeRevisionConflict(input, claim);
        throw error;
      }
      return this.preserveRecoverableFailure(input, claim, error);
    }
  }

  async activate(input: ActivateFrontendReleaseInput): Promise<FrontendReleaseActivation> {
    this.assertInput(input);
    const existing = await this.mutations.read(input.projectRef, input.mutationId);
    if (existing) {
      const storedCheckpoint = parseActivationCheckpoint(existing.checkpoint);
      if (storedCheckpoint) {
        assertActivationCheckpointIdentity(storedCheckpoint, {
          projectRef: input.projectRef,
          mutationId: input.mutationId,
        });
        if (!checkpointMatchesInput(storedCheckpoint, input)) {
          throw frontendReleaseError(
            "FRONTEND_RELEASE_CHECKPOINT_INVALID",
            503,
            "Frontend release activation checkpoint does not match the request",
          );
        }
      }
    }
    const deployment = await this.storage.deployment(input.projectRef, input.deploymentId);
    const release = await this.storage.releaseRecord(input.projectRef, input.deploymentId, input.releaseId);
    const checkpoint = existing ? undefined : await this.preparedCheckpoint(
      input,
      await this.storage.activeRelease(input.projectRef, input.deploymentId),
    );
    return this.executeClaimed(input, await this.claim(input, checkpoint), deployment, release);
  }

  async resume(
    input: ActivateFrontendReleaseInput,
    claim: ClaimedActivation,
  ): Promise<FrontendReleaseActivation> {
    if (claim.replayed || !claim.leaseToken || claim.fencingEpoch < 1) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_CHECKPOINT_INVALID",
        503,
        "Frontend release recovery claim is invalid",
      );
    }
    return this.deploymentLock(input.projectRef, input.deploymentId, () =>
      this.executeClaimed(input, claim));
  }
}
