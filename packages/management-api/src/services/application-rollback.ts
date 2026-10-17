import type { ApplicationRollbackSnapshot } from "@supacloud/delivery";
import {
  applicationActivationMutations, parseApplicationActiveRecord, parseSuccessfulApplicationActivation,
  type ApplicationActivationMutations, type ApplicationActiveRecord,
} from "./application-activation";
import { ApplicationActiveStorage } from "./application-active-storage";
import { ApplicationConfigurations } from "./application-configuration";
import { ApplicationReleaseStorage } from "./application-release-storage";
import { gatewayService } from "./gateway.service";
import { readActiveProjectMutationForResource } from "./project-mutation.service";
import { stableSha256, stableStringify } from "../utils/stable-json";

interface Scope { projectRef: string; applicationId: string; environmentId: string }

export class ApplicationRollbackError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); }
}

interface Dependencies {
  active?: Pick<ApplicationActiveStorage, "readForApplication">;
  mutations?: Pick<ApplicationActivationMutations, "read">;
  releases?: Pick<ApplicationReleaseStorage, "readRelease">;
  configurations?: Pick<ApplicationConfigurations, "resolve">;
  assertIdle?: (scope: Scope) => Promise<void>;
  verifyRoute?: (record: ApplicationActiveRecord) => Promise<void>;
}

/** 只观察 journal 选中的目标；实际激活仍须通过现有兼容性和 CAS 门禁。 */
export class ApplicationRollbackSnapshots {
  private readonly active: Pick<ApplicationActiveStorage, "readForApplication">;
  private readonly mutations: Pick<ApplicationActivationMutations, "read">;
  private readonly releases: Pick<ApplicationReleaseStorage, "readRelease">;
  private readonly configurations: Pick<ApplicationConfigurations, "resolve">;
  private readonly assertIdle: (scope: Scope) => Promise<void>;
  private readonly verifyRoute: (record: ApplicationActiveRecord) => Promise<void>;

  constructor(dependencies: Dependencies = {}) {
    this.active = dependencies.active ?? new ApplicationActiveStorage();
    this.mutations = dependencies.mutations ?? applicationActivationMutations;
    this.releases = dependencies.releases ?? new ApplicationReleaseStorage();
    this.configurations = dependencies.configurations ?? new ApplicationConfigurations();
    this.assertIdle = dependencies.assertIdle ?? (async scope => {
      const mutation = await readActiveProjectMutationForResource(scope.projectRef, {
        type: "application_release",
        id: stableSha256({ applicationId: scope.applicationId, environmentId: scope.environmentId }),
      });
      if (mutation) throw new ApplicationRollbackError("APPLICATION_ROLLBACK_BUSY", 409);
    });
    this.verifyRoute = dependencies.verifyRoute ?? (async record => {
      if (!record.hosts) throw new Error("APPLICATION_ROLLBACK_HOSTS_REQUIRED");
      await gatewayService.verifyApplicationRoute({ runtime: record.runtime, hosts: record.hosts });
    });
  }

  async read(input: Scope): Promise<ApplicationRollbackSnapshot> {
    const scope = structuredClone(input);
    if (!/^[a-z0-9-]{1,20}$/.test(scope.projectRef)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(scope.applicationId)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(scope.environmentId)) {
      throw new ApplicationRollbackError("APPLICATION_ROLLBACK_IDENTITY_INVALID", 400);
    }
    try {
      await this.assertIdle(scope);
      const readActive = () => this.active.readForApplication(scope.projectRef, scope.applicationId, scope.environmentId);
      const current = await readActive();
      const snapshot: ApplicationRollbackSnapshot = {
        schema: "supacloud.application-rollback-snapshot.v1",
        project_ref: scope.projectRef, application_id: scope.applicationId, environment_id: scope.environmentId,
        active: null, previous: null,
      };
      if (current) {
        parseApplicationActiveRecord(current, {
          release: { project_ref: scope.projectRef, application_id: scope.applicationId }, environmentId: scope.environmentId,
        });
        const state = await this.mutations.read(scope.projectRef, current.runtime.activationId);
        const { desired, previous } = parseSuccessfulApplicationActivation(state, scope);
        if (stableStringify(desired) !== stableStringify(current)) throw new Error("APPLICATION_ROLLBACK_AUTHORITY_MISMATCH");
        snapshot.active = await this.verifiedTarget(scope, current);
        await this.verifyRoute(current);
        if (previous) {
          const previousState = await this.mutations.read(scope.projectRef, previous.runtime.activationId);
          const prior = parseSuccessfulApplicationActivation(previousState, scope);
          if (stableStringify(prior.desired) !== stableStringify(previous)) {
            throw new Error("APPLICATION_ROLLBACK_PREVIOUS_MISMATCH");
          }
          snapshot.previous = await this.verifiedTarget(scope, previous);
          if (stableStringify(await this.mutations.read(scope.projectRef, previous.runtime.activationId))
            !== stableStringify(previousState)) throw new Error("APPLICATION_ROLLBACK_JOURNAL_CHANGED");
        }
        if (stableStringify(await this.mutations.read(scope.projectRef, current.runtime.activationId))
          !== stableStringify(state)) throw new Error("APPLICATION_ROLLBACK_JOURNAL_CHANGED");
      }
      await this.assertIdle(scope);
      if (stableStringify(await readActive()) !== stableStringify(current)) {
        throw new ApplicationRollbackError("APPLICATION_ROLLBACK_CHANGED", 409);
      }
      await this.assertIdle(scope);
      return snapshot;
    } catch (error) {
      if (error instanceof ApplicationRollbackError) throw error;
      throw new ApplicationRollbackError("APPLICATION_ROLLBACK_UNVERIFIED", 503);
    }
  }

  private async verifiedTarget(scope: Scope, record: ApplicationActiveRecord) {
    if (!record.configurationId) throw new Error("APPLICATION_ROLLBACK_CONFIGURATION_REQUIRED");
    const release = await this.releases.readRelease(scope.projectRef, scope.applicationId, record.runtime.release.release_id);
    if (stableStringify(release) !== stableStringify(record.runtime.release)) throw new Error("APPLICATION_ROLLBACK_RELEASE_MISMATCH");
    const configuration = await this.configurations.resolve(scope, record.configurationId, release);
    if (stableSha256(configuration.environment) !== record.configurationDigest
      || configuration.bunVersion !== record.runtime.bunVersion
      || stableStringify(configuration.hosts) !== stableStringify(record.hosts)) {
      throw new Error("APPLICATION_ROLLBACK_CONFIGURATION_MISMATCH");
    }
    return {
      release_id: release.release_id, configuration_id: record.configurationId,
      activation_id: record.runtime.activationId,
    };
  }
}
