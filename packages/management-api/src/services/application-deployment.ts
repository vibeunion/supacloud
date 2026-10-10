import { parseApplicationReadinessReport } from "@supacloud/delivery";
import type { WorkerExecutionGroup } from "@supacloud/delivery";
import {
  ApplicationActivationService, createApplicationActivationMutations, type ActivateApplicationInput, type ApplicationActivationMutations,
  type ApplicationActiveRecord, type ReconcileApplicationActivationInput,
} from "./application-activation";
import { ApplicationActiveStorage } from "./application-active-storage";
import { applicationGatewayRoute, type ApplicationGatewayInput } from "./application-gateway";
import { ApplicationMigrations } from "./application-migrations";
import { ApplicationReadiness } from "./application-readiness";
import { ApplicationReleaseStorage } from "./application-release-storage";
import { applicationRuntimePlan, ApplicationSystemdRuntime, type ApplicationRuntimeInput } from "./application-runtime";
import { ApplicationRuntimeFiles, type ApplicationTargetEnvironment } from "./application-runtime-files";
import { gatewayService, type GatewayProvider } from "./gateway.service";
import { stableSha256, stableStringify } from "../utils/stable-json";
import { ApplicationConfigurations } from "./application-configuration";
import { ApplicationRuntimeAllocations, type ApplicationRuntimeAllocation } from "./application-runtime-allocation";
import { isProjectMutationId } from "./project-mutation.service";

export interface DeployApplicationInput extends ActivateApplicationInput {
  hosts: ApplicationGatewayInput["hosts"];
}

export interface ApplicationDeploymentDependencies {
  withProjectLifecycle?<T>(projectRef: string, operation: () => Promise<T>): Promise<T>;
  verifyCompatibility(input: {
    runtime: ApplicationRuntimeInput;
    previous: ApplicationActiveRecord | null;
    environment: ApplicationTargetEnvironment;
    migrations: Awaited<ReturnType<ApplicationMigrations["inspect"]>>;
  }): Promise<void>;
  /** Observe paused admission, zero held operations and an empty old queue before retiring a route. */
  verifyWorkerRetirement?(input: {
    runtime: ApplicationRuntimeInput; previous: ApplicationActiveRecord; groups: readonly WorkerExecutionGroup[];
  }): Promise<void>;
  /** Verify an allocation's worker queues before releasing its reservation. */
  verifyWorkerAllocationRetirement?(input: {
    runtime: ApplicationRuntimeInput; groups: readonly WorkerExecutionGroup[];
  }): Promise<void>;
  mutations?: ApplicationActivationMutations;
  storage?: ApplicationReleaseStorage;
  files?: Pick<ApplicationRuntimeFiles, "prepare">;
  runtime?: Pick<ApplicationSystemdRuntime, "install" | "start" | "stop" | "requireStopped">;
  active?: Pick<ApplicationActiveStorage, "read" | "write" | "confirm">
    & Partial<Pick<ApplicationActiveStorage, "readForApplication" | "clear">>;
  readiness?: Pick<ApplicationReadiness, "requireReady">;
  migrations?: Pick<ApplicationMigrations, "inspect">;
  gateway?: Pick<GatewayProvider, "configureApplicationRoute" | "verifyApplicationRoute">
    & Partial<Pick<GatewayProvider, "removeApplicationRoute" | "verifyApplicationRouteAbsent">>;
  configurations?: Pick<ApplicationConfigurations, "resolve">;
  allocations?: Pick<ApplicationRuntimeAllocations, "allocate">
    & Partial<Pick<ApplicationRuntimeAllocations, "read" | "retire">>;
  retirementVerifier?: (input: {
    allocation: ApplicationRuntimeAllocation;
    active: ApplicationActiveRecord | null;
    configuration: Awaited<ReturnType<ApplicationConfigurations["resolve"]>>;
  }) => Promise<void>;
}

function traffic(record: ApplicationActiveRecord): ApplicationGatewayInput {
  if (record.hosts === undefined) throw new Error("APPLICATION_DEPLOYMENT_HOSTS_REQUIRED");
  const input = { runtime: record.runtime, hosts: record.hosts };
  applicationGatewayRoute(input);
  return input;
}

