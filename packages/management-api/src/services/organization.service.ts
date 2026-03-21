import { organizationRepository } from "../repositories/organization.repository";
import type { Organization } from "../db";

export async function listOrganizations(): Promise<Organization[]> {
  // Ensure at least one default organization exists
  await organizationRepository.ensureDefaultOrganization();

  // Get all organizations
  const orgs = await organizationRepository.findAll();

  // If list is empty (theoretically shouldn't happen), try again to ensure and get
  if (orgs.length === 0) {
    const defaultOrg = await organizationRepository.ensureDefaultOrganization();
    return [defaultOrg];
  }

  return orgs;
}

export async function getDefaultOrganization(): Promise<Organization> {
  return await organizationRepository.ensureDefaultOrganization();
}

export const organizationService = {
  listOrganizations,
  getDefaultOrganization,
};
