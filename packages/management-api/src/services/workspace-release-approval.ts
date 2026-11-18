import {
  parseWorkspaceReleaseApproval, workspaceApprovalId, workspaceRepositoryId,
  type WorkspaceReleaseApproval, type WorkspaceReleaseApprovalIdentity,
} from "@supacloud/delivery";

export class WorkspaceReleaseApprovalError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = "WorkspaceReleaseApprovalError";
  }
}

export interface WorkspaceApprovalStore {
  putIfAbsent(record: WorkspaceReleaseApproval): Promise<{ record: WorkspaceReleaseApproval; inserted: boolean }>;
  get(projectRef: string, approvalId: string): Promise<WorkspaceReleaseApproval | null>;
}

export class MemoryWorkspaceApprovalStore implements WorkspaceApprovalStore {
  private readonly records = new Map<string, WorkspaceReleaseApproval>();

  async putIfAbsent(record: WorkspaceReleaseApproval): Promise<{ record: WorkspaceReleaseApproval; inserted: boolean }> {
    const key = `${record.project_ref}\0${record.approval_id}`;
    const existing = this.records.get(key);
    if (existing) return { record: structuredClone(existing), inserted: false };
    this.records.set(key, structuredClone(record));
    return { record: structuredClone(record), inserted: true };
  }

  async get(projectRef: string, approvalId: string): Promise<WorkspaceReleaseApproval | null> {
    return structuredClone(this.records.get(`${projectRef}\0${approvalId}`) ?? null);
  }
}

export interface WorkspaceApprovalAudit {
  actor: string;
  actorType: string;
  requestId: string;
  platformAdmin?: boolean;
}

export interface WorkspaceApprovalDependencies {
  store: WorkspaceApprovalStore;
  now?: () => string;
  audit?: (record: WorkspaceReleaseApproval, audit: WorkspaceApprovalAudit) => Promise<void>;
  authorize?: (projectRef: string, audit: WorkspaceApprovalAudit, capability: "applications.read" | "applications.manage") => Promise<void>;
}

function identityOf(input: WorkspaceReleaseApprovalIdentity): WorkspaceReleaseApprovalIdentity {
  return {
    repository: input.repository,
    project_ref: input.project_ref,
    application_id: input.application_id,
    environment_id: input.environment_id,
    release_id: input.release_id,
    manifest_sha256: input.manifest_sha256,
    config_digest: input.config_digest,
    source_revision: input.source_revision,
    workspace_plan_sha256: input.workspace_plan_sha256,
  };
}

/** Grant and consume require applications.manage. The actor is audited and is not part of the approval digest, so another manage-capable principal on the same project may consume the first grant. */
export class WorkspaceReleaseApprovals {
  constructor(private readonly dependencies: WorkspaceApprovalDependencies) {}

  async grant(input: WorkspaceReleaseApprovalIdentity, audit: WorkspaceApprovalAudit): Promise<WorkspaceReleaseApproval> {
    await this.dependencies.authorize?.(input.project_ref, audit, "applications.manage");
    const createdAt = this.dependencies.now?.() ?? new Date().toISOString();
    const record = parseWorkspaceReleaseApproval({
      schema: "supacloud.workspace-release-approval.v1",
      ...identityOf(input),
      repository_id: workspaceRepositoryId(input.repository),
      approval_id: workspaceApprovalId(input),
      actor: audit.actor,
      created_at: createdAt,
    });
    const outcome = await this.dependencies.store.putIfAbsent(record);
    const stored = outcome.record;
    if (outcome.inserted) await this.dependencies.audit?.(stored, audit);
    if (stored.approval_id !== record.approval_id || stored.release_id !== record.release_id
      || stored.manifest_sha256 !== record.manifest_sha256 || stored.project_ref !== record.project_ref
      || stored.application_id !== record.application_id || stored.environment_id !== record.environment_id
      || stored.config_digest !== record.config_digest || stored.source_revision !== record.source_revision
      || stored.workspace_plan_sha256 !== record.workspace_plan_sha256 || stored.repository_id !== record.repository_id) {
      throw new WorkspaceReleaseApprovalError("WORKSPACE_APPROVAL_CONFLICT", 409);
    }
    return parseWorkspaceReleaseApproval(stored);
  }

  async read(projectRef: string, approvalId: string, audit: WorkspaceApprovalAudit): Promise<WorkspaceReleaseApproval> {
    await this.dependencies.authorize?.(projectRef, audit, "applications.read");
    const stored = await this.dependencies.store.get(projectRef, approvalId);
    if (!stored || stored.project_ref !== projectRef || stored.approval_id !== approvalId) {
      throw new WorkspaceReleaseApprovalError("WORKSPACE_APPROVAL_NOT_FOUND", 404);
    }
    return parseWorkspaceReleaseApproval(stored);
  }

  async assertMatch(projectRef: string, approvalId: string, expected: WorkspaceReleaseApprovalIdentity): Promise<WorkspaceReleaseApproval> {
    const stored = await this.dependencies.store.get(projectRef, approvalId);
    const parsed = stored ? parseWorkspaceReleaseApproval(stored) : null;
    if (!parsed || parsed.project_ref !== projectRef || workspaceApprovalId(expected) !== approvalId
      || parsed.repository !== expected.repository || parsed.application_id !== expected.application_id
      || parsed.environment_id !== expected.environment_id || parsed.release_id !== expected.release_id
      || parsed.manifest_sha256 !== expected.manifest_sha256 || parsed.config_digest !== expected.config_digest
      || parsed.source_revision !== expected.source_revision || parsed.workspace_plan_sha256 !== expected.workspace_plan_sha256) {
      throw new WorkspaceReleaseApprovalError("WORKSPACE_APPROVAL_MISMATCH", 409);
    }
    return parsed;
  }
}

export async function executeApprovedPromotion<T extends { mutation_id: string | null }>(
  approvals: WorkspaceReleaseApprovals,
  projectRef: string,
  approvalId: string,
  expected: WorkspaceReleaseApprovalIdentity,
  mutationId: string,
  execute: () => Promise<T>,
): Promise<T> {
  await approvals.assertMatch(projectRef, approvalId, expected);
  const result = await execute();
  if (result.mutation_id !== mutationId) throw new WorkspaceReleaseApprovalError("WORKSPACE_MUTATION_IDENTITY_CHANGED", 503);
  return result;
}
