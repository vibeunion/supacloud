import { Value } from "typebox/value";
import {
  ApplicationIdSchema, ApplicationReleaseIdSchema, ApplicationConfigurationIdSchema,
  applicationPromotionAction, applicationPromotionSteps, applicationPromotionPlanDigest,
  parseApplicationPromotionPlan, parseApplicationReleaseRecord, parseApplicationReadinessReport,
  parseApplicationConfigurationView, parseDeploymentEvidence,
  parseApplicationReleaseTransferPlan,
  type ApplicationPromotionPlan, type ApplicationPromotionPlanContent, type ApplicationConfigurationView,
} from "@supacloud/delivery";
import {
  applicationActivationMutations, parseSuccessfulApplicationActivation, parseApplicationActiveRecord,
  type ApplicationActiveRecord, type ApplicationActivationMutations,
} from "./application-activation";
import { ApplicationActiveStorage } from "./application-active-storage";
import { ApplicationConfigurations } from "./application-configuration";
import { ApplicationDeploymentEvidenceStorage } from "./application-deployment-evidence";
import { ApplicationMigrations } from "./application-migrations";
import { ApplicationReadiness } from "./application-readiness";
import { ApplicationReleaseStorage } from "./application-release-storage";
import { ApplicationReleaseTransfers } from "./application-release-transfer";
import { applicationRuntimePlan } from "./application-runtime";
import { readActiveProjectMutationForResource } from "./project-mutation.service";
import { stableSha256, stableStringify } from "../utils/stable-json";

const SMOKE_MAX_AGE_MS = 30 * 60 * 1000;
export interface ApplicationPromotionInput {
  projectRef: string;
  applicationId: string;
  environmentId: string;
  sourceProjectRef: string;
  sourceEnvironmentId: string;
  sourceReleaseId: string;
  configurationId?: string;
}
export class ApplicationPromotionError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); }
}
export interface ApplicationPromotionDependencies {
  storage: Pick<ApplicationReleaseStorage, "readMigrations">;
  transfers: Pick<ApplicationReleaseTransfers, "readPlan">;
  active: Pick<ApplicationActiveStorage, "readForApplication">;
  configurations: Pick<ApplicationConfigurations, "read">;
  migrations: Pick<ApplicationMigrations, "inspectArchives">;
  readiness: Pick<ApplicationReadiness, "inspect">;
  evidence: Pick<ApplicationDeploymentEvidenceStorage, "read">;
  mutations: Pick<ApplicationActivationMutations, "read">;
  assertIdle?: (scope: { projectRef: string; applicationId: string; environmentId: string }) => Promise<void>;
  now?: () => number;
}

/** 只观察部署事实；计划不创建制品、备份或运行时，不复制配置值。 */
export class ApplicationPromotions {
  private readonly now: () => number;
  private readonly assertIdle: NonNullable<ApplicationPromotionDependencies["assertIdle"]>;
  constructor(private readonly dependencies: ApplicationPromotionDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.assertIdle = dependencies.assertIdle ?? (async scope => {
      const mutation = await readActiveProjectMutationForResource(scope.projectRef, {
        type: "application_release",
        id: stableSha256({ applicationId: scope.applicationId, environmentId: scope.environmentId }),
      });
      if (mutation) throw new ApplicationPromotionError("APPLICATION_PROMOTION_BUSY", 409);
    });
  }

  async readPlan(request: ApplicationPromotionInput): Promise<ApplicationPromotionPlan> {
    const input = structuredClone(request);
    if (![input.projectRef, input.sourceProjectRef].every(ref => /^[a-z0-9-]{1,20}$/.test(ref))
      || ![input.applicationId, input.environmentId, input.sourceEnvironmentId].every(id => Value.Check(ApplicationIdSchema, id))
      || !Value.Check(ApplicationReleaseIdSchema, input.sourceReleaseId)
      || input.configurationId !== undefined && !Value.Check(ApplicationConfigurationIdSchema, input.configurationId)) {
      throw new ApplicationPromotionError("APPLICATION_PROMOTION_IDENTITY_INVALID", 400);
    }
    try { return await this.observe(input); }
    catch (error) {
      if (error instanceof ApplicationPromotionError) throw error;
      throw new ApplicationPromotionError("APPLICATION_PROMOTION_UNVERIFIED", 503);
    }
  }

