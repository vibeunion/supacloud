import type { TenantContext } from "@svadmin/core";

export interface ResolveAdminTenantInput {
  projectRefs: readonly string[];
  projectRef: string | null | undefined;
  isRawPage?: boolean;
  isPlatformRoute?: boolean;
}

export function resolveAdminTenant({
  projectRefs,
  projectRef,
  isRawPage = false,
  isPlatformRoute = false,
}: ResolveAdminTenantInput): TenantContext | undefined {
  if (isRawPage || isPlatformRoute || !projectRef || !projectRefs.includes(projectRef)) {
    return undefined;
  }

  return {
    tenantId: projectRef,
    meta: { projectRef },
  };
}
