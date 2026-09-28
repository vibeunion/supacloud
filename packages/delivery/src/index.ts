import { readDeliveryManifest, readVerifiedDeliveryFiles } from "./delivery-artifact";
import type { DeliveryBuildManifest, DeliveryObject } from "./delivery-build-schema";
export {
  ApplicationActivationIdSchema, ApplicationActivationWriteSchema, ApplicationActivationResultSchema,
  ApplicationActivationRetirementResultSchema,
} from "./application-activation";
export type {
  ApplicationActivationWrite, ApplicationActivationResult, ApplicationActivationRetirementResult,
} from "./application-activation";
export {
  ApplicationIdSchema, ApplicationReleaseIdSchema, ApplicationReleaseRecordSchema,
  applicationReleaseId, parseApplicationReleaseRecord,
} from "./application-release";
export type { ApplicationReleaseRecord, ApplicationReleaseInventory } from "./application-release";
export {
  APPLICATION_RESERVED_ENVIRONMENT_NAMES, ApplicationConfigurationIdSchema, ApplicationConfigurationSchema,
  ApplicationConfigurationWriteSchema, ApplicationConfigurationViewSchema, assertApplicationConfigurationScope,
  parseApplicationConfigurationWrite, parseApplicationConfigurationView,
} from "./application-configuration";
export type {
  ApplicationConfiguration, ApplicationConfigurationWrite, ApplicationConfigurationView, ApplicationConfigurationScope,
} from "./application-configuration";
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
      total + object.files.reduce((bytes, file) => bytes + file.bytes, 0), 0) > 128 * 1024 * 1024) {
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