  private async assertEnvironmentsIdle(input: ApplicationPromotionInput): Promise<void> {
    await this.assertIdle({
      projectRef: input.sourceProjectRef, applicationId: input.applicationId, environmentId: input.sourceEnvironmentId,
    });
    await this.assertIdle({
      projectRef: input.projectRef, applicationId: input.applicationId, environmentId: input.environmentId,
    });
  }

  private async readActive(projectRef: string, applicationId: string, environmentId: string) {
    const active = await this.dependencies.active.readForApplication(projectRef, applicationId, environmentId);
    return active === null ? null : parseApplicationActiveRecord(structuredClone(active), {
      release: { project_ref: projectRef, application_id: applicationId }, environmentId,
    });
  }

  private async configuration(input: ApplicationPromotionInput): Promise<ApplicationConfigurationView | null> {
    const candidate = await this.dependencies.configurations.read({
      projectRef: input.projectRef, applicationId: input.applicationId, environmentId: input.environmentId,
    }, input.configurationId);
    if (candidate === null) return null;
    const view = parseApplicationConfigurationView(candidate);
    if (view.project_ref !== input.projectRef || view.application_id !== input.applicationId
      || view.environment_id !== input.environmentId
      || input.configurationId !== undefined && view.configuration_id !== input.configurationId) throw new Error();
    return structuredClone(view);
  }

  private async runtimeObservation(record: ApplicationActiveRecord | null) {
    if (!record) return {
      activation_id: null, receipt_confirmed: false, ready: false, smoke_verified: false, evidence_sha256: null,
      migration_ledger_digest: null,
    };
    const runtime = record.runtime, release = runtime.release;
    const receipt = await this.dependencies.mutations.read(release.project_ref, runtime.activationId);
    let receiptConfirmed = false;
    try {
      // Reuse the durable journal parser, including its canonical resource key,
      // checkpoint phase and request fingerprint. A receipt alone is not proof.
      const { desired } = parseSuccessfulApplicationActivation(receipt, {
        projectRef: release.project_ref, applicationId: release.application_id, environmentId: runtime.environmentId,
      });
      receiptConfirmed = stableStringify(desired) === stableStringify(record);
    } catch {
      // Invalid journal evidence blocks this observation without exposing it.
    }
    const report = parseApplicationReadinessReport(await this.dependencies.readiness.inspect(runtime));
    const runtimePlan = applicationRuntimePlan(runtime);
    if (report.project_ref !== release.project_ref || report.application_id !== release.application_id
      || report.environment_id !== runtime.environmentId || report.release_id !== release.release_id
      || report.activation_id !== runtime.activationId || report.targets.length !== runtimePlan.targets.length
      || runtimePlan.targets.some(target => !report.targets.some(observed =>
        observed.target === target.name && observed.kind === target.kind && observed.unit === target.unit))) throw new Error();
    const raw = await this.dependencies.evidence.read(release.project_ref, release.application_id, runtime.environmentId);
    const evidence = raw === null ? null : parseDeploymentEvidence(raw);
    const now = this.now();
    const fresh = (date: string | null) => date !== null
      && Date.parse(date) <= now && now - Date.parse(date) <= SMOKE_MAX_AGE_MS;
    const smoke = evidence !== null && evidence.status !== "failed"
      && evidence.scope.project_ref === release.project_ref
      && evidence.scope.application_id === release.application_id
      && evidence.scope.environment_id === runtime.environmentId
      && evidence.source.manifest_sha256 === release.manifest_sha256
      && evidence.activation.release_id === release.release_id
      && evidence.activation.activation_id === runtime.activationId
      && evidence.activation.configuration_id === record.configurationId
      && evidence.health.status === "confirmed" && evidence.health.authenticated_smoke === "confirmed"
      && evidence.database.migration.status === "confirmed"
      && evidence.database.migration.compatibility === "verified"
      && fresh(evidence.recorded_at) && fresh(evidence.health.checked_at);
    return {
      activation_id: runtime.activationId,
      receipt_confirmed: receiptConfirmed,
      ready: report.ready,
      smoke_verified: smoke,
      evidence_sha256: evidence === null ? null : stableSha256(evidence),
      migration_ledger_digest: evidence?.database.migration.inventory_sha256 ?? null,
    };
  }

