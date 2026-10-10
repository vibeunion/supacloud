import { parseApplicationReadinessReport } from "@supacloud/delivery";
import type { WorkerExecutionGroup } from "@supacloud/delivery";
import {
  ApplicationActivationService, type ActivateApplicationInput, type ApplicationActivationMutations,
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
import { stableStringify } from "../utils/stable-json";
import { ApplicationConfigurations } from "./application-configuration";
import { ApplicationRuntimeAllocations, type ApplicationRuntimeAllocation } from "./application-runtime-allocation";

export interface DeployApplicationInput extends ActivateApplicationInput {
  hosts: ApplicationGatewayInput["hosts"];
}

export interface ApplicationDeploymentDependencies {
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
    & Partial<Pick<ApplicationActiveStorage, "readForApplication">>;
  readiness?: Pick<ApplicationReadiness, "requireReady">;
  migrations?: Pick<ApplicationMigrations, "inspect">;
  gateway?: Pick<GatewayProvider, "configureApplicationRoute" | "verifyApplicationRoute">;
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
  private readonly active: Partial<Pick<ApplicationActiveStorage, "readForApplication">>;
  private readonly storage: ApplicationReleaseStorage;

  constructor(dependencies: ApplicationDeploymentDependencies) {
    if (typeof dependencies.verifyCompatibility !== "function") throw new Error("APPLICATION_COMPATIBILITY_VERIFIER_REQUIRED");
    this.configurations = dependencies.configurations ?? new ApplicationConfigurations();
    this.allocations = dependencies.allocations ?? new ApplicationRuntimeAllocations();
    this.retirementVerifier = dependencies.retirementVerifier;
    this.verifyWorkerAllocationRetirement = dependencies.verifyWorkerAllocationRetirement;
    const storage = dependencies.storage ?? new ApplicationReleaseStorage();
    this.storage = storage;
    const files = dependencies.files ?? new ApplicationRuntimeFiles(storage);
    const runtime = dependencies.runtime ?? new ApplicationSystemdRuntime();
    const active = dependencies.active ?? new ApplicationActiveStorage();
    this.active = active;
    const readiness = dependencies.readiness ?? new ApplicationReadiness();
    const migrations = dependencies.migrations ?? new ApplicationMigrations({ storage });
    const gateway = dependencies.gateway ?? gatewayService;
    this.activation = new ApplicationActivationService({
      ...(dependencies.mutations === undefined ? {} : { mutations: dependencies.mutations }),
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
    return this.activation.activate(input);
  }

  reconcile(input: ReconcileApplicationActivationInput) {
    return this.activation.reconcile(input);
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
    return this.activate({
      runtime: allocation.runtime,
      environment: configuration.environment, hosts: configuration.hosts,
      expectedActivationId: request.expectedActivationId, principal: request.principal,
      configurationId: request.configurationId,
    });
  }
}
