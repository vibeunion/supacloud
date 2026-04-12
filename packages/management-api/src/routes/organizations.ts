import { Elysia, status } from "elysia";
import { organizationService } from "../services/organization.service";
import type { Organization } from "../db";

function formatOrg(org: Organization) {
    const o = org as unknown as Record<string, unknown>;
    return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        plan: o.plan || "free",
    };
}

export const organizationRoutes = new Elysia({ prefix: "/v1/organizations" })
    .get("/", async () => {
        const orgs = await organizationService.listOrganizations();
        return orgs.map(formatOrg);
    })
    .get("", async () => {
        const orgs = await organizationService.listOrganizations();
        return orgs.map(formatOrg);
    })
    .get("/:slug", async ({ params }) => {
        const orgs = await organizationService.listOrganizations();
        const org = orgs.find((o) => o.slug === params.slug) || orgs[0];
        if (!org) {
                        return status(404, { error: "Organization not found" });
        }
        return formatOrg(org);
    });
