import { Elysia } from "elysia";
import { organizationService } from "../services/organization.service";

export const organizationRoutes = new Elysia({ prefix: "/v1/organizations" })
    .get("/", async () => {
        return await organizationService.listOrganizations();
    })
    .get("", async () => {
        return await organizationService.listOrganizations();
    })
    .get("/:slug", async ({ params, set }) => {
        const orgs = await organizationService.listOrganizations();
        // 模拟按 slug 查找（目前只有一个默认组织）
        const org = orgs.find((o: any) => o.slug === params.slug) || orgs[0];
        if (!org) {
            set.status = 404;
            return { error: "Organization not found" };
        }
        return org;
    });
