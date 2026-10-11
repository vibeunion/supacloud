import {
  ApplicationConfigurationIdSchema, ApplicationReleaseIdSchema, assertApplicationConfigurationScope,
  parseApplicationDeployPlan, parseApplicationReadinessReport, parseApplicationReleaseRecord,
  type ApplicationDeployPlan, type ApplicationReleaseRecord,
} from "@supacloud/delivery";
import { Value } from "typebox/value";
import {
  applicationActivationMutations, parseApplicationActiveRecord, parseSuccessfulApplicationActivation,
  type ApplicationActivationMutations, type ApplicationActiveRecord,
} from "./application-activation";
import { ApplicationActiveStorage } from "./application-active-storage";
import { ApplicationConfigurations } from "./application-configuration";
import { ApplicationReleaseStorage } from "./application-release-storage";
import { ApplicationMigrations } from "./application-migrations";
import { ApplicationReadiness } from "./application-readiness";
import { applicationRuntimePlan } from "./application-runtime";
import { gatewayService } from "./gateway.service";
import { readActiveProjectMutationForResource } from "./project-mutation.service";
import { stableSha256, stableStringify } from "../utils/stable-json";

interface Scope { projectRef: string; applicationId: string; environmentId: string }
export interface ApplicationDeployPlanInput extends Scope { releaseId: string; configurationId: string }

export class ApplicationDeployPlanError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); }
}

interface Dependencies {
  active?: Pick<ApplicationActiveStorage, "readForApplication">;
  mutations?: Pick<ApplicationActivationMutations, "read">;
  releases?: Pick<ApplicationReleaseStorage, "readRelease">;
  configurations?: Pick<ApplicationConfigurations, "resolve">;
  migrations?: Pick<ApplicationMigrations, "inspect">;
  readiness?: Pick<ApplicationReadiness, "inspect">;
  assertIdle?: (scope: Scope) => Promise<void>;
  verifyRoute?: (record: ApplicationActiveRecord) => Promise<void>;
}

function targetChanges(candidate: ApplicationReleaseRecord, current: ApplicationReleaseRecord | null) {
  const before = new Map(current?.targets.map(target => [target.name, target]));
  const after = new Map(candidate.targets.map(target => [target.name, target]));
  return {
    added: [...after.keys()].filter(name => !before.has(name)).sort(),
    removed: [...before.keys()].filter(name => !after.has(name)).sort(),
    changed: [...after.keys()].filter(name => before.has(name)
      && stableStringify(before.get(name)) !== stableStringify(after.get(name))).sort(),
  };
}

/** 计划仅观察稳定证据；实际激活仍须执行原有兼容性和 CAS 门禁。 */
export class ApplicationDeployPlans {
  private readonly active: Pick<ApplicationActiveStorage, "readForApplication">;
  private readonly mutations: Pick<ApplicationActivationMutations, "read">;
  private readonly releases: Pick<ApplicationReleaseStorage, "readRelease">;
  private readonly configurations: Pick<ApplicationConfigurations, "resolve">;
  private readonly migrations: Pick<ApplicationMigrations, "inspect">;
  private readonly readiness: Pick<ApplicationReadiness, "inspect">;
  private readonly assertIdle: (scope: Scope) => Promise<void>;
  private readonly verifyRoute: (record: ApplicationActiveRecord) => Promise<void>;

  constructor(dependencies: Dependencies = {}) {
    this.active = dependencies.active ?? new ApplicationActiveStorage();
    this.mutations = dependencies.mutations ?? applicationActivationMutations;
    this.releases = dependencies.releases ?? new ApplicationReleaseStorage();
    this.configurations = dependencies.configurations ?? new ApplicationConfigurations();
    this.migrations = dependencies.migrations ?? new ApplicationMigrations();
    this.readiness = dependencies.readiness ?? new ApplicationReadiness();
    this.assertIdle = dependencies.assertIdle ?? (async scope => {
      const mutation = await readActiveProjectMutationForResource(scope.projectRef, {
        type: "application_release",
        id: stableSha256({ applicationId: scope.applicationId, environmentId: scope.environmentId }),
      });
      if (mutation) throw new ApplicationDeployPlanError("APPLICATION_DEPLOY_PLAN_BUSY", 409);
    });
    this.verifyRoute = dependencies.verifyRoute ?? (async record => {
      if (!record.hosts) throw new Error("APPLICATION_DEPLOY_PLAN_HOSTS_REQUIRED");
      await gatewayService.verifyApplicationRoute({ runtime: record.runtime, hosts: record.hosts });
    });
  }