/** Compose existing host services; application-specific compatibility has no no-op default. */
export class ApplicationDeploymentService {
  private readonly activation: ApplicationActivationService;
  private readonly configurations: Pick<ApplicationConfigurations, "resolve">;
  private readonly allocations: Pick<ApplicationRuntimeAllocations, "allocate">
    & Partial<Pick<ApplicationRuntimeAllocations, "read" | "retire">>;
  private readonly retirementVerifier?: ApplicationDeploymentDependencies["retirementVerifier"];
  private readonly verifyWorkerAllocationRetirement?: ApplicationDeploymentDependencies["verifyWorkerAllocationRetirement"];
  private readonly active: Partial<Pick<ApplicationActiveStorage, "readForApplication" | "clear">>;
  private readonly storage: ApplicationReleaseStorage;
  private readonly withProjectLifecycle: NonNullable<ApplicationDeploymentDependencies["withProjectLifecycle"]>;
  private readonly runtime: NonNullable<ApplicationDeploymentDependencies["runtime"]>;
  private readonly gateway: NonNullable<ApplicationDeploymentDependencies["gateway"]>;
  private readonly mutations: ApplicationActivationMutations;

  constructor(dependencies: ApplicationDeploymentDependencies) {
    if (typeof dependencies.verifyCompatibility !== "function") throw new Error("APPLICATION_COMPATIBILITY_VERIFIER_REQUIRED");
    this.configurations = dependencies.configurations ?? new ApplicationConfigurations();
    this.allocations = dependencies.allocations ?? new ApplicationRuntimeAllocations();
    this.retirementVerifier = dependencies.retirementVerifier;
    this.verifyWorkerAllocationRetirement = dependencies.verifyWorkerAllocationRetirement;
    this.withProjectLifecycle = dependencies.withProjectLifecycle ?? (async (_ref, operation) => operation());
    const storage = dependencies.storage ?? new ApplicationReleaseStorage();
    this.storage = storage;
    const files = dependencies.files ?? new ApplicationRuntimeFiles(storage);
    const runtime = dependencies.runtime ?? new ApplicationSystemdRuntime();
    this.runtime = runtime;
    const active = dependencies.active ?? new ApplicationActiveStorage();
    this.active = active;
    const readiness = dependencies.readiness ?? new ApplicationReadiness();
    const migrations = dependencies.migrations ?? new ApplicationMigrations({ storage });
    const gateway = dependencies.gateway ?? gatewayService;
    this.gateway = gateway;
    this.mutations = dependencies.mutations ?? createApplicationActivationMutations();
    this.activation = new ApplicationActivationService({
      mutations: this.mutations,
      readActive: input => active.read(input),
      writeActive: (record, expected) => active.write(record, expected),
      confirmActive: record => active.confirm(record),
      checkCompatibility: async (input, previous, environment) => {
        const release = await storage.readRelease(input.release.project_ref, input.release.application_id, input.release.release_id);
        if (stableStringify(release) !== stableStringify(input.release)) throw new Error("APPLICATION_RUNTIME_RELEASE_MISMATCH");
        if (release.targets.some(target => target.execution)) {
          if (!this.allocations.read) throw new Error("WORKER_ALLOCATION_REQUIRED");
          const allocation = await this.allocations.read(release.project_ref, input.activationId);
          if (!allocation || allocation.retiredAt || stableStringify(allocation.runtime) !== stableStringify(input)) {
            throw new Error("WORKER_ALLOCATION_REQUIRED");
          }
        }
        if (previous) {
          traffic(previous);
          const previousPorts = new Set(Object.values(previous.runtime.ports));
          if (Object.values(input.ports).some(port => previousPorts.has(port))) {
            throw new Error("APPLICATION_DEPLOYMENT_PORT_CONFLICT");
          }
          const removedGroups = previous.runtime.release.targets.flatMap(target => target.execution
            && !input.release.targets.some(next => next.execution
              && next.execution.queue === target.execution!.queue
              && next.execution.taskKey === target.execution!.taskKey
              && next.execution.definitionVersion === target.execution!.definitionVersion
              && next.execution.name === target.execution!.name)
            ? [target.execution] : []);
          if (removedGroups.length) {
            if (!dependencies.verifyWorkerRetirement) throw new Error("WORKER_RETIREMENT_VERIFIER_REQUIRED");
            await dependencies.verifyWorkerRetirement({
              runtime: structuredClone(input), previous: structuredClone(previous), groups: removedGroups,
            });
          }
        }
        const report = await migrations.inspect(input.release.project_ref, input.release.application_id, input.release.release_id);
        if (!report.project_migrations_applied) throw new Error("APPLICATION_MIGRATIONS_NOT_APPLIED");
        // This callback must verify actual schema/runtime and operator provisioning;
        // matching project SQL identities alone is not application compatibility.
        await dependencies.verifyCompatibility({
          runtime: structuredClone(input), previous: structuredClone(previous),
          environment: structuredClone(environment), migrations: report,
        });
      },
      prepare: async (input, environment) => { await files.prepare(input, environment); await runtime.install(input); },
      start: async input => { await runtime.start(input); },
      stop: async input => { await runtime.stop(input); },
      requireReady: async input => {
        const report = parseApplicationReadinessReport(await readiness.requireReady(input));
        const plan = applicationRuntimePlan(input);
        if (!report.ready || report.project_ref !== plan.projectRef || report.application_id !== plan.applicationId
          || report.environment_id !== plan.environmentId || report.release_id !== plan.releaseId
          || report.activation_id !== plan.activationId || report.targets.length !== plan.targets.length
          || plan.targets.some(target => !report.targets.some(observed =>
            observed.target === target.name && observed.kind === target.kind && observed.unit === target.unit))) {
          throw new Error("APPLICATION_DEPLOYMENT_NOT_READY");
        }
      },
      requireStopped: async input => { await runtime.requireStopped(input); },
      route: async record => { await gateway.configureApplicationRoute(traffic(record)); },
      verifyRoute: async record => { await gateway.verifyApplicationRoute(traffic(record)); },
    });
  }

