import { Elysia, t, status } from "elysia";
import { requireAdminAuth } from "../middleware/auth";
import { organizationService, OrganizationServiceError } from "../services/organization.service";
import type { Organization, OrganizationMember } from "../db";

function formatOrg(org: Organization) {
    const o = org as unknown as Record<string, unknown>;
    return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        plan: o.plan || "free",
        owner_id: o.owner_id || null,
        created_at: o.created_at,
        updated_at: o.updated_at,
    };
}

function formatMember(member: OrganizationMember) {
    return {
        id: member.id,
        organization_id: member.organization_id,
        email: member.email,
        role: member.role,
        user_id: member.user_id,
        invited_at: member.invited_at,
        joined_at: member.joined_at,
        created_at: member.created_at,
        updated_at: member.updated_at,
    };
}

function formatError(error: unknown) {
    if (error instanceof OrganizationServiceError) {
        return status(error.status, { message: error.message, code: error.code });
    }
    throw error;
}

export const organizationRoutes = new Elysia({ prefix: "/v1/organizations" })
    .get("/", async () => {
        const orgs = await organizationService.listOrganizations();
        return orgs.map(formatOrg);
    }, { detail: { tags: ["organizations"], summary: "List organizations" } })
    .get("", async () => {
        const orgs = await organizationService.listOrganizations();
        return orgs.map(formatOrg);
    }, { detail: { tags: ["organizations"], summary: "List organizations" } })
    .get("/:slug", async ({ params }) => {
        const org = await organizationService.getOrganizationBySlug(params.slug);
        if (!org) {
            return status(404, { message: "Organization not found", code: "404" });
        }
        return formatOrg(org);
    }, { detail: { tags: ["organizations"], summary: "Get organization by slug" } })
    .post(
        "/",
        async ({ body, request, set }) => {
            const authError = await requireAdminAuth(request);
            if (authError) return status(authError.status, authError.body);
            try {
                const org = await organizationService.createOrganization(body);
                set.status = 201;
                return formatOrg(org);
            } catch (error) {
                return formatError(error);
            }
        },
        {
            body: t.Object({
                name: t.String(),
                slug: t.Optional(t.String()),
                plan: t.Optional(t.String()),
                owner_id: t.Optional(t.Nullable(t.String())),
            }),
            detail: { tags: ["organizations"], summary: "Create organization" },
        }
    )
    .patch(
        "/:slug",
        async ({ params, body, request }) => {
            const authError = await requireAdminAuth(request);
            if (authError) return status(authError.status, authError.body);
            try {
                const org = await organizationService.updateOrganization(params.slug, body);
                return formatOrg(org);
            } catch (error) {
                return formatError(error);
            }
        },
        {
            params: t.Object({ slug: t.String() }),
            body: t.Object({
                name: t.Optional(t.String()),
                slug: t.Optional(t.String()),
                plan: t.Optional(t.String()),
                owner_id: t.Optional(t.Nullable(t.String())),
            }),
            detail: { tags: ["organizations"], summary: "Update organization" },
        }
    )
    .delete(
        "/:slug",
        async ({ params, request }) => {
            const authError = await requireAdminAuth(request);
            if (authError) return status(authError.status, authError.body);
            try {
                const org = await organizationService.deleteOrganization(params.slug);
                return { deleted: true, organization: formatOrg(org) };
            } catch (error) {
                return formatError(error);
            }
        },
        { params: t.Object({ slug: t.String() }), detail: { tags: ["organizations"], summary: "Delete organization" } }
    )
    .get(
        "/:slug/members",
        async ({ params, request }) => {
            const authError = await requireAdminAuth(request);
            if (authError) return status(authError.status, authError.body);
            try {
                const members = await organizationService.listMembers(params.slug);
                return members.map(formatMember);
            } catch (error) {
                return formatError(error);
            }
        },
        { params: t.Object({ slug: t.String() }), detail: { tags: ["organizations"], summary: "List organization members" } }
    )
    .post(
        "/:slug/members",
        async ({ params, body, request, set }) => {
            const authError = await requireAdminAuth(request);
            if (authError) return status(authError.status, authError.body);
            try {
                const member = await organizationService.addMember(params.slug, body);
                set.status = 201;
                return formatMember(member);
            } catch (error) {
                return formatError(error);
            }
        },
        {
            params: t.Object({ slug: t.String() }),
            body: t.Object({
                email: t.String(),
                role: t.Optional(t.String()),
                user_id: t.Optional(t.Nullable(t.String())),
            }),
            detail: { tags: ["organizations"], summary: "Add organization member" },
        }
    )
    .delete(
        "/:slug/members/:id",
        async ({ params, request }) => {
            const authError = await requireAdminAuth(request);
            if (authError) return status(authError.status, authError.body);
            try {
                const member = await organizationService.removeMember(params.slug, params.id);
                return { deleted: true, member: formatMember(member) };
            } catch (error) {
                return formatError(error);
            }
        },
        { params: t.Object({ slug: t.String(), id: t.String() }), detail: { tags: ["organizations"], summary: "Remove organization member" } }
    );
