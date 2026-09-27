import type { SQL } from "bun";
import { ApplicationConfigurationIdSchema } from "@supacloud/delivery";
import { Value } from "typebox/value";
import { sql } from "../db";
import { stableSha256, stableStringify } from "../utils/stable-json";
import { applicationRuntimePlan, type ApplicationRuntimeInput } from "./application-runtime";
import type { ApplicationTargetEnvironment } from "./application-runtime-files";
import { applicationGatewayRoute, type ApplicationGatewayInput } from "./application-gateway";
import {
  checkpointProjectMutation, isProjectMutationId,
  type MutationLeaseInput, type MutationPrincipal, type ProjectMutationState,
} from "./project-mutation.service";
import { createProjectReleaseMutations, type ReleaseMutationStore } from "./project-release-mutation";

type Phase = "prepared" | "transitioning" | "started" | "healthy" | "routed" | "committed";
const PHASES: readonly Phase[] = ["prepared", "transitioning", "started", "healthy", "routed", "committed"];

export interface ApplicationActiveRecord {
  schema: "supacloud.application-active.v1";
  runtime: ApplicationRuntimeInput;
  configurationDigest: string;
  configurationId?: string;
  hosts?: ApplicationGatewayInput["hosts"];
}

export interface ActivateApplicationInput {
  runtime: ApplicationRuntimeInput;
  environment: ApplicationTargetEnvironment;
  expectedActivationId: string | null;
  principal: MutationPrincipal;
  hosts?: ApplicationGatewayInput["hosts"];
  configurationId?: string;
}

export interface ReconcileApplicationActivationInput {
  projectRef: string;
  applicationId: string;
  environmentId: string;
  activationId: string;
  principal: MutationPrincipal;
}

interface ActivationCheckpoint {
  schema: "supacloud.application-activation.v1";
  phase: Phase;
  desired: ApplicationActiveRecord;
  previous: ApplicationActiveRecord | null;
}

export interface ApplicationActivationMutations extends ReleaseMutationStore {
  checkpoint(lease: MutationLeaseInput, value: Record<string, unknown>): Promise<void>;
}

export function createApplicationActivationMutations(database: SQL = sql): ApplicationActivationMutations {
  return {
    ...createProjectReleaseMutations(database),
    async checkpoint(lease, value) {
      const result = await database.begin(db => checkpointProjectMutation(db, {
        ...lease, checkpoint: value, leaseSeconds: 3600,
      }));
      if (result !== "updated") throw new Error("APPLICATION_ACTIVATION_LEASE_LOST");
    },
  };
}

export const applicationActivationMutations = createApplicationActivationMutations();

export interface ApplicationActivationPorts {
  mutations?: ApplicationActivationMutations;
  readActive(runtime: ApplicationRuntimeInput): Promise<ApplicationActiveRecord | null>;
  writeActive(record: ApplicationActiveRecord, expectedActivationId: string | null): Promise<void>;
  confirmActive(record: ApplicationActiveRecord): Promise<void>;
  checkCompatibility(
    runtime: ApplicationRuntimeInput, previous: ApplicationActiveRecord | null, environment: ApplicationTargetEnvironment,
  ): Promise<void>;
  prepare(runtime: ApplicationRuntimeInput, environment: ApplicationTargetEnvironment): Promise<void>;
  stop(runtime: ApplicationRuntimeInput): Promise<void>;
  start(runtime: ApplicationRuntimeInput): Promise<void>;
  requireReady(runtime: ApplicationRuntimeInput): Promise<void>;
  requireStopped(runtime: ApplicationRuntimeInput): Promise<void>;
  route(record: ApplicationActiveRecord, previous: ApplicationActiveRecord | null): Promise<void>;
  verifyRoute(record: ApplicationActiveRecord): Promise<void>;
}

export interface ApplicationActivationResult {
  project_ref: string;
  application_id: string;
  environment_id: string;
  release_id: string;
  activation_id: string;
  replayed: boolean;
}

