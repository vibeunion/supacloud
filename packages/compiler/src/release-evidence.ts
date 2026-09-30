import { readDeliveryManifest, readVerifiedDeliveryFiles } from "./delivery-artifact";
import { canonical, digest as sha256 } from "./delivery-files";
import type { DeliveryObject } from "./delivery-build-schema";
import { readDeliveryMigrationArchive } from "./delivery-migration-archive";
import { readApplicationDevelopmentContext } from "./delivery-context";

/** Build evidence only; this does not attest deployment, health or rollback safety. */
export const RELEASE_EVIDENCE_SCHEMA = "supacloud.release-evidence.v1";

export type ReleaseEvidenceErrorCode = "RELEASE_EVIDENCE_INVALID" | "RELEASE_EVIDENCE_TARGET_NOT_FOUND";

export class ReleaseEvidenceError extends Error {
  constructor(readonly code: ReleaseEvidenceErrorCode) {
    super(code);
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
    entryKind: DeliveryObject["entryKind"];
    entrypoint: "bundle/index.js";
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
  rollback: {
    application: string;
    database: string;
    storage: string;
  };
  notes: string[];
}

const rollback = Object.freeze({
  application: "Activate the previous immutable release; the current object stays addressable.",
  database: "Apply the reviewed migration repair path; destructive changes still require explicit operator handling.",
  storage: "Restore the referenced object version; release evidence does not attest stored bytes.",
});

/**
 * Read one bounded manifest, verify its selected object, and correlate every
 * secondary reader to that exact object. Missing optional metadata is different
 * from invalid metadata: any integrity, schema, UTF-8 or target failure is fatal.
 */
export async function createReleaseEvidence(manifestPath: string, target: string): Promise<ReleaseEvidence> {
  try {
    const { root, manifest } = await readDeliveryManifest(manifestPath);
    const object = manifest.objects.find(candidate => candidate.name === target);
    if (!object) throw new ReleaseEvidenceError("RELEASE_EVIDENCE_TARGET_NOT_FOUND");
    const planned = manifest.plan.targets.find(candidate => candidate.name === target);
    if (!planned) throw new ReleaseEvidenceError("RELEASE_EVIDENCE_INVALID");
    // Verify the entire inventory without retaining executable or SQL payloads.
    await readVerifiedDeliveryFiles(root, object, planned, new Set<string>());

    let contract: ReleaseEvidence["contract"] = {
      status: "absent", schema: null, resources: 0, diagnostics: { errors: 0, warnings: 0 },
    };
    if (object.files.some(file => file.path === "bundle/application-development.json")) {
      const delivered = await readApplicationDevelopmentContext(manifestPath, target);
      if (delivered.delivery.target !== target || delivered.delivery.objectId !== object.objectId) {
        throw new ReleaseEvidenceError("RELEASE_EVIDENCE_INVALID");
      }
      contract = {
        status: "present", schema: delivered.context.schema,
        resources: delivered.context.resources.length,
        diagnostics: {
          errors: delivered.context.diagnostics.filter(diagnostic => diagnostic.severity === "error").length,
          warnings: delivered.context.diagnostics.filter(diagnostic => diagnostic.severity === "warn").length,
        },
      };
    }

    const archive = await readDeliveryMigrationArchive(manifestPath, target);
    if (archive.target !== target || archive.objectId !== object.objectId) {
      throw new ReleaseEvidenceError("RELEASE_EVIDENCE_INVALID");
    }
    const migrations: ReleaseEvidence["migrations"] = {
      status: archive.migrations.length > 0 ? "present" : "absent",
      count: archive.migrations.length,
      latestVersion: archive.migrations.at(-1)?.version ?? null,
      executionPerformed: false, compatibility: "not-proven", dataRecovery: "separate-required",
    };
    return {
      schema: RELEASE_EVIDENCE_SCHEMA,
      correlation: "verified-build-snapshot", deploymentVerified: false, target,
      build: {
        producer: manifest.producer, deploymentReady: false,
        manifestSha256: sha256(canonical(manifest)), objectId: object.objectId,
        entryKind: object.entryKind, entrypoint: object.entrypoint,
        files: object.files.length, bytes: object.files.reduce((total, file) => total + file.bytes, 0),
      },
      contract, migrations, rollback,
      notes: [
        "Local artifact integrity only: this is not signed provenance, deployment success, runtime health or an account identity.",
        "Source-control commit, environment binding version and activation identity are not embedded in this document.",
      ],
    };
  } catch (error) {
    if (error instanceof ReleaseEvidenceError) throw error;
    // Do not expose filesystem paths, rejected metadata or exception payloads.
    throw new ReleaseEvidenceError("RELEASE_EVIDENCE_INVALID");
  }
}

export function formatReleaseEvidence(evidence: ReleaseEvidence): string {
  return [
    `RELEASE ${evidence.target} (${evidence.build.objectId.slice(0, 12)})`,
    `  producer:   ${evidence.build.producer}`,
    `  manifest:   ${evidence.build.manifestSha256.slice(0, 12)} (${evidence.build.files} file(s), ${evidence.build.bytes} byte(s))`,
    `  entry:      ${evidence.build.entryKind} -> ${evidence.build.entrypoint}`,
    `  contract:   ${evidence.contract.status}${evidence.contract.schema ? ` (${evidence.contract.schema})` : ""}` +
      (evidence.contract.status === "present"
        ? ` resources=${evidence.contract.resources} errors=${evidence.contract.diagnostics.errors} warnings=${evidence.contract.diagnostics.warnings}`
        : ""),
    `  migrations: ${evidence.migrations.status}${evidence.migrations.status === "present"
      ? ` count=${evidence.migrations.count} latest=${evidence.migrations.latestVersion}` : ""}`,
    `  rollback:   app: ${evidence.rollback.application}`,
    `              db:  ${evidence.rollback.database}`,
    `              storage: ${evidence.rollback.storage}`,
    "",
    ...evidence.notes.map(note => `  note: ${note}`),
  ].join("\n");
}
