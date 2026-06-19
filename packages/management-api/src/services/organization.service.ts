import { organizationRepository } from "../repositories/organization.repository";
import type { Organization, OrganizationMember } from "../db";

const ORGANIZATION_ROLES = new Set(["owner", "admin", "member", "viewer"]);

export class OrganizationServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrganizationServiceError";
  }
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  plan?: string;
  owner_id?: string | null;
}

export interface UpdateOrganizationInput {
  name?: string;
  slug?: string;
  plan?: string;
  owner_id?: string | null;
}

export interface UpsertMemberInput {
  email: string;
  role?: string;
  user_id?: string | null;
}

function normalizeName(name: string | undefined): string {
  const normalized = name?.trim() ?? "";
  if (!normalized) {
    throw new OrganizationServiceError(400, "400", "Organization name is required");
  }
  if (normalized.length > 100) {
    throw new OrganizationServiceError(400, "400", "Organization name must be at most 100 characters");
  }
  return normalized;
}

function normalizeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!slug) {
    throw new OrganizationServiceError(400, "400", "Organization slug is required");
  }
  if (slug.length > 100) {
    throw new OrganizationServiceError(400, "400", "Organization slug must be at most 100 characters");
  }
  return slug;
}

function normalizeOptionalPlan(plan: string | undefined): string | undefined {
  if (plan === undefined) return undefined;
  const normalized = plan.trim().toLowerCase();
  if (!normalized) {
    throw new OrganizationServiceError(400, "400", "Organization plan cannot be empty");
  }
  if (!/^[a-z0-9._-]{1,50}$/.test(normalized)) {
    throw new OrganizationServiceError(400, "400", "Organization plan may only contain letters, numbers, dots, dashes, and underscores");
  }
  return normalized;
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new OrganizationServiceError(400, "400", "Valid member email is required");
  }
  if (normalized.length > 320) {
    throw new OrganizationServiceError(400, "400", "Member email must be at most 320 characters");
  }
  return normalized;
}

function normalizeRole(role: string | undefined): string {
  const normalized = (role ?? "member").trim().toLowerCase();
  if (!ORGANIZATION_ROLES.has(normalized)) {
    throw new OrganizationServiceError(400, "400", "Member role must be one of owner, admin, member, viewer");
  }
  return normalized;
}

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

export async function getOrganizationBySlug(slug: string): Promise<Organization | null> {
  await organizationRepository.ensureDefaultOrganization();
  return await organizationRepository.findBySlug(slug);
}

export async function createOrganization(input: CreateOrganizationInput): Promise<Organization> {
  const name = normalizeName(input.name);
  const slug = normalizeSlug(input.slug ?? name);
  const plan = normalizeOptionalPlan(input.plan) ?? "free";

  const existing = await organizationRepository.findBySlug(slug);
  if (existing) {
    throw new OrganizationServiceError(409, "409", "Organization slug already exists");
  }

  return await organizationRepository.create({
    name,
    slug,
    plan,
    owner_id: input.owner_id ?? null,
  });
}

export async function updateOrganization(slug: string, input: UpdateOrganizationInput): Promise<Organization> {
  const existing = await organizationRepository.findBySlug(slug);
  if (!existing) {
    throw new OrganizationServiceError(404, "404", "Organization not found");
  }

  const nextSlug = input.slug === undefined ? undefined : normalizeSlug(input.slug);
  if (nextSlug && nextSlug !== slug) {
    const duplicate = await organizationRepository.findBySlug(nextSlug);
    if (duplicate) {
      throw new OrganizationServiceError(409, "409", "Organization slug already exists");
    }
  }

  const updated = await organizationRepository.updateBySlug(slug, {
    name: input.name === undefined ? undefined : normalizeName(input.name),
    slug: nextSlug,
    plan: normalizeOptionalPlan(input.plan),
    owner_id: input.owner_id,
  });

  if (!updated) {
    throw new OrganizationServiceError(404, "404", "Organization not found");
  }
  return updated;
}

export async function deleteOrganization(slug: string): Promise<Organization> {
  const existing = await organizationRepository.findBySlug(slug);
  if (!existing) {
    throw new OrganizationServiceError(404, "404", "Organization not found");
  }
  if (existing.slug === "default") {
    throw new OrganizationServiceError(409, "409", "Default organization cannot be deleted");
  }

  const projectCount = await organizationRepository.countProjects(existing.id);
  if (projectCount > 0) {
    throw new OrganizationServiceError(409, "409", "Organization has active projects and cannot be deleted");
  }

  const deleted = await organizationRepository.deleteBySlug(slug);
  if (!deleted) {
    throw new OrganizationServiceError(404, "404", "Organization not found");
  }
  return deleted;
}

export async function listMembers(slug: string): Promise<OrganizationMember[]> {
  const org = await organizationRepository.findBySlug(slug);
  if (!org) {
    throw new OrganizationServiceError(404, "404", "Organization not found");
  }
  return await organizationRepository.findMembers(org.id);
}

export async function addMember(slug: string, input: UpsertMemberInput): Promise<OrganizationMember> {
  const org = await organizationRepository.findBySlug(slug);
  if (!org) {
    throw new OrganizationServiceError(404, "404", "Organization not found");
  }
  return await organizationRepository.upsertMember(org.id, {
    email: normalizeEmail(input.email),
    role: normalizeRole(input.role),
    user_id: input.user_id ?? null,
  });
}

export async function removeMember(slug: string, id: string): Promise<OrganizationMember> {
  const org = await organizationRepository.findBySlug(slug);
  if (!org) {
    throw new OrganizationServiceError(404, "404", "Organization not found");
  }
  const deleted = await organizationRepository.deleteMember(org.id, id);
  if (!deleted) {
    throw new OrganizationServiceError(404, "404", "Organization member not found");
  }
  return deleted;
}

export const organizationService = {
  listOrganizations,
  getDefaultOrganization,
  getOrganizationBySlug,
  createOrganization,
  updateOrganization,
  deleteOrganization,
  listMembers,
  addMember,
  removeMember,
};
