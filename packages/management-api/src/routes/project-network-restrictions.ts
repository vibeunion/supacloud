import { Elysia, status, t } from "elysia";
import { requireAdminAuth, requireProjectOrAdminAuth } from "../middleware/auth";
import { projectService } from "../services";
import { OPENAPI_NETWORK_RESTRICTIONS_RESPONSE_TEMPLATE } from "../utils/openapi-defaults.gen";

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function firstStringArray(...candidates: unknown[]): string[] {
  for (const candidate of candidates) {
    const values = stringArray(candidate);
    if (values.length > 0) return values;
  }
  return [];
}

export function buildNetworkRestrictionsResponse(value: unknown) {
  const response = structuredClone(
    OPENAPI_NETWORK_RESTRICTIONS_RESPONSE_TEMPLATE,
  ) as Record<string, any>;
  const raw = (value as Record<string, unknown>) || {};
  const config = (raw.config as Record<string, unknown>) || raw;
  const dbAllowedCidrs = firstStringArray(
    raw.allowed_address_ranges,
    config.dbAllowedCidrs,
    raw.dbAllowedCidrs,
  );
  const dbAllowedCidrsV6 = firstStringArray(
    config.dbAllowedCidrsV6,
    raw.dbAllowedCidrsV6,
  );

  response.config = {
    ...(response.config as Record<string, unknown>),
    dbAllowedCidrs,
    dbAllowedCidrsV6,
  };
  response.status = "applied";
  response.entitlement = dbAllowedCidrs.length > 0 ? "allowed" : "disallowed";
  return response;
}

async function updateNetworkRestrictions(
  ref: string,
  allowedAddressRanges: string[],
) {
  const success = await projectService.updateNetworkRestrictions(
    ref,
    allowedAddressRanges,
  );
  if (!success) {
    return status(500, {
      message: allowedAddressRanges.length > 0
        ? "Failed to update network restrictions"
        : "Failed to remove network restrictions",
      code: "500",
    });
  }
  return {
    config: { dbAllowedCidrs: allowedAddressRanges },
    status: "applied",
    entitlement: "allowed",
  };
}

export const projectNetworkRestrictionRoutes = new Elysia({
  name: "project-network-restriction-routes",
})
  .get(
    "/:ref/network-restrictions",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const settings = await projectService.getProjectSettings(params.ref);
      if (!settings) return status(404, { message: "Project not found" });
      return buildNetworkRestrictionsResponse(
        (settings as Record<string, unknown>).network_restrictions,
      );
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Get network restrictions" },
    },
  )
  .post(
    "/:ref/network-restrictions",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      return updateNetworkRestrictions(params.ref, body.allowed_address_ranges);
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({ allowed_address_ranges: t.Array(t.String()) }),
      detail: { tags: ["projects"], summary: "Update network restrictions" },
    },
  )
  .patch(
    "/:ref/network-restrictions",
    async ({ params, body, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      return updateNetworkRestrictions(params.ref, body.allowed_address_ranges);
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({ allowed_address_ranges: t.Array(t.String()) }),
      detail: { tags: ["projects"], summary: "Patch network restrictions" },
    },
  )
  .delete(
    "/:ref/network-restrictions",
    async ({ params, request }) => {
      const authError = await requireAdminAuth(request);
      if (authError) return status(authError.status, authError.body);
      return updateNetworkRestrictions(params.ref, []);
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["projects"], summary: "Remove network restrictions" },
    },
  );