function activeRecord(
  runtime: ApplicationRuntimeInput, environment: ApplicationTargetEnvironment, hosts?: ApplicationGatewayInput["hosts"],
  configurationId?: string,
): ApplicationActiveRecord {
  const plan = applicationRuntimePlan(runtime);
  if (hosts !== undefined) applicationGatewayRoute({ runtime, hosts });
  if (configurationId !== undefined && !Value.Check(ApplicationConfigurationIdSchema, configurationId)) {
    throw new Error("APPLICATION_CONFIGURATION_INVALID_ID");
  }
  return {
    schema: "supacloud.application-active.v1", runtime: { ...structuredClone(runtime), bunVersion: plan.bunVersion },
    configurationDigest: stableSha256(environment),
    ...(configurationId === undefined ? {} : { configurationId }),
    ...(hosts === undefined ? {} : { hosts: structuredClone(hosts) }),
  };
}

export function parseApplicationActiveRecord(candidate: unknown, desired: {
  release: { project_ref: string; application_id: string };
  environmentId: string;
}): ApplicationActiveRecord {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("APPLICATION_ACTIVE_INVALID");
  const value = candidate as Partial<ApplicationActiveRecord>;
  if (value.schema !== "supacloud.application-active.v1" || !value.runtime
    || typeof value.configurationDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.configurationDigest)) {
    throw new Error("APPLICATION_ACTIVE_INVALID");
  }
  if (value.configurationId !== undefined && !Value.Check(ApplicationConfigurationIdSchema, value.configurationId)) {
    throw new Error("APPLICATION_ACTIVE_INVALID");
  }
  applicationRuntimePlan(value.runtime);
  if (value.hosts !== undefined) applicationGatewayRoute({ runtime: value.runtime, hosts: value.hosts });
  if (value.runtime.release.project_ref !== desired.release.project_ref
    || value.runtime.release.application_id !== desired.release.application_id
    || value.runtime.environmentId !== desired.environmentId) throw new Error("APPLICATION_ACTIVE_IDENTITY_MISMATCH");
  return value as ApplicationActiveRecord;
}

function parseCheckpoint(value: Record<string, unknown>, desired: ApplicationActiveRecord): ActivationCheckpoint {
  if (value.schema !== "supacloud.application-activation.v1"
    || !PHASES.includes(value.phase as Phase)
    || stableStringify(decodeRecord(value.desired, desired.runtime)) !== stableStringify(desired)) {
    throw new Error("APPLICATION_ACTIVATION_CHECKPOINT_INVALID");
  }
  return {
    schema: "supacloud.application-activation.v1", phase: value.phase as Phase, desired,
    previous: value.previous === null ? null : decodeRecord(value.previous, desired.runtime),
  };
}

function encodeRecord(record: ApplicationActiveRecord) {
  const { release, activationId, environmentId, bunVersion, ports } = record.runtime;
  return {
    schema: record.schema, configurationDigest: record.configurationDigest,
    ...(record.configurationId === undefined ? {} : { configurationId: record.configurationId }),
    ...(record.hosts === undefined ? {} : {
      hosts: Object.entries(record.hosts).sort(([a], [b]) => a.localeCompare(b))
        .map(([target, hosts]) => ({ target, hosts })),
    }),
    runtime: {
      release, activationId, environmentId, ...(bunVersion ? { bunVersion } : {}),
      ports: Object.entries(ports).sort(([a], [b]) => a.localeCompare(b))
        .map(([target, port]) => ({ target, port })),
    },
  };
}