  async read(input: ApplicationDeployPlanInput): Promise<ApplicationDeployPlan> {
    const { projectRef, applicationId, environmentId, releaseId, configurationId } = structuredClone(input);
    const scope = { projectRef, applicationId, environmentId };
    try {
      assertApplicationConfigurationScope(scope);
      if (!Value.Check(ApplicationReleaseIdSchema, releaseId)
        || !Value.Check(ApplicationConfigurationIdSchema, configurationId)) throw new Error("Invalid candidate");
    } catch { throw new ApplicationDeployPlanError("APPLICATION_DEPLOY_PLAN_IDENTITY_INVALID", 400); }
    try {
      await this.assertIdle(scope);
      const release = parseApplicationReleaseRecord(await this.releases.readRelease(projectRef, applicationId, releaseId));
      if (release.project_ref !== projectRef || release.application_id !== applicationId || release.release_id !== releaseId) {
        throw new Error("Candidate identity mismatch");
      }
      const configuration = await this.configurations.resolve(scope, configurationId, release);
      const readActive = () => this.active.readForApplication(projectRef, applicationId, environmentId);
      const current = await readActive();
      const migration = await this.migrations.inspect(projectRef, applicationId, releaseId);
      if (migration.schema !== "supacloud.application-migrations.v1" || migration.project_ref !== projectRef
        || migration.application_id !== applicationId || migration.release_id !== releaseId
        || migration.manifest_sha256 !== release.manifest_sha256 || migration.execution_performed !== false
        || !/^[a-f0-9]{64}$/.test(migration.ledger_digest)) throw new Error("Migration identity mismatch");
      let journal: Awaited<ReturnType<ApplicationActivationMutations["read"]>> = null;
      if (current) {
        parseApplicationActiveRecord(current, { release, environmentId });
        journal = await this.mutations.read(projectRef, current.runtime.activationId);
        const { desired } = parseSuccessfulApplicationActivation(journal, scope);
        if (stableStringify(desired) !== stableStringify(current) || !current.configurationId) {
          throw new Error("Authority mismatch");
        }
        const activeRelease = current.runtime.release.release_id === releaseId ? release
          : await this.releases.readRelease(projectRef, applicationId, current.runtime.release.release_id);
        if (stableStringify(activeRelease) !== stableStringify(current.runtime.release)) throw new Error("Artifact drift");
        const activeConfiguration = current.configurationId === configurationId ? configuration
          : await this.configurations.resolve(scope, current.configurationId, activeRelease);
        if (stableSha256(activeConfiguration.environment) !== current.configurationDigest
          || activeConfiguration.bunVersion !== current.runtime.bunVersion
          || stableStringify(activeConfiguration.hosts) !== stableStringify(current.hosts)) {
          throw new Error("Configuration drift");
        }
        await this.verifyRoute(current);
        const report = parseApplicationReadinessReport(await this.readiness.inspect(current.runtime));
        const runtime = applicationRuntimePlan(current.runtime);
        const inventory = (targets: Array<{ target: string; kind: string; unit: string }>) =>
          targets.map(target => ({ target: target.target, kind: target.kind, unit: target.unit }))
            .sort((a, b) => a.target.localeCompare(b.target));
        if (!report.ready || report.project_ref !== projectRef || report.application_id !== applicationId
          || report.environment_id !== environmentId || report.release_id !== activeRelease.release_id
          || report.activation_id !== current.runtime.activationId
          || stableStringify(inventory(report.targets)) !== stableStringify(inventory(runtime.targets.map(target => ({
            target: target.name, kind: target.kind, unit: target.unit,
          }))))) throw new Error("Readiness unverified");
      }
      const changes = {
        release: current?.runtime.release.release_id !== releaseId,
        configuration: current?.configurationId !== configurationId,
        targets: targetChanges(release, current?.runtime.release ?? null),
      };
      const noOp = current !== null && !changes.release && !changes.configuration
        && Object.values(changes.targets).every(names => names.length === 0)
        && migration.ledger_compatible && migration.project_migrations_applied
        && migration.operator_provisioning === "not-declared";
      const plan: ApplicationDeployPlan = {
        schema: "supacloud.application-deploy-plan.v1",
        project_ref: projectRef, application_id: applicationId, environment_id: environmentId,
        candidate: { release_id: releaseId, configuration_id: configurationId },
        current: current ? {
          release_id: current.runtime.release.release_id, configuration_id: current.configurationId!,
          activation_id: current.runtime.activationId,
        } : null,
        expected_activation_id: current?.runtime.activationId ?? null,
        action: noOp ? "no-op" : "activate", changes,
        migrations: {
          ledger_digest: migration.ledger_digest, ledger_compatible: migration.ledger_compatible,
          project_migrations_applied: migration.project_migrations_applied,
          operator_provisioning: migration.operator_provisioning,
        },
        compatibility: "not-proven", execution_performed: false,
      };
      if (stableStringify(await this.migrations.inspect(projectRef, applicationId, releaseId)) !== stableStringify(migration)) {
        throw new ApplicationDeployPlanError("APPLICATION_DEPLOY_PLAN_CHANGED", 409);
      }
      if (current && stableStringify(await this.mutations.read(projectRef, current.runtime.activationId))
        !== stableStringify(journal)) throw new ApplicationDeployPlanError("APPLICATION_DEPLOY_PLAN_CHANGED", 409);
      await this.assertIdle(scope);
      if (stableStringify(await readActive()) !== stableStringify(current)) {
        throw new ApplicationDeployPlanError("APPLICATION_DEPLOY_PLAN_CHANGED", 409);
      }
      await this.assertIdle(scope);
      return parseApplicationDeployPlan(plan);
    } catch (error) {
      if (error instanceof ApplicationDeployPlanError) throw error;
      throw new ApplicationDeployPlanError("APPLICATION_DEPLOY_PLAN_UNVERIFIED", 503);
    }
  }
}