  private async observe(input: ApplicationPromotionInput): Promise<ApplicationPromotionPlan> {
    // An unchanged old authority is not evidence of an idle environment: a
    // new activation/deactivation may already be pending in the durable journal.
    await this.assertEnvironmentsIdle(input);
    const transfer = parseApplicationReleaseTransferPlan(await this.dependencies.transfers.readPlan({
      projectRef: input.projectRef, applicationId: input.applicationId,
      sourceProjectRef: input.sourceProjectRef, sourceReleaseId: input.sourceReleaseId,
    }));
    if (transfer.project_ref !== input.projectRef || transfer.application_id !== input.applicationId
      || transfer.source.project_ref !== input.sourceProjectRef || transfer.source.release_id !== input.sourceReleaseId) throw new Error();
    const { record: rawRelease, archives } = await this.dependencies.storage.readMigrations(
      input.sourceProjectRef, input.applicationId, input.sourceReleaseId,
    );
    const release = parseApplicationReleaseRecord(rawRelease);
    if (release.project_ref !== input.sourceProjectRef || release.application_id !== input.applicationId
      || release.release_id !== input.sourceReleaseId || release.manifest_sha256 !== transfer.source.manifest_sha256) throw new Error();
    const source = await this.readActive(input.sourceProjectRef, input.applicationId, input.sourceEnvironmentId);
    const target = await this.readActive(input.projectRef, input.applicationId, input.environmentId);
    const configuration = await this.configuration(input);
    const sourceObservation = await this.runtimeObservation(source);
    const targetObservation = await this.runtimeObservation(target);
    const sourceMigrations = await this.dependencies.migrations.inspectArchives(
      input.sourceProjectRef, input.applicationId, release, archives,
    );
    if (sourceMigrations.project_ref !== input.sourceProjectRef || sourceMigrations.application_id !== input.applicationId
      || sourceMigrations.release_id !== input.sourceReleaseId || sourceMigrations.manifest_sha256 !== release.manifest_sha256) throw new Error();
    const report = await this.dependencies.migrations.inspectArchives(
      input.projectRef, input.applicationId, { ...release, project_ref: input.projectRef,
        release_id: transfer.candidate_release_id }, archives,
    );
    if (report.project_ref !== input.projectRef || report.application_id !== input.applicationId
      || report.release_id !== transfer.candidate_release_id || report.manifest_sha256 !== release.manifest_sha256) throw new Error();
    const blockers: ApplicationPromotionPlan["blockers"] = [];
    if (!source || stableStringify(source.runtime.release) !== stableStringify(release)) blockers.push("SOURCE_NOT_ACTIVE");
    if (!sourceObservation.receipt_confirmed) blockers.push("SOURCE_RECEIPT_UNCONFIRMED");
    if (!sourceObservation.ready) blockers.push("SOURCE_NOT_READY");
    const sourceSmokeVerified = sourceObservation.smoke_verified && sourceMigrations.project_migrations_applied
      && sourceObservation.migration_ledger_digest === sourceMigrations.ledger_digest;
    if (!sourceSmokeVerified) blockers.push("SOURCE_SMOKE_UNVERIFIED");
    if (!configuration) blockers.push("TARGET_CONFIGURATION_MISSING");
    else if (configuration.targets.length !== release.targets.length || release.targets.some(target =>
      !configuration.targets.some(binding => binding.name === target.name && binding.kind === target.kind))) {
      blockers.push("TARGET_CONFIGURATION_MISMATCH");
    }
    if (!report.ledger_compatible) blockers.push("MIGRATION_CONFLICT");
    const pendingMigrations = report.targets.some(target =>
      target.migrations.some(entry => entry.status === "pending"));
    if (pendingMigrations) blockers.push("MIGRATION_PENDING", "BACKUP_REQUIRED");
    if (report.operator_provisioning !== "not-declared") blockers.push("OPERATOR_PROVISIONING_REQUIRED");
    const targetMatchesConfiguration = configuration !== null && target !== null
      && configuration.configuration_id === target.configurationId
      && configuration.bun_version === target.runtime.bunVersion
      && stableStringify(release.targets) === stableStringify(target.runtime.release.targets)
      && stableStringify(target.hosts) === stableStringify(Object.fromEntries(configuration.targets
        .filter(binding => binding.kind === "http").map(binding => [binding.name, binding.hosts])));
    const content: ApplicationPromotionPlanContent = {
      schema: "supacloud.application-promotion-plan.v1",
      project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId,
      manifest_sha256: release.manifest_sha256,
      source: {
        project_ref: input.sourceProjectRef, environment_id: input.sourceEnvironmentId,
        release_id: input.sourceReleaseId, ...sourceObservation, smoke_verified: sourceSmokeVerified,
      },
      target: {
        candidate_release_id: transfer.candidate_release_id, current_release_id: target?.runtime.release.release_id ?? null,
        artifact_action: transfer.action === "no-op" ? "reuse" : "materialize",
        configuration_id: input.configurationId ?? configuration?.configuration_id ?? null,
        configuration, ...targetObservation,
        smoke_verified: targetObservation.smoke_verified && targetMatchesConfiguration
          && targetObservation.migration_ledger_digest === report.ledger_digest,
        receipt_confirmed: targetObservation.receipt_confirmed && targetMatchesConfiguration,
      },
      migrations: {
        ledger_digest: report.ledger_digest, ledger_compatible: report.ledger_compatible,
        project_migrations_applied: report.project_migrations_applied,
        pending_versions: [...new Set(report.targets.flatMap(target => target.migrations
          .filter(entry => entry.status === "pending").map(entry => entry.version)))]
          .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0),
        operator_provisioning_required: report.operator_provisioning !== "not-declared",
      },
      backup: { required: !report.project_migrations_applied, confirmed: false },
      action: "blocked", blockers, steps: [], execution_performed: false, data_recovery: "separate-required",
    };
    content.action = applicationPromotionAction(content);
    content.steps = applicationPromotionSteps(content);
    await this.assertEnvironmentsIdle(input);
    const sourceReadback = await this.dependencies.migrations.inspectArchives(
      input.sourceProjectRef, input.applicationId, release, archives,
    );
    const targetReadback = await this.dependencies.migrations.inspectArchives(
      input.projectRef, input.applicationId, { ...release, project_ref: input.projectRef,
        release_id: transfer.candidate_release_id }, archives,
    );
    if (stableStringify(sourceMigrations) !== stableStringify(sourceReadback)
      || stableStringify(report) !== stableStringify(targetReadback)) {
      throw new ApplicationPromotionError("APPLICATION_PROMOTION_OBSERVATION_CHANGED", 409);
    }
    if (stableStringify(source) !== stableStringify(await this.readActive(
      input.sourceProjectRef, input.applicationId, input.sourceEnvironmentId,
    )) || stableStringify(target) !== stableStringify(await this.readActive(
      input.projectRef, input.applicationId, input.environmentId,
    )) || stableStringify(configuration) !== stableStringify(await this.configuration(input))
      || stableStringify(sourceObservation) !== stableStringify(await this.runtimeObservation(source))
      || stableStringify(targetObservation) !== stableStringify(await this.runtimeObservation(target))) {
      throw new ApplicationPromotionError("APPLICATION_PROMOTION_OBSERVATION_CHANGED", 409);
    }
    await this.assertEnvironmentsIdle(input);
    return parseApplicationPromotionPlan({ ...content, plan_sha256: applicationPromotionPlanDigest(content) });
  }
}

export function createDefaultApplicationPromotions() {
  const storage = new ApplicationReleaseStorage();
  return new ApplicationPromotions({
    storage, transfers: new ApplicationReleaseTransfers(storage), active: new ApplicationActiveStorage(),
    configurations: new ApplicationConfigurations(), migrations: new ApplicationMigrations({ storage }),
    readiness: new ApplicationReadiness(), evidence: new ApplicationDeploymentEvidenceStorage(),
    mutations: applicationActivationMutations,
  });
}
