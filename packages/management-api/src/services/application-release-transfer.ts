import {
  ApplicationIdSchema, ApplicationReleaseIdSchema, applicationReleaseId, parseApplicationReleaseRecord,
  parseApplicationReleaseTransferPlan, parseApplicationReleaseTransferResult,
  type ApplicationReleaseRecord, type ApplicationReleaseTransferPlan, type ApplicationReleaseTransferResult,
} from "@supacloud/delivery";
import { Value } from "typebox/value";
import { ApplicationReleaseError, ApplicationReleaseStorage } from "./application-release-storage";
import { stableStringify } from "../utils/stable-json";

export interface ApplicationReleaseTransferInput {
  projectRef: string;
  applicationId: string;
  sourceProjectRef: string;
  sourceReleaseId: string;
}

export class ApplicationReleaseTransferError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); }
}

function validateInput(input: ApplicationReleaseTransferInput): void {
  if (![input.projectRef, input.sourceProjectRef].every(ref => /^[A-Za-z0-9_-]{1,20}$/.test(ref))
    || !Value.Check(ApplicationIdSchema, input.applicationId) || !Value.Check(ApplicationReleaseIdSchema, input.sourceReleaseId)) {
    throw new ApplicationReleaseTransferError("APPLICATION_RELEASE_TRANSFER_IDENTITY_INVALID", 400);
  }
}

/** 仅转移不可变制品，不复制配置或业务数据，不激活应用。 */
export class ApplicationReleaseTransfers {
  constructor(private readonly storage: Pick<ApplicationReleaseStorage, "readRelease" | "materializeRelease"> = new ApplicationReleaseStorage()) {}

  private async source(input: ApplicationReleaseTransferInput): Promise<ApplicationReleaseRecord> {
    const source = parseApplicationReleaseRecord(await this.storage.readRelease(
      input.sourceProjectRef, input.applicationId, input.sourceReleaseId,
    ));
    if (source.project_ref !== input.sourceProjectRef || source.application_id !== input.applicationId
      || source.release_id !== input.sourceReleaseId) throw new Error("Unbound source");
    return source;
  }

  private identity(input: ApplicationReleaseTransferInput, source: ApplicationReleaseRecord) {
    return {
      project_ref: input.projectRef, application_id: input.applicationId,
      source: { project_ref: source.project_ref, release_id: source.release_id, manifest_sha256: source.manifest_sha256 },
      candidate_release_id: applicationReleaseId(input.projectRef, input.applicationId, source.manifest_sha256),
    };
  }

  async readPlan(request: ApplicationReleaseTransferInput): Promise<ApplicationReleaseTransferPlan> {
    const input = structuredClone(request);
    validateInput(input);
    try {
      const source = await this.source(input);
      const identity = this.identity(input, source);
      let action: ApplicationReleaseTransferPlan["action"] = "materialize";
      try {
        const existing = parseApplicationReleaseRecord(await this.storage.readRelease(
          input.projectRef, input.applicationId, identity.candidate_release_id,
        ));
        if (existing.project_ref !== input.projectRef || existing.application_id !== input.applicationId
          || existing.release_id !== identity.candidate_release_id || existing.manifest_sha256 !== source.manifest_sha256
          || stableStringify(existing.targets) !== stableStringify(source.targets)) throw new Error("Unbound target");
        action = "no-op";
      } catch (error) {
        if (!(error instanceof ApplicationReleaseError) || error.code !== "APPLICATION_RELEASE_NOT_FOUND") throw error;
      }
      return parseApplicationReleaseTransferPlan({
        schema: "supacloud.application-release-transfer-plan.v1", ...identity, action, execution_performed: false,
      });
    } catch (error) { throw this.failure(error); }
  }

  async transfer(request: ApplicationReleaseTransferInput & { expectedManifestSha256: string }): Promise<ApplicationReleaseTransferResult> {
    const input = structuredClone(request);
    validateInput(input);
    if (!Value.Check(ApplicationReleaseIdSchema, input.expectedManifestSha256)) {
      throw new ApplicationReleaseTransferError("APPLICATION_RELEASE_TRANSFER_IDENTITY_INVALID", 400);
    }
    try {
      const source = await this.source(input);
      if (source.manifest_sha256 !== input.expectedManifestSha256) {
        throw new ApplicationReleaseTransferError("APPLICATION_RELEASE_TRANSFER_DIGEST_MISMATCH", 409);
      }
      const release = await this.storage.materializeRelease(
        input.sourceProjectRef, input.applicationId, input.sourceReleaseId, input.projectRef, input.expectedManifestSha256,
      );
      if (stableStringify(release.targets) !== stableStringify(source.targets)) throw new Error("Unbound target objects");
      return parseApplicationReleaseTransferResult({
        schema: "supacloud.application-release-transfer-result.v1",
        ...this.identity(input, source), release, activation_performed: false,
      });
    } catch (error) { throw this.failure(error); }
  }

  private failure(error: unknown): ApplicationReleaseTransferError {
    if (error instanceof ApplicationReleaseTransferError) return error;
    if (error instanceof ApplicationReleaseError) return new ApplicationReleaseTransferError(error.code, error.statusCode);
    return new ApplicationReleaseTransferError("APPLICATION_RELEASE_TRANSFER_UNVERIFIED", 503);
  }
}
