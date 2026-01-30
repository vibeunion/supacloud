import { organizationRepository } from "../repositories/organization.repository";
import type { Organization } from "../db";

export class OrganizationService {
    async listOrganizations(): Promise<Organization[]> {
        // 确保至少有一个默认组织
        await organizationRepository.ensureDefaultOrganization();
        return await organizationRepository.findAll();
    }

    async getDefaultOrganization(): Promise<Organization> {
        return await organizationRepository.ensureDefaultOrganization();
    }
}

export const organizationService = new OrganizationService();
