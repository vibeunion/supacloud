import { Elysia, status, t } from "elysia";
import { getVerifiedRequestPrincipal, requireAdminAuth } from "../middleware/auth";
import { projectRepository } from "../repositories/project.repository";
import { listProjectSsoProviders } from "./auth-sso";
import { createProjectAuditExport } from "./project-audit";
import { describeKeyCustody, scimGovernanceGap, SSO_SEAM } from "../services/enterprise-governance";
import { organizationTeamService } from "../services/organization-team.service";
import { isAppError } from "../utils/errors";

function toHttpError(error: unknown) {
  if (isAppError(error)) return status(error.statusCode, error.toJSON());
  throw error;
}

async function actor(request: Request): Promise<{ id: string; type: string }> {
  const principal = await getVerifiedRequestPrincipal(request);
  return principal ?? { id: "master", type: "master" };
}

export const organizationGovernanceRoutes = new Elysia({ prefix: "/v1/organizations" })
  .onBeforeHandle(async ({ request }) => {
    const authError = await requireAdminAuth(request);
    if (authError) return status(authError.status, authError.body);
  })
  .get("/:slug/governance", {
    params: t.Object({ slug: t.String() }),
    detail: { tags: ["organizations"], summary: "Read organization governance catalog and counts" },
  }, async ({ params }) => {
    try {
      return await organizationTeamService.governanceSnapshot(params.slug);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:slug/teams", {
    params: t.Object({ slug: t.String() }),
    detail: { tags: ["organizations"], summary: "List organization teams" },
  }, async ({ params }) => {
    try {
      const items = await organizationTeamService.listTeams(params.slug);
      return { items, total: items.length };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/:slug/teams", {
    params: t.Object({ slug: t.String() }),
    body: t.Object({
      name: t.String(),
      slug: t.Optional(t.String()),
      description: t.Optional(t.Nullable(t.String())),
    }),
    detail: { tags: ["organizations"], summary: "Create an organization team" },
  }, async ({ params, body, set }) => {
    try {
      const team = await organizationTeamService.createTeam(params.slug, body);
      set.status = 201;
      return team;
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:slug/teams/:teamSlug", {
    params: t.Object({ slug: t.String(), teamSlug: t.String() }),
    detail: { tags: ["organizations"], summary: "Get an organization team" },
  }, async ({ params }) => {
    try {
      return await organizationTeamService.getTeam(params.slug, params.teamSlug);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .patch("/:slug/teams/:teamSlug", {
    params: t.Object({ slug: t.String(), teamSlug: t.String() }),
    body: t.Object({
      name: t.Optional(t.String()),
      slug: t.Optional(t.String()),
      description: t.Optional(t.Nullable(t.String())),
    }),
    detail: { tags: ["organizations"], summary: "Update an organization team" },
  }, async ({ params, body }) => {
    try {
      return await organizationTeamService.updateTeam(params.slug, params.teamSlug, body);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .delete("/:slug/teams/:teamSlug", {
    params: t.Object({ slug: t.String(), teamSlug: t.String() }),
    detail: { tags: ["organizations"], summary: "Delete an organization team and release its project grants" },
  }, async ({ params }) => {
    try {
      return await organizationTeamService.deleteTeam(params.slug, params.teamSlug);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:slug/teams/:teamSlug/members", {
    params: t.Object({ slug: t.String(), teamSlug: t.String() }),
    detail: { tags: ["organizations"], summary: "List organization team members" },
  }, async ({ params }) => {
    try {
      const items = await organizationTeamService.listTeamMembers(params.slug, params.teamSlug);
      return { items, total: items.length };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/:slug/teams/:teamSlug/members", {
    params: t.Object({ slug: t.String(), teamSlug: t.String() }),
    body: t.Object({
      member_id: t.String(),
      role: t.Optional(t.String()),
    }),
    detail: { tags: ["organizations"], summary: "Add an organization member to a team" },
  }, async ({ params, body, request, set }) => {
    try {
      const member = await organizationTeamService.addTeamMember(params.slug, params.teamSlug, body, await actor(request));
      set.status = 201;
      return member;
    } catch (error) {
      return toHttpError(error);
    }
  })
  .delete("/:slug/teams/:teamSlug/members/:memberId", {
    params: t.Object({ slug: t.String(), teamSlug: t.String(), memberId: t.String() }),
    detail: { tags: ["organizations"], summary: "Remove an organization member from a team" },
  }, async ({ params }) => {
    try {
      return await organizationTeamService.removeTeamMember(params.slug, params.teamSlug, params.memberId);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:slug/teams/:teamSlug/projects", {
    params: t.Object({ slug: t.String(), teamSlug: t.String() }),
    detail: { tags: ["organizations"], summary: "List team project grants" },
  }, async ({ params }) => {
    try {
      const items = await organizationTeamService.listTeamGrants(params.slug, params.teamSlug);
      return { items, total: items.length };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .put("/:slug/teams/:teamSlug/projects/:ref", {
    params: t.Object({ slug: t.String(), teamSlug: t.String(), ref: t.String() }),
    body: t.Object({
      role: t.String(),
      capabilities: t.Optional(t.Nullable(t.Array(t.String()))),
    }),
    detail: { tags: ["organizations"], summary: "Grant a team a project role and optional capability allowlist" },
  }, async ({ params, body, request }) => {
    try {
      return await organizationTeamService.upsertTeamGrant(
        params.slug,
        params.teamSlug,
        params.ref,
        { role: body.role, capabilities: body.capabilities ?? null },
        await actor(request),
      );
    } catch (error) {
      return toHttpError(error);
    }
  })
  .delete("/:slug/teams/:teamSlug/projects/:ref", {
    params: t.Object({ slug: t.String(), teamSlug: t.String(), ref: t.String() }),
    detail: { tags: ["organizations"], summary: "Revoke a team project grant" },
  }, async ({ params }) => {
    try {
      return await organizationTeamService.deleteTeamGrant(params.slug, params.teamSlug, params.ref);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/:slug/audit/exports", {
    params: t.Object({ slug: t.String() }),
    body: t.Object({
      project_ref: t.String(),
      format: t.Optional(t.Union([t.Literal("jsonl"), t.Literal("csv")])),
      event_type: t.Optional(t.String()),
      resource_type: t.Optional(t.String()),
      resource_id: t.Optional(t.String()),
      actor_id: t.Optional(t.String()),
      status: t.Optional(t.Integer({ minimum: 100, maximum: 599 })),
      method: t.Optional(t.String()),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      limit: t.Optional(t.Number({ minimum: 1, maximum: 50000 })),
    }),
    detail: { tags: ["audit"], summary: "Create a project audit export for a project in this organization" },
  }, async ({ params, body, request, set }) => {
    try {
      const projects = await organizationTeamService.listOrganizationProjects(params.slug);
      if (!projects.some((project) => project.ref === body.project_ref)) {
        return status(404, { message: "Project not found", code: "NOT_FOUND" });
      }
      const principal = await actor(request);
      const record = await createProjectAuditExport(body.project_ref, body, principal.id) as Record<string, unknown>;
      set.status = 201;
      return {
        ...record,
        organization_slug: params.slug,
        scope: "project",
        download_url: `/v1/projects/${body.project_ref}/audit/exports/${String(record["id"])}/download`,
      };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:slug/sso", {
    params: t.Object({ slug: t.String() }),
    detail: { tags: ["auth"], summary: "List organization projects and the GoTrue SAML seam" },
  }, async ({ params }) => {
    try {
      const projects = await organizationTeamService.listOrganizationProjects(params.slug);
      return { ...SSO_SEAM, projects };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:slug/projects/:ref/sso/providers", {
    params: t.Object({ slug: t.String(), ref: t.String() }),
    detail: { tags: ["auth"], summary: "List GoTrue SSO providers for an organization project" },
  }, async ({ params, set }) => {
    try {
      const projects = await organizationTeamService.listOrganizationProjects(params.slug);
      if (!projects.some((project) => project.ref === params.ref)) {
        return status(404, { message: "Project not found", code: "NOT_FOUND" });
      }
      const result = await listProjectSsoProviders(params.ref);
      set.status = result.status;
      return result.body;
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:slug/scim", {
    params: t.Object({ slug: t.String() }),
    detail: { tags: ["organizations"], summary: "SCIM is not implemented" },
  }, () => status(501, scimGovernanceGap()))
  .post("/:slug/scim", {
    params: t.Object({ slug: t.String() }),
    detail: { tags: ["organizations"], summary: "SCIM is not implemented" },
  }, () => status(501, scimGovernanceGap()))
  .get("/:slug/projects/:ref/key-custody", {
    params: t.Object({ slug: t.String(), ref: t.String() }),
    detail: { tags: ["organizations"], summary: "Describe project key custody without revealing key material" },
  }, async ({ params }) => {
    try {
      const projects = await organizationTeamService.listOrganizationProjects(params.slug);
      if (!projects.some((project) => project.ref === params.ref)) {
        return status(404, { message: "Project not found", code: "NOT_FOUND" });
      }
      const project = await projectRepository.findByRef(params.ref);
      if (!project) return status(404, { message: "Project not found", code: "NOT_FOUND" });
      return {
        project_ref: project.ref,
        key_rotation_routes: {
          legacy_jwt: "POST /v1/projects/:ref/api-keys/rotate",
          opaque: "POST /v1/projects/:ref/api-keys/rotate-opaque",
        },
        custody: describeKeyCustody(project.config),
      };
    } catch (error) {
      return toHttpError(error);
    }
  });