  activate(input: DeployApplicationInput) {
    if (input.hosts === undefined) throw new Error("APPLICATION_DEPLOYMENT_HOSTS_REQUIRED");
    applicationGatewayRoute({ runtime: input.runtime, hosts: input.hosts });
    return this.withProjectLifecycle(input.runtime.release.project_ref, () => this.activation.activate(input));
  }

  reconcile(input: ReconcileApplicationActivationInput) {
    return this.withProjectLifecycle(input.projectRef, () => this.activation.reconcile(input));
  }

  async retireConfigured(input: {
    projectRef: string;
    applicationId: string;
    environmentId: string;
    activationId: string;
    principal: ActivateApplicationInput["principal"];
  }) {
    if (!this.retirementVerifier) throw new Error("APPLICATION_RETIREMENT_VERIFIER_REQUIRED");
    if (!this.allocations.read || !this.allocations.retire || !this.active.readForApplication) {
      throw new Error("APPLICATION_RETIREMENT_COMPOSITION_REQUIRED");
    }
    const projectRef = input.projectRef;
    const allocation = await this.allocations.read(projectRef, input.activationId);
    if (!allocation) throw new Error("APPLICATION_PORT_ALLOCATION_MISSING");
    const release = allocation.runtime.release;
    if (release.project_ref !== projectRef || release.application_id !== input.applicationId
      || allocation.runtime.environmentId !== input.environmentId) {
      throw new Error("APPLICATION_PORT_ALLOCATION_IDENTITY_INVALID");
    }
    const active = await this.active.readForApplication(
      projectRef, release.application_id, input.environmentId,
    );
    if (active?.runtime.activationId === input.activationId) {
      throw new Error("APPLICATION_ACTIVE_ALLOCATION_CANNOT_RETIRE");
    }
    const configuration = await this.configurations.resolve({
      projectRef, applicationId: release.application_id, environmentId: input.environmentId,
    }, allocation.configurationId, release);
    const retiredGroups = release.targets.flatMap(target => target.execution
      && !active?.runtime.release.targets.some(next => next.execution
        && next.execution.queue === target.execution!.queue
        && next.execution.taskKey === target.execution!.taskKey
        && next.execution.definitionVersion === target.execution!.definitionVersion
        && next.execution.name === target.execution!.name)
      ? [target.execution] : []);
    if (retiredGroups.length) {
      if (!this.verifyWorkerAllocationRetirement) throw new Error("WORKER_RETIREMENT_VERIFIER_REQUIRED");
      await this.verifyWorkerAllocationRetirement({ runtime: structuredClone(allocation.runtime), groups: retiredGroups });
    }
    const retired = await this.allocations.retire(projectRef, input.activationId, allocationValue =>
      this.retirementVerifier!({ allocation: allocationValue, active, configuration }));
    if (!retired.retiredAt) throw new Error("APPLICATION_PORT_RETIREMENT_UNCONFIRMED");
    return {
      project_ref: projectRef, application_id: release.application_id,
      environment_id: input.environmentId, activation_id: input.activationId,
      retired_at: retired.retiredAt,
    };
  }

  async activateConfigured(input: {
    runtime: Omit<ApplicationRuntimeInput, "bunVersion" | "ports">;
    configurationId: string;
    expectedActivationId: string | null;
    principal: ActivateApplicationInput["principal"];
  }) {
    return this.withProjectLifecycle(input.runtime.release.project_ref,
      () => this.activateConfiguredUnderLock(input));
  }

