import { resolve } from "node:path";
import { createReleaseEvidence, formatReleaseEvidence, ReleaseEvidenceError } from "./release-evidence";

/** This artifact-only entry never loads source, project configuration or credentials. */
export async function runReleaseEvidenceCommand(args: readonly string[]): Promise<void> {
  try {
    const values = new Map<string, string>();
    let json = false;
    for (let index = 0; index < args.length; index++) {
      const option = args[index];
      if (option === "--json" && !json) { json = true; continue; }
      if (option !== "--delivery-manifest" && option !== "--delivery-target") throw new ReleaseEvidenceError("RELEASE_EVIDENCE_INVALID");
      const value = args[++index];
      if (!value || value.startsWith("-") || values.has(option) || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new ReleaseEvidenceError("RELEASE_EVIDENCE_INVALID");
      }
      values.set(option, value);
    }
    const manifest = values.get("--delivery-manifest");
    const target = values.get("--delivery-target");
    if (!manifest || !target || manifest.length > 4096 || !/^[a-z][a-z0-9-]{0,62}$/.test(target)) {
      throw new ReleaseEvidenceError("RELEASE_EVIDENCE_INVALID");
    }
    const evidence = await createReleaseEvidence(resolve(manifest), target);
    console.log(json ? JSON.stringify(evidence, null, 2) : formatReleaseEvidence(evidence));
  } catch (error) {
    console.error(`Error: ${error instanceof ReleaseEvidenceError ? error.code : "RELEASE_EVIDENCE_INVALID"}`);
    process.exitCode = 1;
  }
}
