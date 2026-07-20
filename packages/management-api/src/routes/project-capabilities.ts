import { Elysia, status, t } from "elysia";
import { getProjectDb, resolveDbName, sql } from "../db";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { projectRepository } from "../repositories/project.repository";
import {
  getAuthRuntimeDescriptor,
  type AuthRuntimeDescriptor,
} from "../services/auth-runtime.service";
import { normalizeProjectConfig } from "../utils/project-config";
import { normalizeProjectRoutingConfig, resolveTenantPorts } from "../utils/project-routing";
import { config } from "../config";
import { detectOrganizationJitCapability } from "../services/organization-jit-capability.service";

type Capability = {
  available: boolean;
  source: "supacloud" | "gotrue";
  version: string | null;
  reason_code: string | null;
  authority_project_ref?: string;
  managed_by_owner?: boolean;
};

function available(source: Capability["source"], version: string): Capability {
  return { available: true, source, version, reason_code: null };
}

function unavailable(source: Capability["source"], reasonCode: string): Capability {
  return { available: false, source, version: null, reason_code: reasonCode };
}

async function detectGoTrueOAuthGrants(ref: string): Promise<Capability> {
  try {
    const dbName = await resolveDbName(ref);
    const projectDb = getProjectDb(dbName);
    const [row] = await projectDb`
      SELECT to_regclass('auth.oauth_consents') IS NOT NULL AS consents,
             to_regclass('auth.oauth_clients') IS NOT NULL AS clients,
             EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'auth' AND table_name = 'sessions'
                 AND column_name = 'oauth_client_id'
             ) AS oauth_sessions
    ` as Array<{ consents: boolean; clients: boolean; oauth_sessions: boolean }>;
    return row?.consents && row?.clients && row?.oauth_sessions
      ? available("gotrue", "oauth-consents-v1")
      : unavailable("gotrue", "gotrue_oauth_grants_schema_incomplete");
  } catch {
    return unavailable("gotrue", "gotrue_database_unavailable");
  }
}

function capabilityWithAuthority(capability: Capability, runtime: AuthRuntimeDescriptor): Capability {
  return {
    ...capability,
    authority_project_ref: runtime.authority_project_ref,
    managed_by_owner: runtime.mode === "shared",
  };
}

async function authorityProject(
  ref: string,
  project: Record<string, unknown>,
  runtime: AuthRuntimeDescriptor,
): Promise<Record<string, unknown> | null> {
  if (runtime.authority_project_ref === ref) return project;
  try {
    return await projectRepository.findByRef(runtime.authority_project_ref) as unknown as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

async function runtimeHealth(project: Record<string, unknown>): Promise<Capability> {
  try {
    const routing = normalizeProjectRoutingConfig(normalizeProjectConfig(project.config));
    const ports = resolveTenantPorts(routing);
    const url = ports?.gotruePort
      ? `http://127.0.0.1:${ports.gotruePort}/health`
      : `http://${config.managementApiInternal}/auth/health`;
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok
      ? available("gotrue", "stock")
      : unavailable("gotrue", "gotrue_health_check_failed");
  } catch {
    return unavailable("gotrue", "gotrue_unreachable");
  }
}

async function detectGoTrueRuntime(ref: string, project: Record<string, unknown>): Promise<Capability> {
  const runtime = getAuthRuntimeDescriptor(ref);
  const owner = await authorityProject(ref, project, runtime);
  const capability = owner
    ? await runtimeHealth(owner)
    : unavailable("gotrue", "auth_runtime_owner_project_unavailable");
  return capabilityWithAuthority(capability, runtime);
}

async function detectBusinessOrganizationCapability(): Promise<Capability> {
  try {
    const [row] = await sql`
      SELECT
        to_regclass('public.project_business_organizations') IS NOT NULL AS organizations,
        to_regclass('public.project_business_organization_members') IS NOT NULL AS members,
        to_regclass('public.project_business_organization_invitations') IS NOT NULL AS invitations
    ` as Array<{ organizations: boolean; members: boolean; invitations: boolean }>;
    return row?.organizations && row.members && row.invitations
      ? available("supacloud", "v1")
      : unavailable("supacloud", "business_organization_schema_incomplete");
  } catch {
    return unavailable("supacloud", "business_organization_schema_unavailable");
  }
}

export const projectCapabilityRoutes = new Elysia({ prefix: "/v1/projects/:ref" })
  .onBeforeHandle(async ({ params, request }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .get("/capabilities", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { message: "Project not found", code: "NOT_FOUND" });

    const authRuntime = getAuthRuntimeDescriptor(params.ref);
    const oauthGrants = await detectGoTrueOAuthGrants(authRuntime.authority_project_ref);
    const gotrueRuntime = await detectGoTrueRuntime(params.ref, project as unknown as Record<string, unknown>);
    const businessOrganizations = await detectBusinessOrganizationCapability();
    const projectConfig = normalizeProjectRoutingConfig(normalizeProjectConfig(project.config));
    const jitEvidence = await detectOrganizationJitCapability(params.ref, projectConfig);
    const capabilities: Record<string, Capability> = {
      business_organizations_v1: businessOrganizations,
      business_organization_crud_v1: businessOrganizations,
      business_organization_jit_v1: {
        ...jitEvidence,
        source: "gotrue",
        authority_project_ref: authRuntime.authority_project_ref,
        managed_by_owner: authRuntime.mode === "shared",
      },
      tenant_collaborators_v1: available("supacloud", "v1"),
      webhook_delivery_v2: available("supacloud", "v2"),
      audit_integrity_v1: available("supacloud", "v1"),
      audit_export_v1: available("supacloud", "v1"),
      gotrue_auth_hooks_v1: gotrueRuntime,
      gotrue_connectors_v1: gotrueRuntime,
      gotrue_oauth_grants_v1: {
        ...oauthGrants,
        authority_project_ref: authRuntime.authority_project_ref,
        managed_by_owner: authRuntime.mode === "shared",
      },
    };

    return {
      project_ref: params.ref,
      auth_runtime: "gotrue",
      schema_version: 1,
      capabilities,
    };
  }, {
    params: t.Object({ ref: t.String() }),
    detail: { tags: ["projects"], summary: "Get project platform capabilities" },
  });
