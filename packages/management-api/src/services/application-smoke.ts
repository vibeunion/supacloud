import { parseDeploymentEvidence, type DeploymentEvidence } from "@supacloud/delivery";
import type { ApplicationActiveRecord } from "./application-activation";
import type { ApplicationConfigurations } from "./application-configuration";
import { executeApplicationCompatibility, resolveApplicationVerifierExecutable } from "./application-compatibility";
import { stableSha256, stableStringify } from "../utils/stable-json";

interface SmokeInput {
  active: ApplicationActiveRecord;
  environment: Awaited<ReturnType<ApplicationConfigurations["resolve"]>>["environment"];
}

export interface ApplicationSmokeOperations {
  executable(input: SmokeInput): Promise<string>;
  execute(path: string, request: string): Promise<string>;
}

/** 仅执行运维安装的可信 smoke；配置走 stdin，输出必须绑定本次 nonce 和精确 authority。 */
export function createApplicationSmokeVerifier(
  configurations: Pick<ApplicationConfigurations, "resolve">,
  operations: ApplicationSmokeOperations = {
    executable: input => resolveApplicationVerifierExecutable({
      projectRef: input.active.runtime.release.project_ref,
      applicationId: input.active.runtime.release.application_id,
      environmentId: input.active.runtime.environmentId,
    }, "smoke"),
    execute: executeApplicationCompatibility,
  },
): (active: ApplicationActiveRecord) => Promise<DeploymentEvidence> {
  return async candidate => {
    try {
      const active = structuredClone(candidate);
      if (!active.configurationId) throw new Error();
      const runtime = active.runtime;
      const resolved = await configurations.resolve({
        projectRef: runtime.release.project_ref, applicationId: runtime.release.application_id,
        environmentId: runtime.environmentId,
      }, active.configurationId, runtime.release);
      if (stableSha256(resolved.environment) !== active.configurationDigest
        || stableStringify(resolved.hosts) !== stableStringify(active.hosts)
        || resolved.bunVersion !== runtime.bunVersion) throw new Error();
      const input: SmokeInput = { active, environment: resolved.environment };
      const request = {
        schema: "supacloud.application-smoke-request.v1",
        nonce: crypto.randomUUID(), input_sha256: stableSha256(input), input,
      };
      const output: unknown = JSON.parse(await operations.execute(
        await operations.executable(input), JSON.stringify(request),
      ));
      if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error();
      const receipt = output as Record<string, unknown>;
      if (receipt["schema"] !== "supacloud.application-smoke-result.v1"
        || receipt["nonce"] !== request.nonce || receipt["input_sha256"] !== request.input_sha256
        || receipt["authenticated"] !== true) throw new Error();
      return parseDeploymentEvidence(receipt["evidence"]);
    } catch {
      throw new Error("APPLICATION_PROMOTION_SMOKE_UNVERIFIED");
    }
  };
}
