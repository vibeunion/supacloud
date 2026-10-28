import {
  DELIVERY_ARTIFACT_MAX_FILE_BYTES, DELIVERY_ARTIFACT_MAX_TOTAL_BYTES,
  readDeliveryManifest, readVerifiedDeliveryFiles,
} from "./delivery-artifact";
export { DELIVERY_ARTIFACT_MAX_FILE_BYTES, DELIVERY_ARTIFACT_MAX_TOTAL_BYTES } from "./delivery-artifact";
import type { DeliveryBuildManifest, DeliveryObject } from "./delivery-build-schema";
export {
  WorkerExecutionGroupSchema, WorkerExecutionSchema, parseWorkerExecutionGroup,
  validateWorkerExecution, workerResourceUsage, assertWorkerBudget, resolveWorkerRoute,
} from "./worker-execution";
export { ComputeResourcesSchema } from "./worker-execution";
export type { WorkerExecutionGroup, WorkerExecution, WorkerResourceUsage, ComputeResources } from "./worker-execution";
export {
  ApplicationActivationIdSchema, ApplicationActivationWriteSchema, ApplicationActivationResultSchema,
  ApplicationActivationRetirementResultSchema, ApplicationRollbackSnapshotSchema,
} from "./application-activation";
export type {
  ApplicationActivationWrite, ApplicationActivationResult, ApplicationActivationRetirementResult,
  ApplicationRollbackSnapshot,
} from "./application-activation";
export { ApplicationDeployPlanSchema, parseApplicationDeployPlan } from "./application-deploy-plan";
export type { ApplicationDeployPlan } from "./application-deploy-plan";
export {
  ApplicationBackendReceiptSchema, ApplicationDeployRequestSchema, ApplicationDeployResultSchema,
  ApplicationDeployWebReleaseSchema, parseApplicationDeployResult,
} from "./application-deploy-operation";
export type {
  ApplicationBackendReceipt, ApplicationDeployRequest, ApplicationDeployResult, ApplicationDeployWebRelease,
} from "./application-deploy-operation";
export {
  ApplicationActivationHistoryPositionSchema, ApplicationActivationHistoryCursorSchema,
  ApplicationActivationHistorySchema, applicationHistoryCursor, applicationHistoryPositionBefore,
  applicationHistoryTimestampMilliseconds, parseApplicationActivationHistory, parseApplicationHistoryCursor,
} from "./application-history";
export type { ApplicationActivationHistory, ApplicationActivationHistoryPosition } from "./application-history";
export {
  ApplicationIdSchema, ApplicationReleaseIdSchema, ApplicationReleaseRecordSchema,
  applicationReleaseId, parseApplicationReleaseRecord,
} from "./application-release";
export type { ApplicationReleaseRecord, ApplicationReleaseInventory } from "./application-release";
export { ApplicationPreviewReceiptSchema, applicationPreviewBranchRef, parseApplicationPreviewReceipt } from "./application-preview";
export type { ApplicationPreviewReceipt } from "./application-preview";
export {
  ApplicationReleaseTransferPlanSchema, ApplicationReleaseTransferResultSchema,
  parseApplicationReleaseTransferPlan, parseApplicationReleaseTransferResult,
  type ApplicationReleaseTransferPlan, type ApplicationReleaseTransferResult,
} from "./application-release-transfer";
export {
  APPLICATION_RESERVED_ENVIRONMENT_NAMES, ApplicationConfigurationIdSchema, ApplicationConfigurationSchema,
  ApplicationConfigurationWriteSchema, ApplicationConfigurationViewSchema, assertApplicationConfigurationScope,
  parseApplicationConfigurationWrite, parseApplicationConfigurationView,
} from "./application-configuration";
export type {
  ApplicationConfiguration, ApplicationConfigurationWrite, ApplicationConfigurationView, ApplicationConfigurationScope,
} from "./application-configuration";
export {
  DEPLOYMENT_EVIDENCE_SCHEMA, DatabaseProviderSchema, DeploymentComponentEvidenceSchema,
  DeploymentEvidenceSchema, deriveDeploymentEvidenceStatus, formatDeploymentEvidence,
  parseDeploymentEvidence, summarizeDeploymentEvidence,
} from "./deployment-evidence";
export type {
  DatabaseProviderEvidence, DeploymentComponentEvidence, DeploymentEvidence, DeploymentEvidenceStatus, DeploymentEvidenceIssue,
} from "./deployment-evidence";
export {
  DELIVERY_TUPLE_SCHEMA, FaDeliveryTupleSchema, formatFaDeliveryTuple,
  isFaDeliveryTupleActive, parseFaDeliveryTuple,
} from "./delivery-tuple";
export type { FaDeliveryTuple } from "./delivery-tuple";
export {
  CONTRACT_MATRIX_SCHEMA, ConsumerContractMatrixSchema,
  parseConsumerContractMatrix, FA_CONTRACT_COMBINATIONS, FA_CONTRACT_SCENARIOS,
} from "./contract-matrix";
export type { ConsumerContractMatrix } from "./contract-matrix";
export {
  FA_BUSINESS_OPERATIONS, FA_REQUIRED_ACCEPTANCE, FaBusinessObservationSchema,
  FaServiceObjectivesSchema, FaStabilityEvidenceSchema, checkFaStability,
  faEvidenceDigest, faEvidenceProofs, faEvidenceTime, measureFaBusinessObservations,
  parseFaStabilityEvidence,
} from "./fa-stability";
export type {
  FaBusinessObservation, FaProof, FaServiceObjectives, FaStabilityEvidence,
} from "./fa-stability";
export {
  ApplicationPromotionPlanSchema, applicationPromotionPlanDigest,
  applicationPromotionAction, applicationPromotionSteps, parseApplicationPromotionPlan,
} from "./application-promotion";
export type { ApplicationPromotionPlan, ApplicationPromotionPlanContent } from "./application-promotion";
export {
  APPLICATION_RUNTIME_PROBE_PATH, ApplicationRuntimeIdentitySchema, parseApplicationRuntimeIdentity,
  ApplicationReadinessReportSchema, parseApplicationReadinessReport,
} from "./application-runtime-identity";
export type {
  ApplicationRuntimeIdentity, ApplicationReadinessReport, ApplicationReadinessTarget,
} from "./application-runtime-identity";

