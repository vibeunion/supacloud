import type { VerifiedDeliveryExecutableArchive } from "@supacloud/delivery";
import {
  APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES,
  assertDevelopmentTarget,
  DevelopmentContractError,
  parseDevelopmentContext,
  type DevelopmentContext,
} from "@supacloud/delivery/development";
import { AppError } from "../utils/errors";

/** Read-only, strictly validated projection of a hash-verified delivery artifact. */
export const APPLICATION_DEVELOPMENT_ARTIFACT = "bundle/application-development.json";
export const APPLICATION_DEVELOPMENT_SCHEMA = "supacloud.application-development.v1";
export const APPLICATION_DEVELOPMENT_MAX_BYTES = APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES;

export type ApplicationDevelopmentErrorCode =
  | "APPLICATION_DEVELOPMENT_TARGET_NOT_FOUND"
  | "APPLICATION_DEVELOPMENT_MISSING"
  | "APPLICATION_DEVELOPMENT_TOO_LARGE"
  | "APPLICATION_DEVELOPMENT_INVALID";

export class ApplicationDevelopmentError extends AppError {
  constructor(readonly developmentCode: ApplicationDevelopmentErrorCode) {
    super(developmentCode, developmentCode === "APPLICATION_DEVELOPMENT_TARGET_NOT_FOUND"
      || developmentCode === "APPLICATION_DEVELOPMENT_MISSING" ? 404 : 422, developmentCode);
    this.name = "ApplicationDevelopmentError";
  }
}

export interface DeliveredApplicationDevelopment {
  correlation: "verified-build-snapshot";
  delivery: { target: string; objectId: string; artifactVerified: true };
  context: DevelopmentContext;
}

/** Hash verification alone is not schema validation or proof of deployment. */
export function extractApplicationDevelopment(
  archive: VerifiedDeliveryExecutableArchive,
  target: string,
): DeliveredApplicationDevelopment {
  const entry = archive.objects.find((candidate) => candidate.object.name === target);
  if (!entry) throw new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_TARGET_NOT_FOUND");
  const bytes = entry.files.get(APPLICATION_DEVELOPMENT_ARTIFACT);
  if (!bytes) throw new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_MISSING");
  if (bytes.byteLength > APPLICATION_DEVELOPMENT_MAX_BYTES) {
    throw new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_TOO_LARGE");
  }
  try {
    const context = parseDevelopmentContext(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const planned = archive.manifest.plan.targets.find(candidate => candidate.name === target);
    if (!planned) throw new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_INVALID");
    assertDevelopmentTarget(context, planned);
    return {
      correlation: "verified-build-snapshot",
      delivery: { target, objectId: entry.object.objectId, artifactVerified: true },
      context,
    };
  } catch (error) {
    if (error instanceof ApplicationDevelopmentError) throw error;
    throw new ApplicationDevelopmentError(error instanceof DevelopmentContractError
      ? error.code : "APPLICATION_DEVELOPMENT_INVALID");
  }
}
