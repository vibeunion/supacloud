import { getVerifiedRequestPrincipal } from "../middleware/auth";
import type { MutationPrincipal } from "./project-mutation.service";
import { FrontendReleaseActivationService } from "./frontend-release-activation";
import {
  assertFrontendIdentity,
  FRONTEND_RELEASE_LIST_DEFAULT_LIMIT,
  FrontendReleaseError,
  frontendReleaseError,
  type ActivateFrontendReleaseInput,
  type FrontendReleaseActivation,
  type FrontendReleaseGateway,
  type FrontendReleaseInventory,
  type FrontendReleaseListPage,
  type FrontendReleaseRecord,
  type FrontendReleaseUploadSession,
  type FrontendRollbackSnapshot,
  type VerifiedStagedFrontendArchive,
} from "./frontend-release-contract";
import { gatewayService } from "./gateway.service";
import {
  frontendReleaseMutationStore,
  type FrontendReleaseMutationStore,
} from "./frontend-release-mutation";
import { FrontendReleaseStorage } from "./frontend-release-storage";
import {
  withFrontendDeploymentLock,
  type FrontendDeploymentLock,
} from "./frontend-deployment-lock";

export {
  FRONTEND_RELEASE_ARCHIVE_MAX_BYTES,
  FRONTEND_RELEASE_LIST_DEFAULT_LIMIT,
  FRONTEND_RELEASE_LIST_MAX_LIMIT,
  FrontendReleaseError,
  type ActivateFrontendReleaseInput,
  type ExpectedActiveReleaseId,
  type FrontendReleaseActivation,
  type FrontendReleaseInventory,
  type FrontendReleaseRecord,
} from "./frontend-release-contract";

interface FrontendReleaseServiceOptions {
  baseDir?: string;
  gateway?: FrontendReleaseGateway;
  mutations?: FrontendReleaseMutationStore;
  deploymentLock?: FrontendDeploymentLock;
  now?: () => Date;
  interruption?: (phase: "after_prepared" | "after_authority" | "after_route") => void;
  beforePublish?: (artifactDir: string, finalDir: string) => Promise<void> | void;
}

export class FrontendReleaseService {
  private readonly storage: FrontendReleaseStorage;
  private readonly activation: FrontendReleaseActivationService;
  private readonly mutations: FrontendReleaseMutationStore;
  private readonly gateway: FrontendReleaseGateway;
  private readonly deploymentLock: FrontendDeploymentLock;

  constructor(options: FrontendReleaseServiceOptions = {}) {
    const gateway = options.gateway ?? gatewayService;
    const mutations = options.mutations ?? frontendReleaseMutationStore();
    this.deploymentLock = options.deploymentLock ?? withFrontendDeploymentLock;
    this.mutations = mutations;
    this.gateway = gateway;
    this.storage = new FrontendReleaseStorage({
      ...(options.baseDir === undefined ? {} : { baseDir: options.baseDir }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.beforePublish === undefined ? {} : { beforePublish: options.beforePublish }),
    });
    this.activation = new FrontendReleaseActivationService({
      storage: this.storage,
      gateway,
      mutations,
      deploymentLock: this.deploymentLock,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.interruption === undefined ? {} : { interruption: options.interruption }),
    });
  }

  async createRelease(
    projectRef: string,
    deploymentId: string,
    archive: VerifiedStagedFrontendArchive,
  ): Promise<FrontendReleaseRecord> {
    return this.deploymentLock(projectRef, deploymentId, async () => {
      await this.storage.assertMutationSupported(projectRef, deploymentId);
      return this.storage.createRelease(projectRef, deploymentId, archive);
    });
  }

  prepareReleaseUpload(
    projectRef: string,
    deploymentId: string,
    expectedLength: number,
  ): Promise<FrontendReleaseUploadSession> {
    return this.storage.prepareReleaseUpload(projectRef, deploymentId, expectedLength);
  }

  assertMutationSupported(projectRef: string, deploymentId: string): Promise<void> {
    return this.storage.assertMutationSupported(projectRef, deploymentId);
  }

  release(
    projectRef: string,
    deploymentId: string,
    releaseId: string,
  ): Promise<FrontendReleaseRecord> {
    return this.storage.releaseRecord(projectRef, deploymentId, releaseId);
  }

  listReleases(
    projectRef: string,
    deploymentId: string,
    page: FrontendReleaseListPage = { limit: FRONTEND_RELEASE_LIST_DEFAULT_LIMIT },
  ): Promise<FrontendReleaseInventory> {
    return this.storage.listReleases(projectRef, deploymentId, page);
  }

  activeReleaseSnapshot(projectRef: string, deploymentId: string): Promise<FrontendReleaseInventory> {
    assertFrontendIdentity(projectRef, deploymentId);
    return this.deploymentLock(projectRef, deploymentId, async () => {
      if (await this.mutations.activeForDeployment(projectRef, deploymentId)) {
        throw frontendReleaseError("FRONTEND_RELEASE_BUSY", 409, "Frontend release activation remains unresolved");
      }
      const snapshot = await this.storage.activeReleaseSnapshot(projectRef, deploymentId);
      if (snapshot.active_release_id !== null) {
        const root = await this.gateway.readFrontendStaticRoot(projectRef, deploymentId);
        const expectedRoot = this.storage.releaseBuildDir(projectRef, deploymentId, snapshot.active_release_id);
        if (root !== expectedRoot) {
          throw frontendReleaseError(
            "FRONTEND_RELEASE_READBACK_MISMATCH", 503, "Frontend active release and Caddy route do not match",
          );
        }
      }
      return snapshot;
    });
  }

  rollbackSnapshot(projectRef: string, deploymentId: string): Promise<FrontendRollbackSnapshot> {
    return this.deploymentLock(projectRef, deploymentId, () =>
      this.activation.rollbackSnapshot(projectRef, deploymentId));
  }

  activeBuildDir(projectRef: string, deploymentId: string): Promise<string | null> {
    return this.storage.activeBuildDir(projectRef, deploymentId);
  }

  hasActiveRelease(projectRef: string, deploymentId: string): Promise<boolean> {
    return this.storage.hasActiveRelease(projectRef, deploymentId);
  }

  async hasUnresolvedActivation(projectRef: string, deploymentId: string): Promise<boolean> {
    const mutation = await this.mutations.activeForDeployment(projectRef, deploymentId);
    return mutation?.operation === "frontend.release.activate";
  }

  async activateRelease(input: ActivateFrontendReleaseInput): Promise<FrontendReleaseActivation> {
    return this.deploymentLock(input.projectRef, input.deploymentId, async () => {
      await this.storage.assertMutationSupported(input.projectRef, input.deploymentId);
      return this.activation.activate(input);
    });
  }
}

export async function frontendReleasePrincipal(request: Request): Promise<MutationPrincipal> {
  const principal = await getVerifiedRequestPrincipal(request);
  if (!principal) {
    throw new FrontendReleaseError(
      "FRONTEND_RELEASE_PRINCIPAL_INVALID",
      401,
      "Frontend release principal could not be verified",
    );
  }
  return principal;
}

export const frontendReleaseService = new FrontendReleaseService();
