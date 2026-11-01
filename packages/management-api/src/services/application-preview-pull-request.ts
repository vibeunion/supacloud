import { createHash } from "node:crypto";
import type { StoredApplicationPreview } from "./application-preview-contract";
import type { ApplicationPreviewService } from "./application-preview.service";

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export interface PreviewPullRequestEvent {
  action: "opened" | "closed";
  repository: string;
  number: number;
  projectRef: string;
  applicationId: string;
  environmentId: string;
  releaseId: string;
}

export interface PreviewPullRequestOutcome {
  action: "opened" | "closed";
  preview_id: string;
  status: "absent" | StoredApplicationPreview["status"];
  leftovers: string[];
  receipt: StoredApplicationPreview | null;
}

type PreviewScenarioApi = Pick<ApplicationPreviewService, "create" | "reconcile" | "cleanup" | "read">;

/** Stable preview identity for one repository pull request. Not a GitHub identifier. */
export function applicationPreviewIdForPullRequest(repository: string, number: number): string {
  if (!REPOSITORY.test(repository)) throw new Error("APPLICATION_PREVIEW_REPOSITORY_INVALID");
  if (!Number.isInteger(number) || number < 1 || number > 1_000_000_000) {
    throw new Error("APPLICATION_PREVIEW_PULL_REQUEST_INVALID");
  }
  return createHash("sha256")
    .update(`supacloud.preview-pull-request.v1\0${repository}\0${number}`)
    .digest("hex")
    .slice(0, 32);
}

export function previewReclaimLeftovers(input: {
  app: boolean;
  functions: readonly string[];
  database: boolean;
  queue: boolean;
  storage: boolean;
  secret: boolean;
}): string[] {
  const leftovers: string[] = [];
  if (input.app) leftovers.push("app");
  if (input.functions.length > 0) leftovers.push("functions");
  if (input.database) leftovers.push("database");
  if (input.queue) leftovers.push("queue");
  if (input.storage) leftovers.push("storage");
  if (input.secret) leftovers.push("secret");
  return leftovers;
}

function unfinished(receipt: StoredApplicationPreview): string[] {
  const names: Record<string, string> = {
    application_activation: "app",
    functions: "functions",
    database_branch: "database",
    queue_namespace: "queue",
    storage_namespace: "storage",
    test_secret: "secret",
  };
  return Object.entries(receipt.resources).flatMap(([key, resource]) => {
    const name = names[key];
    if (!name || !resource || typeof resource !== "object" || !("status" in resource)) return [];
    return resource.status === "ready" || resource.status === "cleaned" ? [] : [name];
  });
}

/**
 * Local stand-in for pull request open and close. Open provisions one isolated
 * preview. Close reclaims it. This does not call GitHub and does not deploy.
 */
export async function applyPreviewPullRequest(
  previews: PreviewScenarioApi,
  event: PreviewPullRequestEvent,
  inspect?: (receipt: StoredApplicationPreview) => Promise<string[]>,
): Promise<PreviewPullRequestOutcome> {
  const previewId = applicationPreviewIdForPullRequest(event.repository, event.number);
  if (event.action === "opened") {
    const created = await previews.create({
      projectRef: event.projectRef,
      applicationId: event.applicationId,
      environmentId: event.environmentId,
      releaseId: event.releaseId,
      previewId,
      branchName: `pr-${event.number}`,
      dataMode: "schema_only",
    });
    const receipt = await previews.reconcile(event.projectRef, created.preview_id);
    return {
      action: "opened",
      preview_id: previewId,
      status: receipt?.status ?? "absent",
      leftovers: receipt && receipt.status !== "ready" ? unfinished(receipt) : [],
      receipt,
    };
  }
  const existing = await previews.read(event.projectRef, previewId);
  if (!existing || existing.project_ref !== event.projectRef
    || existing.application_id !== event.applicationId
    || existing.environment_id !== event.environmentId) {
    return { action: "closed", preview_id: previewId, status: "absent", leftovers: [], receipt: null };
  }
  let receipt: StoredApplicationPreview | null;
  try {
    receipt = await previews.cleanup(event.projectRef, previewId, { reclaim: true });
  } catch (error) {
    if (error instanceof Error && (error.message === "APPLICATION_PREVIEW_RECLAIM_INCOMPLETE"
      || error.message === "APPLICATION_PREVIEW_RECLAIM_AUDIT_REQUIRED")) {
      return {
        action: "closed", preview_id: previewId, status: "failed", leftovers: ["unconfirmed"],
        receipt: await previews.read(event.projectRef, previewId),
      };
    }
    throw error;
  }
  const leftovers = receipt && inspect ? await inspect(receipt) : receipt?.status === "cleaned" ? [] : ["unconfirmed"];
  const reclaimed = receipt?.status === "cleaned" && leftovers.length === 0;
  return {
    action: "closed",
    preview_id: previewId,
    status: reclaimed ? "cleaned" : receipt?.status === "cleaned" ? "failed" : (receipt?.status ?? "absent"),
    leftovers,
    receipt,
  };
}
