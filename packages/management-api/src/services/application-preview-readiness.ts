import type { ApplicationActiveStorage } from "./application-active-storage";
import type { ApplicationReadiness } from "./application-readiness";
import type { ApplicationPreviewProbeInput } from "./application-preview-contract";
import { stableStringify } from "../utils/stable-json";

export function createApplicationPreviewReadiness(dependencies: {
  active: Pick<ApplicationActiveStorage, "readForApplication">;
  readiness: Pick<ApplicationReadiness, "inspect">;
}) {
  return async (input: ApplicationPreviewProbeInput): Promise<{ passed: string[]; failed: string[] }> => {
    const failed = { passed: [], failed: ["application_readiness"] };
    try {
      const read = () => dependencies.active.readForApplication(input.branchRef, input.applicationId, input.environmentId);
      const current = await read();
      if (!current || current.runtime.release.project_ref !== input.branchRef
        || current.runtime.release.application_id !== input.applicationId
        || current.runtime.release.release_id !== input.releaseId
        || current.runtime.environmentId !== input.environmentId
        || current.runtime.activationId !== input.activationId
        || current.configurationId !== input.configurationId) return failed;
      const report = await dependencies.readiness.inspect(current.runtime);
      // 探针和前后两次 authority 必须指向同一次分支激活。
      if (!report.ready || report.targets.length === 0 || report.targets.some(target => !target.ready)
        || report.project_ref !== input.branchRef || report.application_id !== input.applicationId
        || report.environment_id !== input.environmentId || report.release_id !== input.releaseId
        || report.activation_id !== input.activationId
        || stableStringify(current) !== stableStringify(await read())) return failed;
      return { passed: ["application_readiness"], failed: [] };
    } catch {
      return failed;
    }
  };
}
