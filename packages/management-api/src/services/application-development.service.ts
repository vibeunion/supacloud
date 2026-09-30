import type { VerifiedDeliveryExecutableArchive } from "@supacloud/delivery";
import { AppError } from "../utils/errors";

/**
 * Read-only projection of a delivered application's development contract. This
 * mirrors `supacloud.application-development.v1` produced by `@supacloud/compiler`
 * but does not depend on it: the bytes are already hash-verified by the release
 * archive reader, so this only validates the declared contract shape.
 */
export const APPLICATION_DEVELOPMENT_ARTIFACT = "bundle/application-development.json";
export const APPLICATION_DEVELOPMENT_SCHEMA = "supacloud.application-development.v1";
/** The compiler caps the document well below this; the hard bound protects the API. */
export const APPLICATION_DEVELOPMENT_MAX_BYTES = 512 * 1024;

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
  /** Validated `supacloud.application-development.v1` document. */
  context: Record<string, unknown>;
}

const arrays = ["modules", "routes", "commands", "jobs", "resources", "resourceUses", "executionPlans", "diagnostics"] as const;

function parseContext(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.length === 0 || bytes.length > APPLICATION_DEVELOPMENT_MAX_BYTES) {
    throw new ApplicationDevelopmentError(bytes.length > APPLICATION_DEVELOPMENT_MAX_BYTES
      ? "APPLICATION_DEVELOPMENT_TOO_LARGE" : "APPLICATION_DEVELOPMENT_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_INVALID");
  }
  const row = parsed as Record<string, unknown>;
  if (row.schema !== APPLICATION_DEVELOPMENT_SCHEMA || row.source !== "current-graph"
    || row.deploymentVerified !== false
    || arrays.some((key) => !Array.isArray(row[key]))
    || !row.omitted || typeof row.omitted !== "object" || Array.isArray(row.omitted)
    || !row.limits || typeof row.limits !== "object" || Array.isArray(row.limits)) {
    throw new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_INVALID");
  }
  return row;
}

/** Extract and validate the development contract from an already verified archive. */
export function extractApplicationDevelopment(
  archive: VerifiedDeliveryExecutableArchive,
  target: string,
): DeliveredApplicationDevelopment {
  const entry = archive.objects.find((candidate) => candidate.object.name === target);
  if (!entry) throw new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_TARGET_NOT_FOUND");
  const bytes = entry.files.get(APPLICATION_DEVELOPMENT_ARTIFACT);
  if (!bytes) throw new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_MISSING");
  return {
    correlation: "verified-build-snapshot",
    delivery: { target, objectId: entry.object.objectId, artifactVerified: true },
    context: parseContext(bytes),
  };
}