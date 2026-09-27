import { Elysia, status, t } from "elysia";
import {
  isInvitationAcceptanceRequest,
  requireProjectOrAdminAuth,
} from "../middleware/auth";
import { projectOrganizationService } from "../services/project-organization.service";
import { isAppError } from "../utils/errors";
import { resolveInvitationPrincipal } from "../services/invitation-principal.service";
import {
  resolveTrustedPrincipal,
  type TrustedPrincipal,
} from "../services/bff-proof.service";
import { projectCollaboratorService } from "../services/project-collaborator.service";

const authorizedActors = new WeakMap<Request, TrustedPrincipal>();

function toHttpError(error: unknown) {
  if (isAppError(error)) return status(error.statusCode, error.toJSON());
  throw error;
}

function actorId(request: Request): string {
  return authorizedActors.get(request)!.id;
}

async function authorizeOrganizationRequest(request: Request, ref: string): Promise<void> {
  const actor = await resolveTrustedPrincipal(request, ref);
  const capability = request.method === "GET" ? "organizations.read" : "organizations.manage";
  await projectCollaboratorService.requireCapability(ref, actor, capability);
  authorizedActors.set(request, actor);
}

export const projectOrganizationRoutes = new Elysia({ prefix: "/v1/projects/:ref/organizations" })
  .beforeHandle(async ({ params, request }) => {
    if (isInvitationAcceptanceRequest(request)) return;
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
    try {
      await authorizeOrganizationRequest(request, params.ref);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("", {
    query: t.Object({
      page: t.Optional(t.String()),
      limit: t.Optional(t.String()),
      search: t.Optional(t.String()),
      application_id: t.Optional(t.String()),
    }, { additionalProperties: true }),
    detail: { tags: ["organizations"], summary: "List project business organizations" },
  }, async ({ params, query }) => {
    try {
      return await projectOrganizationService.list(params.ref, {
        page: Number(query.page || 1),
        limit: Number(query.limit || 50),
        search: query.search,
        application_id: query.application_id,
      });
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("", {
    body: t.Object({
      name: t.String(),
      slug: t.Optional(t.String()),
      description: t.Optional(t.Nullable(t.String())),
      branding: t.Optional(t.Record(t.String(), t.Unknown())),
      jit_enabled: t.Optional(t.Boolean()),
      jit_domains: t.Optional(t.Array(t.String())),
    }, { additionalProperties: false }),
    detail: { tags: ["organizations"], summary: "Create a project business organization" },
  }, async ({ params, body, request, set }) => {
    try {
      const created = await projectOrganizationService.create(params.ref, body, actorId(request));
      set.status = 201;
      return created;
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:orgId/members", {
    detail: { tags: ["organizations"], summary: "List business organization members" },
  }, async ({ params }) => {
    try {
      return await projectOrganizationService.listMembers(params.ref, params.orgId);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/:orgId/members", {
    body: t.Object({ user_id: t.String(), role: t.Optional(t.String()) }, { additionalProperties: false }),
    detail: { tags: ["organizations"], summary: "Add a GoTrue user to a business organization" },
  }, async ({ params, body, request, set }) => {
    try {
      const created = await projectOrganizationService.addMember(params.ref, params.orgId, {
        userId: body.user_id,
        role: body.role,
        actor: actorId(request),
      });
      set.status = 201;
      return created;
    } catch (error) {
      return toHttpError(error);
    }
  })
  .delete("/:orgId/members/:memberId", {
    detail: { tags: ["organizations"], summary: "Remove a business organization member" },
  }, async ({ params, request }) => {
    try {
      return {
        deleted: true,
        member: await projectOrganizationService.removeMember(
          params.ref,
          params.orgId,
          params.memberId,
          actorId(request),
        ),
      };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .patch("/:orgId/members/:memberId", {
    body: t.Object({ role: t.String() }, { additionalProperties: false }),
    detail: { tags: ["organizations"], summary: "Update a business organization member role" },
  }, async ({ params, body, request }) => {
    try {
      return await projectOrganizationService.updateMember(params.ref, params.orgId, params.memberId, {
        role: body.role,
        actor: actorId(request),
      });
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:orgId/invitations", {
    detail: { tags: ["organizations"], summary: "List business organization invitations" },
  }, async ({ params }) => {
    try {
      return await projectOrganizationService.listInvitations(params.ref, params.orgId);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/:orgId/invitations", {
    body: t.Object({
      email: t.String(),
      role: t.Optional(t.String()),
      ttl_hours: t.Optional(t.Number({ minimum: 1, maximum: 720 })),
    }, { additionalProperties: false }),
    detail: { tags: ["organizations"], summary: "Invite a business organization member" },
  }, async ({ params, body, request, set }) => {
    try {
      const invitation = await projectOrganizationService.invite({
        ref: params.ref,
        organizationId: params.orgId,
        email: body.email,
        role: body.role,
        actor: actorId(request),
        ttlHours: body.ttl_hours,
      });
      set.status = 201;
      return invitation;
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/:orgId/invitations/:invitationId/accept", {
    body: t.Object({ token: t.String() }, { additionalProperties: false }),
    detail: { tags: ["organizations"], summary: "Accept a business organization invitation" },
  }, async ({ params, body, request }) => {
    try {
      const principal = await resolveInvitationPrincipal(request, params.ref);
      return await projectOrganizationService.acceptInvitation({
        ref: params.ref,
        organizationId: params.orgId,
        invitationId: params.invitationId,
        token: body.token,
        principal,
      });
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/jit/reconcile", {
    body: t.Object({ user_id: t.String({ minLength: 1 }) }, { additionalProperties: false }),
    detail: { tags: ["organizations", "JIT"], summary: "Reconcile GoTrue user JIT organization memberships" },
  }, async ({ params, body }) => {
    try {
      return await projectOrganizationService.reconcileJitMemberships(params.ref, body.user_id);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .delete("/:orgId/invitations/:invitationId", {
    detail: { tags: ["organizations"], summary: "Revoke a business organization invitation" },
  }, async ({ params }) => {
    try {
      return { revoked: true, invitation: await projectOrganizationService.revokeInvitation(params.ref, params.orgId, params.invitationId) };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:orgId/applications", {
    detail: { tags: ["organizations"], summary: "List business organization application bindings" },
  }, async ({ params }) => {
    try {
      return await projectOrganizationService.listApplications(params.ref, params.orgId);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/:orgId/applications", {
    body: t.Object({ application_id: t.String() }, { additionalProperties: false }),
    detail: { tags: ["organizations"], summary: "Bind an OAuth application to a business organization" },
  }, async ({ params, body, request, set }) => {
    try {
      const binding = await projectOrganizationService.bindApplication(
        params.ref,
        params.orgId,
        body.application_id,
        actorId(request),
      );
      set.status = 201;
      return binding;
    } catch (error) {
      return toHttpError(error);
    }
  })
  .delete("/:orgId/applications/:applicationId", {
    detail: { tags: ["organizations"], summary: "Remove a business organization application binding" },
  }, async ({ params }) => {
    try {
      return {
        deleted: true,
        binding: await projectOrganizationService.unbindApplication(params.ref, params.orgId, params.applicationId),
      };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:orgId/jit", {
    detail: { tags: ["organizations"], summary: "Get business organization JIT settings" },
  }, async ({ params }) => {
    try {
      const organization = await projectOrganizationService.get(params.ref, params.orgId);
      return { enabled: organization.jit_enabled, domains: organization.jit_domains };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .put("/:orgId/jit", {
    body: t.Object({ enabled: t.Boolean(), domains: t.Array(t.String()) }, { additionalProperties: false }),
    detail: { tags: ["organizations"], summary: "Update business organization JIT settings" },
  }, async ({ params, body }) => {
    try {
      const organization = await projectOrganizationService.update(params.ref, params.orgId, {
        jit_enabled: body.enabled,
        jit_domains: body.domains,
      });
      return { enabled: organization.jit_enabled, domains: organization.jit_domains };
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:orgId/branding", {
    detail: { tags: ["organizations"], summary: "Get business organization branding" },
  }, async ({ params }) => {
    try {
      const organization = await projectOrganizationService.get(params.ref, params.orgId);
      return organization.branding || {};
    } catch (error) {
      return toHttpError(error);
    }
  })
  .put("/:orgId/branding", {
    body: t.Record(t.String(), t.Unknown()),
    detail: { tags: ["organizations"], summary: "Update business organization branding" },
  }, async ({ params, body }) => {
    try {
      const organization = await projectOrganizationService.update(params.ref, params.orgId, {
        branding: body,
      });
      return organization.branding || {};
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:orgId", {
    detail: { tags: ["organizations"], summary: "Get a project business organization" },
  }, async ({ params }) => {
    try {
      return await projectOrganizationService.get(params.ref, params.orgId);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .patch("/:orgId", {
    body: t.Object({
      name: t.Optional(t.String()),
      slug: t.Optional(t.String()),
      description: t.Optional(t.Nullable(t.String())),
      branding: t.Optional(t.Record(t.String(), t.Unknown())),
      jit_enabled: t.Optional(t.Boolean()),
      jit_domains: t.Optional(t.Array(t.String())),
    }, { additionalProperties: false }),
    detail: { tags: ["organizations"], summary: "Update a project business organization" },
  }, async ({ params, body }) => {
    try {
      return await projectOrganizationService.update(params.ref, params.orgId, body);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .delete("/:orgId", {
    detail: { tags: ["organizations"], summary: "Delete a project business organization" },
  }, async ({ params }) => {
    try {
      return { deleted: true, organization: await projectOrganizationService.remove(params.ref, params.orgId) };
    } catch (error) {
      return toHttpError(error);
    }
  });
