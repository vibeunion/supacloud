import { expect, test } from "bun:test";
import {
  composePreviewEnvironment,
  PreviewEnvironmentError,
  type PreviewEnvironment,
} from "../../src/services/preview-environment.service";
import { previewInputFromBranch, isPreviewBranchEligible } from "../../src/services/preview-branch.service";
import { createPreviewDatabasePort } from "../../src/services/preview-provisioning.service";

const branch = {
  ref: "a1b2c3d4e5f60718293a" as const,
  name: "feature/orders",
  parent_ref: "demo",
  status: "active" as const,
  created_at: "2026-09-30T00:00:00.000Z",
  data_mode: "schema_only" as const,
  git_branch: "feature/orders",
  git_commit: "b".repeat(40),
  branch_type: "preview" as const,
};

const releaseId = "c".repeat(64);

test("reuses the existing Supabase-compatible branch instead of composing a namespace", () => {
  const input = previewInputFromBranch({
    projectRef: "demo", branch, applicationId: "reviews", environmentId: "preview", releaseId,
  });
  const preview = composePreviewEnvironment(input);
  expect(preview.preview_ref).toBe(branch.ref);
  expect(preview.branch_ref).toBe(branch.ref);
  expect(preview.branch_preexisting).toBe(true);
  expect(preview.branch_type).toBe("preview");
  expect(preview.data_mode).toBe("schema_only");
  expect(preview.source).toEqual({ branch: "feature/orders", commit: "b".repeat(40) });
  expect(preview.notes.join(" ")).toContain("existing Supabase-compatible branch");
});

test("does not create or delete a branch the branch service already owns", async () => {
  const calls: string[] = [];
  const database = createPreviewDatabasePort({
    createBranch: async () => { calls.push("create"); },
    deleteBranch: async () => { calls.push("delete"); },
  });
  const preview = composePreviewEnvironment({
    previewRef: branch.ref, projectRef: "demo", applicationId: "reviews", environmentId: "preview",
    releaseId, branchRef: branch.ref, source: { branch: branch.git_branch, commit: branch.git_commit },
  });
  await database.database.create(preview);
  await database.database.delete(preview);
  expect(calls).toEqual([]);

  const owned = composePreviewEnvironment({
    previewRef: "pr-7", projectRef: "demo", applicationId: "reviews", environmentId: "preview",
    releaseId, source: { branch: "feature/orders", commit: "" },
  });
  await database.database.create(owned);
  await database.database.delete(owned);
  expect(calls).toEqual(["create", "delete"]);
});

test("only an active branch of the project may back a preview", () => {
  expect(isPreviewBranchEligible("demo", branch)).toBe(true);
  expect(isPreviewBranchEligible("other", branch)).toBe(false);
  expect(isPreviewBranchEligible("demo", { ...branch, status: "creating" })).toBe(false);
});

test("still refuses production-shaped branches and unverified full clones", () => {
  expect(() => composePreviewEnvironment(previewInputFromBranch({
    projectRef: "demo", branch: { ...branch, git_branch: "prod-orders" },
    applicationId: "reviews", environmentId: "preview", releaseId,
  }))).toThrow(new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_PRODUCTION_FORBIDDEN"));

  expect(() => composePreviewEnvironment(previewInputFromBranch({
    projectRef: "demo", branch: { ...branch, data_mode: "full_clone" as const },
    applicationId: "reviews", environmentId: "preview", releaseId,
  }))).toThrow(new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_FULL_CLONE_REQUIRES_AUTHORIZATION"));

  const clone = composePreviewEnvironment(previewInputFromBranch({
    projectRef: "demo", branch: { ...branch, data_mode: "full_clone" as const },
    applicationId: "reviews", environmentId: "preview", releaseId, authorizedFullClone: true,
  }));
  expect(clone.data_mode).toBe("full_clone");
});

test("accepts the platform UUIDv4 configuration revision as canonical", () => {
  const preview: PreviewEnvironment = composePreviewEnvironment(previewInputFromBranch({
    projectRef: "demo", branch, applicationId: "reviews", environmentId: "preview", releaseId,
    configurationId: "0f9c1f1a-1c2b-4d3e-8f4a-5b6c7d8e9f01",
  }));
  expect(preview.configuration_id).toBe("0f9c1f1a-1c2b-4d3e-8f4a-5b6c7d8e9f01");
});