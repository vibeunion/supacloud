import {
  detectGoTrueAuthHookStatus,
  goTrueAuthHookStatusFromRuntime,
} from "./gotrue-auth-hook-runtime.service";
import type { ProjectRoutingConfig } from "../utils/project-routing";

export type OrganizationJitCapabilityEvidence = {
  available: boolean;
  version: string | null;
  reason_code: string | null;
};

type RuntimeEvidenceInput = {
  projectRef: string;
  projectConfig?: ProjectRoutingConfig;
  environment: Record<string, string>;
};

function organizationJitEvidence(status: {
  verified: boolean;
  version: string | null;
  reason_code: string | null;
}): OrganizationJitCapabilityEvidence {
  return {
    available: status.verified,
    version: status.verified ? status.version : null,
    reason_code: status.reason_code,
  };
}

export async function organizationJitCapabilityFromRuntime(
  input: RuntimeEvidenceInput,
  fetcher: typeof fetch = fetch,
): Promise<OrganizationJitCapabilityEvidence> {
  const status = await goTrueAuthHookStatusFromRuntime({
    ...input,
    hookName: "custom-access-token",
  }, fetcher);
  return organizationJitEvidence(status);
}

export async function detectOrganizationJitCapability(
  projectRef: string,
  projectConfig?: ProjectRoutingConfig,
): Promise<OrganizationJitCapabilityEvidence> {
  return organizationJitEvidence(await detectGoTrueAuthHookStatus(
    projectRef,
    "custom-access-token",
    projectConfig,
  ));
}
