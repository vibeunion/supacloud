import { expect, test } from "bun:test";
import { parseWorkspaceReleaseApproval, workspaceApprovalId, workspaceRepositoryId } from "./workspace-release-approval";

const identity = {
  repository: "github.com/acme/store",
  project_ref: "store-prd",
  application_id: "storefront",
  environment_id: "production",
  release_id: "a".repeat(64),
  manifest_sha256: "b".repeat(64),
  config_digest: "c".repeat(64),
  source_revision: "d".repeat(40),
  workspace_plan_sha256: "e".repeat(64),
};

test("approval identity changes when the release digest or target changes", () => {
  const original = workspaceApprovalId(identity);
  expect(workspaceApprovalId({ ...identity, manifest_sha256: "f".repeat(64) })).not.toBe(original);
  expect(workspaceApprovalId({ ...identity, project_ref: "store-stg" })).not.toBe(original);
  expect(workspaceApprovalId(identity)).toBe(original);
  const record = parseWorkspaceReleaseApproval({
    schema: "supacloud.workspace-release-approval.v1", ...identity,
    repository_id: workspaceRepositoryId(identity.repository), approval_id: original,
    actor: "user-1", created_at: "2026-11-18T00:00:00.000Z",
  });
  expect(record.actor).toBe("user-1");
  expect(() => parseWorkspaceReleaseApproval({ ...record, approval_id: "0".repeat(64) })).toThrow("Invalid workspace release approval");
});
