import { organizationRepository } from "../repositories/organization.repository";
import type { Organization } from "../db";

export class OrganizationService {
    async listOrganizations(): Promise<Organization[]> {
        // 确保至少有一个默认组织
        await organizationRepository.ensureDefaultOrganization();

        // 获取所有组织
        const orgs = await organizationRepository.findAll();

        // 如果列表为空（理论上不应该），再次尝试确保并获取
        if (orgs.length === 0) {
            const defaultOrg = await organizationRepository.ensureDefaultOrganization();
            return [defaultOrg];
        }

        return orgs;
    }

    async getDefaultOrganization(): Promise<Organization> {
        return await organizationRepository.ensureDefaultOrganization();
    }
}

export const organizationService = new OrganizationService();
