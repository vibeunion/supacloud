import type { ApplicationReleaseRecord, VerifiedDeliveryExecutableArchive } from "@supacloud/delivery";
import { AppError } from "../utils/errors";
import { APPLICATION_DEVELOPMENT_ARTIFACT, extractApplicationDevelopment } from "./application-development.service";

/**
 * Server-side mirror of the compiler's `supacloud.release-evidence.v1`. It is
 * built from the already hash-verified release archive so the API and the
 * compiler CLI describe a release with the same fields and the same limits.
 * Source control identity, environment binding versions, runtime health and
 * activation identity are **not** inferred here.
 */
export const RELEASE_EVIDENCE_SCHEMA = "supacloud.release-evidence.v1";

export type ReleaseEvidenceErrorCode = "RELEASE_EVIDENCE_TARGET_NOT_FOUND";

export class ReleaseEvidenceError extends AppError {
  constructor(readonly evidenceCode: ReleaseEvidenceErrorCode) {
    super(evidenceCode, 404, evidenceCode);
    this.name = "ReleaseEvidenceError";
  }
}

export interface ReleaseEvidence {
  schema: typeof RELEASE_EVIDENCE_SCHEMA;
  correlation: "verified-build-snapshot";
  deploymentVerified: false;
  target: string;
  build: {
    producer: string;
    deploymentReady: false;
    manifestSha256: string;
    objectId: string;
    entryKind: string;
    entrypoint: string;
    files: number;
    bytes: number;
  };
  contract: {
    status: "present" | "absent";
    schema: string | null;
    resources: number;
    diagnostics: { errors: number; warnings: number };
  };
  migrations: {
    status: "present" | "absent";
    count: number;
    latestVersion: string | null;
    executionPerformed: false;
    compatibility: "not-proven";
    dataRecovery: "separate-required";
  };
  rollback: { application: string; database: string; storage: string };
  notes: string[];
}

export interface ReleaseEvidenceInput {
  record: ApplicationReleaseRecord;
  archive: VerifiedDeliveryExecutableArchive;
  migrations: ReadonlyArray<{ target: string; migrations: ReadonlyArray<{ version: string }> }>;
  target: string;
}

const rollback = Object.freeze({
  application: "Activate the previous immutable release; the current object stays addressable.",
  database: "Apply the reviewed migration repair path; destructive changes still require explicit operator handling.",
  storage: "Restore the referenced object version; release evidence does not attest stored bytes.",
});

export function createReleaseEvidence(input: ReleaseEvidenceInput): ReleaseEvidence {
  const entry = input.archive.objects.find((candidate) => candidate.object.name === input.target);
  if (!entry) throw new ReleaseEvidenceError("RELEASE_EVIDENCE_TARGET_NOT_FOUND");

  let contract: ReleaseEvidence["contract"] = { status: "absent", schema: null, resources: 0, diagnostics: { errors: 0, warnings: 0 } };
  if (entry.files.has(APPLICATION_DEVELOPMENT_ARTIFACT)) {
    const delivered = extractApplicationDevelopment(input.archive, input.target);
    const diagnostics = delivered.context.diagnostics as Array<{ severity: string }>;
    contract = {
      status: "present",
      schema: String(delivered.context.schema),
      resources: (delivered.context.resources as unknown[]).length,
      diagnostics: {
        errors: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
        warnings: diagnostics.filter((diagnostic) => diagnostic.severity === "warn").length,
      },
    };
  }

  const versions = input.migrations.find((archive) => archive.target === input.target)?.migrations ?? [];
  return {
    schema: RELEASE_EVIDENCE_SCHEMA,
    correlation: "verified-build-snapshot",
    deploymentVerified: false,
    target: input.target,
    build: {
      producer: input.archive.manifest.producer,
      deploymentReady: false,
      manifestSha256: input.record.manifest_sha256,
      objectId: entry.object.objectId,
      entryKind: entry.object.entryKind,
      entrypoint: entry.object.entrypoint,
      files: entry.object.files.length,
      bytes: entry.object.files.reduce((total, file) => total + file.bytes, 0),
    },
    contract,
    migrations: {
      status: versions.length > 0 ? "present" : "absent",
      count: versions.length,
      latestVersion: versions.at(-1)?.version ?? null,
      executionPerformed: false,
      compatibility: "not-proven",
      dataRecovery: "separate-required",
    },
    rollback,
    notes: [
      "Local artifact integrity only: this is not signed provenance, deployment success, runtime health or an account identity.",
      "Source-control commit, environment binding version and activation identity are not embedded in this document.",
    ],
  };
}