function decodeRecord(candidate: unknown, desired: {
  release: { project_ref: string; application_id: string }; environmentId: string;
}): ApplicationActiveRecord {
  if (!candidate || typeof candidate !== "object" || !("runtime" in candidate)
    || !candidate.runtime || typeof candidate.runtime !== "object" || !("ports" in candidate.runtime)
    || !Array.isArray(candidate.runtime.ports) || candidate.runtime.ports.length > 32) {
    throw new Error("APPLICATION_ACTIVATION_CHECKPOINT_INVALID");
  }
  const entries = candidate.runtime.ports.map((entry: unknown): [string, number] => {
    if (!entry || typeof entry !== "object" || !("target" in entry) || !("port" in entry)
      || typeof entry.target !== "string" || typeof entry.port !== "number") {
      throw new Error("APPLICATION_ACTIVATION_CHECKPOINT_INVALID");
    }
    return [entry.target, entry.port];
  });
  if (new Set(entries.map(([target]) => target)).size !== entries.length) {
    throw new Error("APPLICATION_ACTIVATION_CHECKPOINT_INVALID");
  }
  let hosts: ApplicationGatewayInput["hosts"] | undefined;
  if ("hosts" in candidate) {
    if (!Array.isArray(candidate.hosts) || candidate.hosts.length > 32) throw new Error("APPLICATION_ACTIVATION_CHECKPOINT_INVALID");
    const bindings = candidate.hosts.map((entry: unknown): [string, string[]] => {
      if (!entry || typeof entry !== "object" || !("target" in entry) || typeof entry.target !== "string"
        || !("hosts" in entry) || !Array.isArray(entry.hosts) || entry.hosts.some(host => typeof host !== "string")) {
        throw new Error("APPLICATION_ACTIVATION_CHECKPOINT_INVALID");
      }
      return [entry.target, entry.hosts];
    });
    if (new Set(bindings.map(([target]) => target)).size !== bindings.length) throw new Error("APPLICATION_ACTIVATION_CHECKPOINT_INVALID");
    hosts = Object.fromEntries(bindings);
  }
  return parseApplicationActiveRecord({
    ...candidate, runtime: { ...candidate.runtime, ports: Object.fromEntries(entries) },
    ...(hosts === undefined ? {} : { hosts }),
  }, desired);
}

function result(runtime: ApplicationRuntimeInput, replayed: boolean): ApplicationActivationResult {
  return {
    project_ref: runtime.release.project_ref, application_id: runtime.release.application_id,
    environment_id: runtime.environmentId, release_id: runtime.release.release_id,
    activation_id: runtime.activationId, replayed,
  };
}

function recoveryFingerprint(desired: ApplicationActiveRecord): string {
  return stableSha256({ schema: "supacloud.application-activation-recovery.v1", desired });
}

function hasSuccessReceipt(state: ProjectMutationState, desired: ApplicationActiveRecord): boolean {
  if (state.status !== "succeeded" || state.responseStatus !== 200) return false;
  if (stableStringify(state.receipt) === stableStringify(result(desired.runtime, false))) return true;
  const reconciliation = state.receipt?.reconciliation;
  if (!reconciliation || typeof reconciliation !== "object" || Array.isArray(reconciliation)
    || !("observed_at" in reconciliation) || typeof reconciliation.observed_at !== "string") return false;
  const observedAt = new Date(reconciliation.observed_at);
  if (!Number.isFinite(observedAt.getTime()) || observedAt.toISOString() !== reconciliation.observed_at) return false;
  return stableStringify(state.receipt) === stableStringify({ reconciliation: {
    source: "project.release.authority", observed_at: reconciliation.observed_at,
    evidence_code: "RELEASE_AUTHORITY_CONFIRMED", evidence_fingerprint: recoveryFingerprint(desired),
    target_status: "succeeded",
  } });
}

/**
 * Controlled stop/start activation. Storage, readiness and gateway adapters must
 * provide real verification; none has a successful no-op default.
 */
export class ApplicationActivationService {
  private readonly mutations: ApplicationActivationMutations;

  constructor(private readonly ports: ApplicationActivationPorts) {
    this.mutations = ports.mutations ?? applicationActivationMutations;
  }

