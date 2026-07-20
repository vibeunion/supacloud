import { Elysia, status, t } from "elysia";
import {
  isInvitationAcceptanceRequest,
  requireProjectOrAdminAuth,
} from "../middleware/auth";
import { projectCollaboratorService } from "../services/project-collaborator.service";
import { isAppError } from "../utils/errors";
import { resolveInvitationPrincipal } from "../services/invitation-principal.service";
import { resolveTrustedPrincipal } from "../services/bff-proof.service";

function toHttpError(error: unknown) {
  if (isAppError(error)) return status(error.statusCode, error.toJSON());
  throw error;
}

export const projectCollaboratorRoutes = new Elysia({ prefix: "/v1/projects/:ref" })
  .onBeforeHandle(async ({ params, request }) => {
    if (isInvitationAcceptanceRequest(request)) return;
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .get("/collaborators", async ({ params, request }) => {
    try {
      return await projectCollaboratorService.list(
        params.ref,
        await resolveTrustedPrincipal(request, params.ref),
      );
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    detail: { tags: ["collaborators"], summary: "List project collaborators" },
  })
  .post("/collaborators", async ({ params, body, request, set }) => {
    try {
      const actor = await resolveTrustedPrincipal(request, params.ref);
      const collaborator = await projectCollaboratorService.create(params.ref, body, actor);
      set.status = 201;
      return collaborator;
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    body: t.Object({
      principal_id: t.String(),
      email: t.Optional(t.Nullable(t.String())),
      role: t.String(),
    }, { additionalProperties: false }),
    detail: { tags: ["collaborators"], summary: "Add a project collaborator" },
  })
  .patch("/collaborators/:collaboratorId", async ({ params, body, request }) => {
    try {
      const actor = await resolveTrustedPrincipal(request, params.ref);
      return await projectCollaboratorService.update(params.ref, params.collaboratorId, body, actor);
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    body: t.Object({
      role: t.Optional(t.String()),
      status: t.Optional(t.String()),
    }, { additionalProperties: false }),
    detail: { tags: ["collaborators"], summary: "Update a project collaborator" },
  })
  .delete("/collaborators/:collaboratorId", async ({ params, request }) => {
    try {
      const actor = await resolveTrustedPrincipal(request, params.ref);
      const collaborator = await projectCollaboratorService.remove(params.ref, params.collaboratorId, actor);
      return { deleted: true, collaborator };
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    detail: { tags: ["collaborators"], summary: "Remove a project collaborator" },
  })
  .get("/collaborator-invitations", async ({ params, request }) => {
    try {
      const actor = await resolveTrustedPrincipal(request, params.ref);
      return await projectCollaboratorService.listInvitations(params.ref, actor);
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    detail: { tags: ["collaborators"], summary: "List project collaborator invitations" },
  })
  .post("/collaborator-invitations", async ({ params, body, request, set }) => {
    try {
      const actor = await resolveTrustedPrincipal(request, params.ref);
      const invitation = await projectCollaboratorService.invite(params.ref, body, actor);
      set.status = 201;
      return invitation;
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    body: t.Object({
      email: t.String(),
      role: t.String(),
      ttl_hours: t.Optional(t.Number({ minimum: 1, maximum: 720 })),
    }, { additionalProperties: false }),
    detail: { tags: ["collaborators"], summary: "Invite a project collaborator" },
  })
  .post("/collaborator-invitations/:invitationId/resend", async ({ params, request }) => {
    try {
      const actor = await resolveTrustedPrincipal(request, params.ref);
      return await projectCollaboratorService.resend(params.ref, params.invitationId, actor);
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    detail: { tags: ["collaborators"], summary: "Resend a project collaborator invitation" },
  })
  .post("/collaborator-invitations/:invitationId/accept", async ({ params, body, request }) => {
    try {
      const principal = await resolveInvitationPrincipal(request, params.ref);
      return await projectCollaboratorService.accept({
        ref: params.ref,
        invitationId: params.invitationId,
        token: body.token,
        principal,
      });
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    body: t.Object({ token: t.String() }, { additionalProperties: false }),
    detail: { tags: ["collaborators"], summary: "Accept a project collaborator invitation" },
  })
  .delete("/collaborator-invitations/:invitationId", async ({ params, request }) => {
    try {
      const actor = await resolveTrustedPrincipal(request, params.ref);
      const invitation = await projectCollaboratorService.revokeInvitation(params.ref, params.invitationId, actor);
      return { revoked: true, invitation };
    } catch (error) {
      return toHttpError(error);
    }
  }, {
    detail: { tags: ["collaborators"], summary: "Revoke a project collaborator invitation" },
  });