  async deactivateConfigured(input: {
    projectRef: string;
    applicationId: string;
    environmentId: string;
    activationId: string;
    mutationId: string;
    principal: ActivateApplicationInput["principal"];
  }) {
    const request = structuredClone(input);
    if (!isProjectMutationId(request.mutationId) || !isProjectMutationId(request.activationId)
      || request.mutationId === request.activationId) throw new Error("APPLICATION_DEACTIVATION_IDENTITY_INVALID");
    return this.withProjectLifecycle(request.projectRef, async () => {
      if (!this.allocations.read || !this.allocations.retire || !this.active.readForApplication || !this.active.clear
        || !this.gateway.removeApplicationRoute || !this.gateway.verifyApplicationRouteAbsent) {
        throw new Error("APPLICATION_DEACTIVATION_COMPOSITION_REQUIRED");
      }
      let allocation = await this.allocations.read(request.projectRef, request.activationId);
      if (!allocation) throw new Error("APPLICATION_PORT_ALLOCATION_MISSING");
      const runtime = allocation.runtime;
      if (runtime.release.project_ref !== request.projectRef || runtime.release.application_id !== request.applicationId
        || runtime.environmentId !== request.environmentId || runtime.activationId !== request.activationId) {
        throw new Error("APPLICATION_PORT_ALLOCATION_IDENTITY_INVALID");
      }
      const configuration = await this.configurations.resolve({
        projectRef: request.projectRef, applicationId: request.applicationId, environmentId: request.environmentId,
      }, allocation.configurationId, runtime.release);
      const route = { runtime, hosts: configuration.hosts };
      applicationGatewayRoute(route);
      const fingerprint = stableSha256({ schema: "supacloud.application-deactivation.v1", request, runtime,
        configurationId: allocation.configurationId });
      const receipt = {
        project_ref: request.projectRef, application_id: request.applicationId, environment_id: request.environmentId,
        activation_id: request.activationId, mutation_id: request.mutationId, deactivated: true,
      };
      const verify = async () => {
        if (await this.active.readForApplication!(request.projectRef, request.applicationId, request.environmentId)) {
          throw new Error("APPLICATION_DEACTIVATION_AUTHORITY_PRESENT");
        }
        await this.runtime.requireStopped(runtime);
        await this.gateway.verifyApplicationRouteAbsent!(route);
        allocation = await this.allocations.read!(request.projectRef, request.activationId);
        if (!allocation?.retiredAt) throw new Error("APPLICATION_PORT_RETIREMENT_UNCONFIRMED");
        await this.active.clear!(runtime, request.activationId);
      };
      const begun = await this.mutations.begin({
        projectRef: request.projectRef, mutationId: request.mutationId,
        operation: "application.release.deactivate", principal: request.principal, requestFingerprint: fingerprint,
        resource: { type: "application_release", id: stableSha256({
          applicationId: request.applicationId, environmentId: request.environmentId,
        }) },
      });
      if (!begun.lease) {
        if (begun.state.checkpoint["schema"] !== "supacloud.application-deactivation.v1"
          || begun.state.checkpoint["fingerprint"] !== fingerprint
          || begun.state.checkpoint["activation_id"] !== request.activationId
          || !["unrouted", "retired"].includes(String(begun.state.checkpoint["phase"]))) {
          throw new Error("APPLICATION_DEACTIVATION_RECONCILIATION_REQUIRED");
        }
        await verify();
        if (begun.state.status === "outcome_unknown") await this.mutations.recover(begun.state, fingerprint);
        else if (begun.state.status !== "succeeded") throw new Error("APPLICATION_DEACTIVATION_RECONCILIATION_REQUIRED");
        const stored = await this.mutations.read(request.projectRef, request.mutationId);
        if (!stored || stored.status !== "succeeded" || stored.requestFingerprint !== fingerprint
          || stored.operation !== "application.release.deactivate") {
          throw new Error("APPLICATION_DEACTIVATION_RECEIPT_INVALID");
        }
        if (stableStringify(stored.receipt) !== stableStringify(receipt)) {
          const recovery = stored.receipt?.["reconciliation"];
          if (!recovery || typeof recovery !== "object" || !("evidence_fingerprint" in recovery)
            || recovery.evidence_fingerprint !== fingerprint) throw new Error("APPLICATION_DEACTIVATION_RECEIPT_INVALID");
        }
        await verify();
        return receipt;
      }
      const lease = begun.lease;
      let effects = false;
      let completed = false;
      try {
        if (Object.keys(begun.state.checkpoint).length) {
          effects = true;
          throw new Error("APPLICATION_DEACTIVATION_RECONCILIATION_REQUIRED");
        }
        const current = await this.active.readForApplication(request.projectRef, request.applicationId, request.environmentId);
        if (!current || current.runtime.activationId !== request.activationId
          || stableStringify(current.runtime) !== stableStringify(runtime)
          || current.configurationId !== allocation.configurationId
          || stableStringify(current.hosts) !== stableStringify(configuration.hosts)) {
          throw new Error("APPLICATION_ACTIVATION_REVISION_CONFLICT");
        }
        const groups = runtime.release.targets.flatMap(target => target.execution ? [target.execution] : []);
        if (groups.length) {
          if (!this.verifyWorkerAllocationRetirement) throw new Error("WORKER_RETIREMENT_VERIFIER_REQUIRED");
          await this.verifyWorkerAllocationRetirement({ runtime: structuredClone(runtime), groups });
        }
        await this.mutations.checkpoint(lease, { schema: "supacloud.application-deactivation.v1",
          fingerprint, activation_id: request.activationId, phase: "prepared" });
        effects = true;
        await this.mutations.protect(lease, async () => {
          await this.runtime.stop(runtime);
          await this.runtime.requireStopped(runtime);
        });
        await this.mutations.checkpoint(lease, { schema: "supacloud.application-deactivation.v1",
          fingerprint, activation_id: request.activationId, phase: "stopped" });
        await this.mutations.protect(lease, async () => {
          await this.gateway.removeApplicationRoute!(route);
          await this.gateway.verifyApplicationRouteAbsent!(route);
          await this.active.clear!(runtime, request.activationId);
        });
        await this.mutations.checkpoint(lease, { schema: "supacloud.application-deactivation.v1",
          fingerprint, activation_id: request.activationId, phase: "unrouted" });
        await this.mutations.protect(lease, async () => {
          allocation = await this.allocations.retire!(request.projectRef, request.activationId, async candidate => {
            if (stableStringify(candidate.runtime) !== stableStringify(runtime)) {
              throw new Error("APPLICATION_PORT_ALLOCATION_CHANGED");
            }
            await this.runtime.requireStopped(runtime);
            await this.gateway.verifyApplicationRouteAbsent!(route);
            if (await this.active.readForApplication!(request.projectRef, request.applicationId, request.environmentId)) {
              throw new Error("APPLICATION_DEACTIVATION_AUTHORITY_PRESENT");
            }
          });
          await verify();
        });
        await this.mutations.checkpoint(lease, { schema: "supacloud.application-deactivation.v1",
          fingerprint, activation_id: request.activationId, phase: "retired" });
        await this.mutations.success(lease, receipt);
        completed = true;
        const stored = await this.mutations.read(request.projectRef, request.mutationId);
        if (stored?.status !== "succeeded" || stableStringify(stored.receipt) !== stableStringify(receipt)) {
          throw new Error("APPLICATION_DEACTIVATION_RECEIPT_INVALID");
        }
        return receipt;
      } catch (error) {
        if (!completed) await this.mutations.failure(lease, effects, !effects);
        throw error;
      }
    });
  }

