import {
  deriveDeploymentEvidenceStatus,
  type DeploymentEvidence,
  type DeploymentComponentEvidence,
} from "@supacloud/delivery";
import type { ApplicationActiveRecord } from "./application-activation";
import type { ApplicationActiveStorage } from "./application-active-storage";
import type { ApplicationMigrations } from "./application-migrations";
import type { ApplicationReadiness } from "./application-readiness";
import type { ApplicationReleaseStorage } from "./application-release-storage";

export interface ApplicationDeploymentEvidenceObserverDependencies {
  active: Pick<ApplicationActiveStorage, "readForApplication">;
  readiness: Pick<ApplicationReadiness, "inspect">;
  migrations: Pick<ApplicationMigrations, "inspect">;
  releases: Pick<ApplicationReleaseStorage, "readRelease">;
  now?: () => Date;
}

function component(
  name: DeploymentComponentEvidence["name"],
  status: DeploymentComponentEvidence["status"],
  checkedAt: string,
): DeploymentComponentEvidence {
  return {
    name,
    version: null,
    status,
    health_check: null,
    checked_at: checkedAt,
  };
}

/**
 * Builds a conservative evidence snapshot from platform-owned observations.
 * Missing backup, recovery, authenticated-smoke and rollback observations stay
 * unknown; this observer never upgrades an incomplete deployment to success.
 */
export class ApplicationDeploymentEvidenceObserver {
  private readonly now: () => Date;

  constructor(private readonly dependencies: ApplicationDeploymentEvidenceObserverDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async observe(scope: {
    projectRef: string;
    applicationId: string;
    environmentId: string;
  }): Promise<DeploymentEvidence | null> {
    const active = await this.dependencies.active.readForApplication(
      scope.projectRef, scope.applicationId, scope.environmentId,
    );
    if (!active) return null;
    const runtime = active.runtime;
    const release = await this.dependencies.releases.readRelease(
      scope.projectRef, scope.applicationId, runtime.release.release_id,
    );
    const migrations = await this.dependencies.migrations.inspect(
      scope.projectRef, scope.applicationId, runtime.release.release_id,
    );
    const readiness = await this.dependencies.readiness.inspect(runtime);
    const recordedAt = this.now().toISOString();
    const readinessStatus = readiness.ready ? "confirmed" : "failed";
    const components = runtime.release.targets.map(target =>
      component(target.kind === "http" ? "edge-runtime" : "worker", readinessStatus, recordedAt));
    const deduplicatedComponents = [...new Map(
      components.map(value => [value.name, value]),
    ).values()];
    const base: Omit<DeploymentEvidence, "status"> = {
      schema: "supacloud.deployment-evidence.v1",
      recorded_at: recordedAt,
      scope: {
        project_ref: scope.projectRef,
        application_id: scope.applicationId,
        environment_id: scope.environmentId,
      },
      source: {
        commit_sha: null,
        manifest_sha256: release.manifest_sha256,
        contract_schema: null,
        environment_binding_version: null,
      },
      database: {
        provider: "postgresql",
        version: "unknown",
        topology: "single-node",
        migration: {
          status: migrations.project_migrations_applied ? "confirmed" : "failed",
          inventory_sha256: migrations.ledger_digest,
          compatibility: migrations.ledger_compatible ? "verified" : "failed",
        },
        backup: {
          status: "unknown",
          latest_success_at: null,
          freshness_seconds: null,
        },
        recovery: {
          status: "unknown",
          drill_id: null,
          rpo_seconds: null,
          rto_seconds: null,
        },
      },
      components: deduplicatedComponents,
      activation: {
        release_id: runtime.release.release_id,
        configuration_id: active.configurationId ?? "00000000-0000-4000-8000-000000000000",
        activation_id: runtime.activationId,
      },
      health: {
        status: readinessStatus,
        checked_at: recordedAt,
        authenticated_smoke: "unknown",
      },
      rollback: {
        release_id: null,
        configuration_id: null,
        status: "unknown",
        result: null,
      },
      notes: [
        "Observed from the active runtime, release migration ledger and readiness probes.",
        "Backup, recovery, authenticated smoke and rollback readiness require independent evidence.",
      ],
    };
    return { ...base, status: deriveDeploymentEvidenceStatus(base) };
  }
}
