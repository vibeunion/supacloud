import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { digest, readBoundedOwned } from "../packages/delivery/src/delivery-files";
import { parseConsumerContractMatrix } from "../packages/delivery/src/contract-matrix";
import { parseFaDeliveryTuple } from "../packages/delivery/src/delivery-tuple";
import {
  checkFaStability, faEvidenceDigest, faEvidenceProofs,
  parseFaStabilityEvidence, type FaProof,
} from "../packages/delivery/src/fa-stability";

async function readJson(path: string): Promise<unknown> {
  const absolute = resolve(path);
  const root = await realpath(dirname(absolute));
  return JSON.parse(Buffer.from(await readBoundedOwned(root, absolute, 32 * 1024 * 1024)).toString("utf8"));
}

export async function verifyFaProofArchive(root: string, proofs: readonly FaProof[], observation: FaProof): Promise<unknown> {
  const anchor = await realpath(root);
  let totalBytes = 0;
  const checked = new Map<string, { sha256: string; bytes: Uint8Array }>();
  for (const proof of [...proofs, observation]) {
    const absolute = resolve(anchor, proof.path);
    const previous = checked.get(absolute);
    if (previous) {
      if (previous.sha256 !== proof.sha256) throw new Error("Evidence digest mismatch.");
      continue;
    }
    const bytes = await readBoundedOwned(anchor, absolute, 32 * 1024 * 1024);
    totalBytes += bytes.length;
    if (totalBytes > 128 * 1024 * 1024 || digest(bytes) !== proof.sha256) throw new Error("Evidence archive invalid.");
    checked.set(absolute, { sha256: proof.sha256, bytes });
  }
  const bytes = checked.get(resolve(anchor, observation.path))!.bytes;
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2), strict: true, allowPositionals: false,
      options: {
        level: { type: "string", default: "daily" },
        tuple: { type: "string" }, matrix: { type: "string" },
        evidence: { type: "string" }, objectives: { type: "string" },
        project: { type: "string" }, environment: { type: "string" },
      },
    });
    if (!values.tuple || !values.matrix
      || !["daily", "release", "platform-change"].includes(values.level)) {
      throw new Error("Explicit level, tuple and matrix are required.");
    }
    const tuple = parseFaDeliveryTuple(await readJson(values.tuple));
    const matrix = parseConsumerContractMatrix(await readJson(values.matrix));
    const tupleSha256 = faEvidenceDigest(tuple);
    if (matrix.candidate_tuple_sha256 !== tupleSha256) throw new Error("Tuple/matrix mismatch.");
    if (values.level === "daily") {
      console.log(JSON.stringify({
        schema: "supacloud.fa-stability-gate-result.v1",
        status: "definitions-valid",
        deployment_verified: false,
        report_export: "excluded",
        tuple_sha256: tupleSha256,
        matrix_sha256: faEvidenceDigest(matrix),
      }, null, 2));
    } else {
      if (!values.evidence || !values.objectives || !values.project
        || (values.environment !== "test" && values.environment !== "production")) {
        throw new Error("Release requires evidence, objectives, project and environment.");
      }
      const evidence = parseFaStabilityEvidence(await readJson(values.evidence));
      const evidenceRoot = await realpath(dirname(resolve(values.evidence)));
      const observations = await verifyFaProofArchive(evidenceRoot, faEvidenceProofs(evidence), evidence.observation);
      const result = checkFaStability({
        tuple, matrix, objectives: await readJson(values.objectives), evidence, observations,
        expectedProjectRef: values.project, expectedEnvironment: values.environment,
      });
      console.log(JSON.stringify({
        schema: "supacloud.fa-stability-gate-result.v1",
        ...result, report_export: "excluded", archive_integrity_verified: true,
      }, null, 2));
      if (!result.ready) process.exitCode = 1;
    }
  } catch {
    console.error("FA_STABILITY_INPUT_OR_ARCHIVE_INVALID");
    process.exitCode = 1;
  }
}
