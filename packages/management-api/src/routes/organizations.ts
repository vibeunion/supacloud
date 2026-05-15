import { Elysia, t, status } from "elysia";
import { organizationService } from "../services/organization.service";
import type { Organization } from "../db";

function formatOrg(org: Organization) {
    const o = org as unknown as Record<string, unknown>;
    return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        plan: o.plan || "free",
        owner_id: o.owner_id || o.id,
    };
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
        const orgs = await organizationService.listOrganizations();
        const org = orgs.find((o) => o.slug === params.slug) || orgs[0];
        if (!org) {
                        return status(404, { message: "Organization not found", code: "404" });
        }
        return formatOrg(org);
    }, { detail: { tags: ["organizations"], summary: "Get organization by slug" } })
    .post(
        "/",
        async ({ body, set }) => {
            set.status = 501;
            return { message: "Organization creation is not supported on this SupaCloud cluster", code: "501" };
        },
        { body: t.Object({ name: t.String(), slug: t.Optional(t.String()) }), detail: { tags: ["organizations"], summary: "Create organization" } }
    )
    .patch(
        "/:slug",
        async ({ params, body, set }) => {
            set.status = 501;
            return { message: "Organization update is not supported on this SupaCloud cluster", code: "501" };
        },
        { params: t.Object({ slug: t.String() }), body: t.Object({ name: t.Optional(t.String()) }), detail: { tags: ["organizations"], summary: "Update organization" } }
    )
    .delete(
        "/:slug",
        async ({ params, set }) => {
            set.status = 501;
            return { message: "Organization deletion is not supported on this SupaCloud cluster", code: "501" };
        },
        { params: t.Object({ slug: t.String() }), detail: { tags: ["organizations"], summary: "Delete organization" } }
    )
    .get(
        "/:slug/members",
        async ({ params }) => {
            return [];
        },
        { params: t.Object({ slug: t.String() }), detail: { tags: ["organizations"], summary: "List organization members" } }
    )
    .post(
        "/:slug/members",
        async ({ params, body, set }) => {
            set.status = 501;
            return { message: "Member management is not supported on this SupaCloud cluster", code: "501" };
        },
        { params: t.Object({ slug: t.String() }), body: t.Object({ email: t.String(), role: t.Optional(t.String()) }), detail: { tags: ["organizations"], summary: "Add organization member" } }
    )
    .delete(
        "/:slug/members/:id",
        async ({ params, set }) => {
            set.status = 501;
            return { message: "Member management is not supported on this SupaCloud cluster", code: "501" };
        },
        { params: t.Object({ slug: t.String(), id: t.String() }), detail: { tags: ["organizations"], summary: "Remove organization member" } }
    );
