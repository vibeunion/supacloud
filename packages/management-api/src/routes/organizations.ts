import { Elysia } from "elysia";
import { organizationService } from "../services/organization.service";

export const organizationRoutes = new Elysia({ prefix: "/v1/organizations" })
    .get("/", async () => {
        return await organizationService.listOrganizations();
    })
    .get("", async () => {
        return await organizationService.listOrganizations();
    });