  async activate(input: ActivateApplicationInput): Promise<ApplicationActivationResult> {
    const environment = structuredClone(input.environment);
    const desired = activeRecord(input.runtime, environment, input.hosts, input.configurationId);
    if (input.expectedActivationId !== null && !isProjectMutationId(input.expectedActivationId)) {
      throw new Error("APPLICATION_ACTIVATION_EXPECTED_ID_INVALID");
    }
    const runtime = desired.runtime;
    const begun = await this.mutations.begin({
      projectRef: runtime.release.project_ref, mutationId: runtime.activationId,
      operation: "application.release.activate",
      resource: { type: "application_release", id: stableSha256({
        applicationId: runtime.release.application_id, environmentId: runtime.environmentId,
      }) },
      principal: input.principal,
      requestFingerprint: stableSha256({ desired, expectedActivationId: input.expectedActivationId }),
    });
    if (!begun.lease) {
      if (begun.state.status !== "succeeded") throw new Error("APPLICATION_ACTIVATION_OUTCOME_UNRESOLVED");
      if (!hasSuccessReceipt(begun.state, desired)) {
        throw new Error("APPLICATION_ACTIVATION_RECEIPT_INVALID");
      }
      await this.verifyDesired(desired);
      return result(runtime, true);
    }
    const lease = begun.lease;
    let sideEffects = false;
    let completed = false;
    try {
      let checkpoint: ActivationCheckpoint;
      if (Object.keys(begun.state.checkpoint).length) {
        checkpoint = parseCheckpoint(begun.state.checkpoint, desired);
        // An interrupted process transition requires explicit observation and
        // reconciliation, not blindly replaying worker start or traffic writes.
        if (checkpoint.phase !== "prepared") {
          sideEffects = true;
          throw new Error("APPLICATION_ACTIVATION_RECONCILIATION_REQUIRED");
        }
      } else {
        const active = await this.ports.readActive(runtime);
        const previous = active === null ? null : parseApplicationActiveRecord(active, runtime);
        if ((previous?.runtime.activationId ?? null) !== input.expectedActivationId) {
          throw new Error("APPLICATION_ACTIVATION_REVISION_CONFLICT");
        }
        checkpoint = { schema: "supacloud.application-activation.v1", phase: "prepared", desired, previous };
        await this.save(lease, checkpoint);
      }
      if ((checkpoint.previous?.runtime.activationId ?? null) !== input.expectedActivationId) {
        throw new Error("APPLICATION_ACTIVATION_CHECKPOINT_INVALID");
      }
      await this.mutations.protect(lease, async () => {
        const active = await this.ports.readActive(runtime);
        if (stableStringify(active) !== stableStringify(checkpoint.previous)) {
          throw new Error("APPLICATION_ACTIVATION_REVISION_CONFLICT");
        }
        await this.ports.checkCompatibility(runtime, checkpoint.previous, environment);
        await this.ports.prepare(runtime, environment);
      });
      checkpoint = { ...checkpoint, phase: "transitioning" };
      await this.save(lease, checkpoint);
      sideEffects = true;
      await this.mutations.protect(lease, async () => {
        if (checkpoint.previous) await this.ports.stop(checkpoint.previous.runtime);
        await this.ports.start(runtime);
      });
      checkpoint = { ...checkpoint, phase: "started" };
      await this.save(lease, checkpoint);
      await this.mutations.protect(lease, () => this.ports.requireReady(runtime));
      checkpoint = { ...checkpoint, phase: "healthy" };
      await this.save(lease, checkpoint);
      await this.mutations.protect(lease, async () => {
        await this.ports.route(desired, checkpoint.previous);
        await this.ports.verifyRoute(desired);
      });
      checkpoint = { ...checkpoint, phase: "routed" };
      await this.save(lease, checkpoint);
      await this.mutations.protect(lease, async () => {
        await this.ports.writeActive(desired, input.expectedActivationId);
        await this.verifyDesired(desired);
      });
      checkpoint = { ...checkpoint, phase: "committed" };
      await this.save(lease, checkpoint);
      await this.mutations.success(lease, result(runtime, false) as unknown as Record<string, unknown>);
      completed = true;
      const stored = await this.mutations.read(runtime.release.project_ref, runtime.activationId);
      if (stored?.status !== "succeeded"
        || stableStringify(stored.receipt) !== stableStringify(result(runtime, false))) {
        throw new Error("APPLICATION_ACTIVATION_RECEIPT_INVALID");
      }
      return result(runtime, false);
    } catch (error) {
      // No compensating database migration or automatic re-execution of unknown
      // effects. Keep the checkpoint and block this resource until reconciled.
      if (!completed) await this.mutations.failure(lease, sideEffects, !sideEffects);
      throw error;
    }
  }

