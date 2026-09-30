import { readFile } from "node:fs/promises";
import { readDeliverySelection, readVerifiedDeliveryFiles } from "./delivery-artifact";
import { canonical, digest as sha256 } from "./delivery-files";
import { parseDeliveryBuildManifest, type DeliveryObject } from "./delivery-build-schema";
import { readDeliveryMigrationArchive } from "./delivery-migration-archive";
import { readApplicationDevelopmentContext, DeliveryContextError } from "./delivery-context";

/**
 * One queryable summary of what a release actually contains. Every field comes
 * from artifacts that were already hash-verified, so it is build evidence, not
 * a claim that the release is deployed, healthy or rollback-safe. Source control
 * identity, environment binding versions and runtime health are **not** inferred.
 */
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
 * Read release evidence for one immutable delivery target. It verifies every
 * inventoried file hash before reading the development contract and migration
 * inventory, and never falls back to the current source checkout.
 */
export async function createReleaseEvidence(manifestPath: string, target: string): Promise<ReleaseEvidence> {
  let manifest: ReturnType<typeof parseDeliveryBuildManifest>;
  let root: string;
  let object: DeliveryObject;
  let planned: NonNullable<Awaited<ReturnType<typeof readDeliverySelection>>["planned"]>;
  try {
    manifest = parseDeliveryBuildManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    const selection = await readDeliverySelection(manifestPath, target);
    if (!selection.object) throw new ReleaseEvidenceError("RELEASE_EVIDENCE_TARGET_NOT_FOUND");
    if (!selection.planned) throw new ReleaseEvidenceError("RELEASE_EVIDENCE_INVALID");
    root = selection.root;
    object = selection.object;
    planned = selection.planned;
    await readVerifiedDeliveryFiles(root, object, planned, new Set(object.files.map((file) => file.path)));
  } catch (error) {
    if (error instanceof ReleaseEvidenceError) throw error;
    throw new ReleaseEvidenceError("RELEASE_EVIDENCE_INVALID");
  }
  const manifestSha256 = sha256(canonical(manifest));

  let contract: ReleaseEvidence["contract"] = { status: "absent", schema: null, resources: 0, diagnostics: { errors: 0, warnings: 0 } };
  try {
    const delivered = await readApplicationDevelopmentContext(manifestPath, target);
    contract = {
      status: "present",
      schema: delivered.context.schema,
      resources: delivered.context.resources.length,
      diagnostics: {
        errors: delivered.context.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
        warnings: delivered.context.diagnostics.filter((diagnostic) => diagnostic.severity === "warn").length,
      },
    };
  } catch (error) {
    if (!(error instanceof DeliveryContextError && error.code === "DELIVERY_CONTEXT_INTEGRITY_FAILED")) throw error;
  }

  let migrations: ReleaseEvidence["migrations"] = {
    status: "absent", count: 0, latestVersion: null,
    executionPerformed: false, compatibility: "not-proven", dataRecovery: "separate-required",
  };
  try {
    const archive = await readDeliveryMigrationArchive(manifestPath, target);
    migrations = {
      status: archive.migrations.length > 0 ? "present" : "absent",
      count: archive.migrations.length,
      latestVersion: archive.migrations.at(-1)?.version ?? null,
      executionPerformed: false, compatibility: "not-proven", dataRecovery: "separate-required",
    };
  } catch {
    throw new ReleaseEvidenceError("RELEASE_EVIDENCE_INVALID");
  }

  return {
    schema: RELEASE_EVIDENCE_SCHEMA,
    correlation: "verified-build-snapshot",
    deploymentVerified: false,
    target,
    build: {
      producer: manifest.producer,
      deploymentReady: false,
      manifestSha256,
      objectId: object.objectId,
      entryKind: object.entryKind,
      entrypoint: object.entrypoint,
      files: object.files.length,
      bytes: object.files.reduce((total, file) => total + file.bytes, 0),
    },
    contract,
    migrations,
    rollback,
    notes: [
      "Local artifact integrity only: this is not signed provenance, deployment success, runtime health or an account identity.",
      "Source-control commit, environment binding version and activation identity are not embedded in this document.",
    ],
  };
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
      ? ` count=${evidence.migrations.count} latest=${evidence.migrations.latestVersion}`
      : ""}`,
    `  rollback:   app: ${evidence.rollback.application}`,
    `              db:  ${evidence.rollback.database}`,
    "",
    ...evidence.notes.map((note) => `  note: ${note}`),
  ].join("\n");
}