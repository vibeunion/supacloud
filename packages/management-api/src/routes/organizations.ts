import { Elysia, status } from "elysia";
import { organizationService } from "../services/organization.service";

export const organizationRoutes = new Elysia({ prefix: "/v1/organizations" })
    .get("/", async () => {
        return await organizationService.listOrganizations();
    })
    .get("", async () => {
        return await organizationService.listOrganizations();
    })
    .get("/:slug", async ({ params }) => {
        const orgs = await organizationService.listOrganizations();
        // Simulate finding by slug (currently only one default organization)
        const org = orgs.find((o) => o.slug === params.slug) || orgs[0];
        if (!org) {
                        return status(404, { error: "Organization not found" });
        }
        return org;
    });