  /** Confirm an already committed activation; never replay process or gateway effects. */
  async reconcile(input: ReconcileApplicationActivationInput): Promise<ApplicationActivationResult> {
    if (!/^[a-z0-9-]{1,20}$/.test(input.projectRef)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(input.applicationId)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(input.environmentId) || !isProjectMutationId(input.activationId)) {
      throw new Error("APPLICATION_ACTIVATION_IDENTITY_INVALID");
    }
    let state = await this.mutations.read(input.projectRef, input.activationId);
    if (!state || state.operation !== "application.release.activate" || state.projectRef !== input.projectRef
      || state.mutationId !== input.activationId || stableStringify(state.principal) !== stableStringify(input.principal)) {
      throw new Error("APPLICATION_ACTIVATION_RECOVERY_IDENTITY_MISMATCH");
    }
    const desired = decodeRecord(state.checkpoint.desired, {
      release: { project_ref: input.projectRef, application_id: input.applicationId }, environmentId: input.environmentId,
    });
    const checkpoint = parseCheckpoint(state.checkpoint, desired);
    if (desired.runtime.activationId !== input.activationId
      || state.requestFingerprint !== stableSha256({
        desired, expectedActivationId: checkpoint.previous?.runtime.activationId ?? null,
      })) throw new Error("APPLICATION_ACTIVATION_CHECKPOINT_INVALID");
    if (!["routed", "committed"].includes(checkpoint.phase)) {
      throw new Error("APPLICATION_ACTIVATION_RECOVERY_OBSERVATION_REQUIRED");
    }
    if (state.status !== "succeeded" && state.status !== "outcome_unknown") {
      if (state.status !== "running") throw new Error("APPLICATION_ACTIVATION_NOT_RECOVERABLE");
      // The normal claim protocol rejects a live owner. An expired owner may be
      // fenced out and marked unknown without replaying its interrupted effects.
      const begun = await this.mutations.begin({
        projectRef: state.projectRef, mutationId: state.mutationId, operation: state.operation,
        resource: { type: "application_release", id: stableSha256({
          applicationId: input.applicationId, environmentId: input.environmentId,
        }) },
        principal: input.principal, requestFingerprint: state.requestFingerprint,
      });
      if (begun.lease) await this.mutations.failure(begun.lease, true);
      const current = await this.mutations.read(input.projectRef, input.activationId);
      if (!current || stableStringify(current.checkpoint) !== stableStringify(state.checkpoint)) {
        throw new Error("APPLICATION_ACTIVATION_RECOVERY_STATE_CHANGED");
      }
      state = current;
    }
    if (state.status === "succeeded") {
      if (!hasSuccessReceipt(state, desired)) throw new Error("APPLICATION_ACTIVATION_RECEIPT_INVALID");
    } else if (state.status !== "outcome_unknown") {
      throw new Error("APPLICATION_ACTIVATION_NOT_RECOVERABLE");
    }
    if (checkpoint.previous) await this.ports.requireStopped(checkpoint.previous.runtime);
    await this.ports.confirmActive(desired);
    await this.verifyDesired(desired);
    if (checkpoint.previous) await this.ports.requireStopped(checkpoint.previous.runtime);
    if (state.status !== "succeeded") await this.mutations.recover(state, recoveryFingerprint(desired));
    const recovered = await this.mutations.read(input.projectRef, input.activationId);
    if (!recovered || !hasSuccessReceipt(recovered, desired)) throw new Error("APPLICATION_ACTIVATION_RECEIPT_INVALID");
    await this.verifyDesired(desired);
    return result(desired.runtime, true);
  }

  private save(lease: MutationLeaseInput, checkpoint: ActivationCheckpoint): Promise<void> {
    return this.mutations.checkpoint(lease, {
      ...checkpoint,
      desired: encodeRecord(checkpoint.desired),
      previous: checkpoint.previous === null ? null : encodeRecord(checkpoint.previous),
    });
  }

  private async verifyDesired(desired: ApplicationActiveRecord): Promise<void> {
    const current = await this.ports.readActive(desired.runtime);
    if (stableStringify(current) !== stableStringify(desired)) throw new Error("APPLICATION_ACTIVATION_READBACK_MISMATCH");
    await this.ports.requireReady(desired.runtime);
    await this.ports.verifyRoute(desired);
    if (stableStringify(await this.ports.readActive(desired.runtime)) !== stableStringify(desired)) {
      throw new Error("APPLICATION_ACTIVATION_READBACK_MISMATCH");
    }
  }
}