export { parseDeliveryBuildManifest } from "./delivery-build-schema";
export { readDeliveryMigrationArchive } from "./delivery-migration-archive";
export type { DeliveryMigrationArchive } from "./delivery-migration-archive";
export { buildDeliveryMigrationPlan } from "./delivery-migration-plan";
export type { DeliveryMigrationInventoryEntry } from "./delivery-migration-plan";
export type { DeliveryBuildManifest, DeliveryObject } from "./delivery-build-schema";

export interface VerifiedDeliveryExecutableArchive {
  manifest: DeliveryBuildManifest;
  objects: Array<{
    object: DeliveryObject;
    files: Map<string, Buffer>;
  }>;
}

/** Returns the verified bytes to publish, without loading or executing application code. */
export async function readDeliveryExecutableArchive(manifestPath: string): Promise<VerifiedDeliveryExecutableArchive> {
  const { root, manifest } = await readDeliveryManifest(manifestPath);
  if (manifest.objects.length === 0 || manifest.objects.length > 32
    || manifest.objects.some(object => object.entryKind === "compiled-module-factory")
    || manifest.objects.reduce((total, object) =>
      total + object.files.reduce((bytes, file) => bytes + file.bytes, 0), 0) > DELIVERY_ARTIFACT_MAX_TOTAL_BYTES) {
    throw new Error("Invalid executable delivery inventory.");
  }
  const objects: VerifiedDeliveryExecutableArchive["objects"] = [];
  for (const object of manifest.objects) {
    const target = manifest.plan.targets.find(target => target.name === object.name);
    if (!target) throw new Error("Missing executable delivery target.");
    const files = await readVerifiedDeliveryFiles(root, object, target,
      new Set(object.files.map(file => file.path)));
    objects.push({ object, files });
  }
  return { manifest, objects };
}
export {
  RELEASE_CONTRACT_SCHEMA, assertReleaseReceiptTransition, parseReleaseReceipt, parseReleaseScope,
  releaseScopeSha256,
} from "./release-contract";
export type {
  ReleaseComponent, ReleaseReceipt, ReleaseReceiptPhase, ReleaseScope,
} from "./release-contract";