  private async activateConfiguredUnderLock(input: {
    runtime: Omit<ApplicationRuntimeInput, "bunVersion" | "ports">;
    configurationId: string;
    expectedActivationId: string | null;
    principal: ActivateApplicationInput["principal"];
  }) {
    const request = structuredClone(input);
    const release = await this.storage.readRelease(
      request.runtime.release.project_ref, request.runtime.release.application_id, request.runtime.release.release_id,
    );
    if (stableStringify(release) !== stableStringify(request.runtime.release)) throw new Error("APPLICATION_RUNTIME_RELEASE_MISMATCH");
    const configuration = await this.configurations.resolve({
      projectRef: request.runtime.release.project_ref, applicationId: request.runtime.release.application_id,
      environmentId: request.runtime.environmentId,
    }, request.configurationId, request.runtime.release);
    const desired = {
      release, activationId: request.runtime.activationId, environmentId: request.runtime.environmentId,
      bunVersion: configuration.bunVersion,
    };
    const allocation = await this.allocations.allocate({ runtime: desired, configurationId: request.configurationId });
    const { ports: _ports, ...assigned } = allocation.runtime;
    if (allocation.configurationId !== request.configurationId || stableStringify(assigned) !== stableStringify(desired)) {
      throw new Error("APPLICATION_PORT_ALLOCATION_MISMATCH");
    }
    return this.activation.activate({
      runtime: allocation.runtime,
      environment: configuration.environment, hosts: configuration.hosts,
      expectedActivationId: request.expectedActivationId, principal: request.principal,
      configurationId: request.configurationId,
    });
  }
}
