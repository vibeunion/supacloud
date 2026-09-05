import { Elysia, t, type Static, status } from "elysia";
import { logger } from "../utils/logger";
import { frontendService } from "../services/frontend.service";
import type { FrontendDeployment } from "../types/frontend";
import { timingSafeEqual } from "node:crypto";
import { processAutoBranchingFromPush } from "../services/auto-branching.service";

// Shared TypeBox schema for Git webhook payloads (GitHub/GitLab/Gitee/GitCode)
const WebhookBodySchema = t.Object({
  ref: t.Optional(t.String()),
  after: t.Optional(t.String()),
  checkout_sha: t.Optional(t.String()),
  repository: t.Optional(t.Object({
    full_name: t.Optional(t.String()),
    git_http_url: t.Optional(t.String()),
    clone_url: t.Optional(t.String()),
    html_url: t.Optional(t.String()),
    path_with_namespace: t.Optional(t.String()),
    id: t.Optional(t.Union([t.String(), t.Number()])),
  })),
  project: t.Optional(t.Object({
    git_http_url: t.Optional(t.String()),
    path_with_namespace: t.Optional(t.String()),
  })),
  head_commit: t.Optional(t.Object({
    id: t.Optional(t.String()),
    message: t.Optional(t.String()),
  })),
  hook_name: t.Optional(t.String()),
  password: t.Optional(t.String()),
  before: t.Optional(t.String()),
  commits: t.Optional(t.Array(t.Object({
    id: t.Optional(t.String()),
    message: t.Optional(t.String()),
    author: t.Optional(t.Object({
      name: t.Optional(t.String()),
      email: t.Optional(t.String()),
    })),
    modified: t.Optional(t.Array(t.String())),
    added: t.Optional(t.Array(t.String())),
    removed: t.Optional(t.Array(t.String())),
  }))),
  pusher: t.Optional(t.Object({
    name: t.Optional(t.String()),
    email: t.Optional(t.String()),
  })),
}, { additionalProperties: true });

// Derive TS type from the TypeBox schema for use in `as` casts
type WebhookPayload = Static<typeof WebhookBodySchema>;


interface GitHubPushEvent {
  ref: string;
  repository: {
    full_name: string;
    clone_url: string;
    html_url: string;
  };
  after: string;
  before: string;
  commits: Array<{
    id: string;
    message: string;
    author: {
      name: string;
      email: string;
    };
  }>;
  pusher: {
    name: string;
    email: string;
  };
}

interface GitHubWebhookPayload {
  deployment_id: string;
  project_ref: string;
  secret?: string;
}

const WEBHOOK_SECRET_HEADER = "x-hub-signature-256";
const WEBHOOK_EVENT_HEADER = "x-github-event";

async function verifyGitHubSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );

  const expectedSignature = `sha256=${Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expectedSignature, "utf8");
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

export const webhookRoutes = new Elysia({ prefix: "/v1/webhooks" })
  .post(
    "/github",
    async ({ body, headers }) => {
      const event = headers[WEBHOOK_EVENT_HEADER] || headers["x-github-event"];
      const signature = headers[WEBHOOK_SECRET_HEADER] || headers["x-hub-signature-256"];

      if (event !== "push") {
        return { message: "Event ignored", event };
      }

      const payload = body as GitHubPushEvent;
      if (!payload.ref || !payload.repository?.full_name || !payload.repository?.clone_url) {
        return status(400, { message: "Invalid webhook payload", code: "400" });
      }
      const branch = payload.ref.replace("refs/heads/", "");
      const commitSha = payload.after;
      const commitMessage = payload.commits?.[0]?.message || "";
      const repoFullName = payload.repository.full_name;
      const gitUrl = payload.repository.clone_url;

      // Auto-branching: create preview branches for non-base branch pushes.
      let autoBranchResults: unknown = null;
      try {
        autoBranchResults = await processAutoBranchingFromPush(gitUrl, branch, commitSha);
      } catch (e: unknown) {
        logger.debug("[webhook/github] auto-branching check failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }

      const deployments = await findDeploymentsByGitUrl(gitUrl, branch);

      if (deployments.length === 0) {
        return {
          message: "No matching deployments found",
          repo: repoFullName,
          branch
        };
      }

      const results = [];

      for (const deployment of deployments) {
        try {
          // Verify GitHub signature using deploy tokens as secrets
          let isValidSignature = false;
          const tokens = deployment.deploy_tokens || [];
          
          if (tokens.length === 0) {
            results.push({ deployment_id: deployment.id, success: false, error: "Webhook secret is required" });
            continue;
          } else {
            const payloadStr = JSON.stringify(body);
            const safeSignature = signature || "";
            const tokenSecrets = await frontendService.getDeployTokenSecrets(
              deployment.project_ref,
              deployment.id,
            );
            for (const token of tokenSecrets) {
              if (await verifyGitHubSignature(payloadStr, safeSignature, token)) {
                isValidSignature = true;
                break;
              }
            }
          }

          if (!isValidSignature) {
             results.push({ deployment_id: deployment.id, success: false, error: "Invalid webhook signature" });
             continue;
          }

          const recordId = await frontendService.createDeploymentRecord(
            deployment.project_ref,
            deployment.id,
            {
              status: "pending",
              commit_sha: commitSha,
              commit_message: commitMessage,
              branch,
              triggered_by: "webhook",
            }
          );

          const buildResult = await frontendService.deployFromGit(
            deployment.project_ref,
            deployment.id,
            gitUrl,
            branch
          );

          await frontendService.updateDeploymentRecord(
            deployment.project_ref,
            deployment.id,
            recordId,
            {
              status: buildResult.success ? "success" : "failed",
              build_log: buildResult.build_log,
            }
          );

          results.push({
            deployment_id: deployment.id,
            project_ref: deployment.project_ref,
            success: buildResult.success,
            url: buildResult.url,
            error: buildResult.error,
          });
        } catch (error: unknown) {
          results.push({
            deployment_id: deployment.id,
            project_ref: deployment.project_ref,
            success: false,
            error: (error instanceof Error ? error.message : String(error)),
          });
        }
      }

      return {
        message: "Webhook processed",
        repo: repoFullName,
        branch,
        commit: commitSha,
        deployments: results,
        auto_branching: autoBranchResults,
      };
    },
    {
      body: WebhookBodySchema,
      detail: { tags: ["webhook"], summary: "Handle GitHub push webhook" },
    }
  )

  // ─── GitLab Webhook ───
  .post(
    "/gitlab",
    async ({ body, headers }) => {
      const event = headers["x-gitlab-event"] || "";
      if (event !== "Push Hook") return { message: "Event ignored", event };
      
      const payload = body as WebhookPayload;
      const branch = (payload.ref || "").replace("refs/heads/", "");
      const gitUrl = payload.project?.git_http_url || payload.repository?.git_http_url || "";
      const commitSha = payload.checkout_sha || payload.after || "";
      const commitMessage = payload.commits?.[0]?.message || "";
      const repoName = payload.project?.path_with_namespace || "";
      const token = headers["x-gitlab-token"];

      return await triggerDeployForGit(gitUrl, branch, commitSha, commitMessage, repoName, "gitlab", token);
    },
    { body: WebhookBodySchema, detail: { tags: ["webhook"], summary: "Handle GitLab push webhook" } }
  )

  // ─── Gitee Webhook ───
  .post(
    "/gitee",
    async ({ body, headers }) => {
      const event = headers["x-gitee-event"] || (body as WebhookPayload)?.hook_name;
      if (event !== "push_hooks" && event !== "Push Hook") return { message: "Event ignored", event };
      
      const payload = body as WebhookPayload;
      const branch = (payload.ref || "").replace("refs/heads/", "");
      const gitUrl = payload.repository?.clone_url || payload.repository?.git_http_url || "";
      const commitSha = payload.after || payload.head_commit?.id || "";
      const commitMessage = payload.head_commit?.message || payload.commits?.[0]?.message || "";
      const repoName = payload.repository?.full_name || payload.repository?.path_with_namespace || "";
      const token = headers["x-gitee-token"] || (payload.password || "");

      return await triggerDeployForGit(gitUrl, branch, commitSha, commitMessage, repoName, "gitee", token);
    },
    { body: WebhookBodySchema, detail: { tags: ["webhook"], summary: "Handle Gitee push webhook" } }
  )

  // ─── GitCode (CSDN) Webhook ───
  .post(
    "/gitcode",
    async ({ body, headers }) => {
      const event = headers["x-gitcode-event"] || headers["x-gitlab-event"] || "";
      if (event !== "Push Hook" && event !== "push") return { message: "Event ignored", event };
      
      const payload = body as WebhookPayload;
      const branch = (payload.ref || "").replace("refs/heads/", "");
      const gitUrl = payload.project?.git_http_url || payload.repository?.clone_url || "";
      const commitSha = payload.checkout_sha || payload.after || "";
      const commitMessage = payload.commits?.[0]?.message || "";
      const repoName = payload.project?.path_with_namespace || payload.repository?.full_name || "";
      const token = headers["x-gitcode-token"] || headers["x-gitlab-token"];

      return await triggerDeployForGit(gitUrl, branch, commitSha, commitMessage, repoName, "gitcode", token);
    },
    { body: WebhookBodySchema, detail: { tags: ["webhook"], summary: "Handle GitCode push webhook" } }
  )

  .post(
    "/deploy",
    async ({ body, headers }) => {
      const authHeader = headers["authorization"] || headers["Authorization"];

      if (!authHeader?.startsWith("Bearer ")) {
                return status(401, { message: "Missing or invalid authorization header", code: "401" });
      }

      const token = authHeader.replace("Bearer ", "");
      const { deployment_id, project_ref, git_url, branch, commit_sha, commit_message } = body;

      const isValid = await frontendService.verifyDeployToken(project_ref, deployment_id, token);
      if (!isValid) {
                return status(403, { message: "Invalid deploy token", code: "403" });
      }

      const deployment = await frontendService.getDeployment(project_ref, deployment_id);
      if (!deployment) {
                return status(404, { message: "Deployment not found", code: "404" });
      }

      const recordId = await frontendService.createDeploymentRecord(
        project_ref,
        deployment_id,
        {
          status: "pending",
          commit_sha,
          commit_message,
          branch,
          triggered_by: "ci",
        }
      );

      const gitUrl = git_url || deployment.git_url || "";
      const gitBranch = branch || deployment.git_branch || "main";

      const buildResult = await frontendService.deployFromGit(
        project_ref,
        deployment_id,
        gitUrl,
        gitBranch
      );

      await frontendService.updateDeploymentRecord(
        project_ref,
        deployment_id,
        recordId,
        {
          status: buildResult.success ? "success" : "failed",
          build_log: buildResult.build_log,
        }
      );

      return {
        success: buildResult.success,
        deployment_id,
        record_id: recordId,
        url: buildResult.url,
        error: buildResult.error,
      };
    },
    {
      body: t.Object({
        deployment_id: t.String(),
        project_ref: t.String(),
        git_url: t.Optional(t.String()),
        branch: t.Optional(t.String()),
        commit_sha: t.Optional(t.String()),
        commit_message: t.Optional(t.String()),
      }),
      detail: { tags: ["webhook"], summary: "Trigger deployment via API token" },
    }
  )

  .post(
    "/callback",
    async ({ body, headers }) => {
      const authHeader = headers["authorization"] || headers["Authorization"];

      if (!authHeader?.startsWith("Bearer ")) {
                return status(401, { message: "Missing or invalid authorization header", code: "401" });
      }

      const token = authHeader.replace("Bearer ", "");
      const { deployment_id, project_ref, record_id, status: deployStatus, build_log } = body;

      const isValid = await frontendService.verifyDeployToken(project_ref, deployment_id, token);
      if (!isValid) {
                return status(403, { message: "Invalid deploy token", code: "403" });
      }

      await frontendService.updateDeploymentRecord(
        project_ref,
        deployment_id,
        record_id,
        {
          status: deployStatus,
          build_log,
        }
      );

      return { message: "Callback received", record_id, status: deployStatus };
    },
    {
      body: t.Object({
        deployment_id: t.String(),
        project_ref: t.String(),
        record_id: t.String(),
        status: t.Enum({ pending: "pending", building: "building", success: "success", failed: "failed" }),
        build_log: t.Optional(t.String()),
      }),
      detail: { tags: ["webhook"], summary: "Receive deployment build callback" },
    }
  );

async function findDeploymentsByGitUrl(gitUrl: string, branch: string): Promise<FrontendDeployment[]> {
  const deployments: FrontendDeployment[] = [];

  const baseDir = "/var/supacloud/frontends";

  try {
    const result = await Bun.$`ls ${baseDir}`.quiet();
    const projects = result.text().trim().split("\n").filter(Boolean);

    for (const projectRef of projects) {
      try {
        const projectResult = await Bun.$`ls ${baseDir}/${projectRef}`.quiet();
        const deploymentIds = projectResult.text().trim().split("\n").filter(Boolean);

        for (const deploymentId of deploymentIds) {
          try {
            const configPath = `${baseDir}/${projectRef}/${deploymentId}/deployment.json`;
            const config = await Bun.file(configPath).json();

            if (config.git_url && config.git_url === gitUrl) {
              if (!config.git_branch || config.git_branch === branch) {
                deployments.push(config as FrontendDeployment);
              }
            }
          } catch (err: unknown) {
            logger.warn("[Webhook] Failed to auto-deploy after push event", { error: err });
            continue;
          }
        }
      } catch (err: unknown) {
        logger.warn("[Webhook] Failed to process GitHub webhook payload", { error: err });
        continue;
      }
    }
  } catch (e: unknown) { logger.debug("[routes/webhook] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }

  return deployments;
}

export { findDeploymentsByGitUrl };

/** Shared helper: trigger deploy for all matching projects by git URL */
async function triggerDeployForGit(
  gitUrl: string, branch: string, commitSha: string,
  commitMessage: string, repoName: string, source: string, token?: string
) {
  const deployments = await findDeploymentsByGitUrl(gitUrl, branch);
  if (deployments.length === 0) {
    return { message: "No matching deployments found", repo: repoName, branch, source };
  }
  const results = [];
  for (const deployment of deployments) {
    try {
      if (!deployment.deploy_tokens || deployment.deploy_tokens.length === 0) {
        results.push({ deployment_id: deployment.id, project_ref: deployment.project_ref, success: false, error: "Webhook secret is required" });
        continue;
      }
      if (!token) {
        results.push({ deployment_id: deployment.id, project_ref: deployment.project_ref, success: false, error: "Missing webhook token" });
        continue;
      }
      const isValid = await frontendService.verifyDeployToken(
        deployment.project_ref,
        deployment.id,
        token,
      );
      if (!isValid) {
        results.push({ deployment_id: deployment.id, project_ref: deployment.project_ref, success: false, error: "Invalid webhook token" });
        continue;
      }

      const recordId = await frontendService.createDeploymentRecord(
        deployment.project_ref, deployment.id,
        { status: "pending", commit_sha: commitSha, commit_message: commitMessage, branch, triggered_by: "webhook" }
      );
      const buildResult = await frontendService.deployFromGit(deployment.project_ref, deployment.id, gitUrl, branch);
      await frontendService.updateDeploymentRecord(
        deployment.project_ref, deployment.id, recordId,
        { status: buildResult.success ? "success" : "failed", build_log: buildResult.build_log }
      );
      results.push({ deployment_id: deployment.id, project_ref: deployment.project_ref, success: buildResult.success, url: buildResult.url, error: buildResult.error });
    } catch (error: unknown) {
      results.push({ deployment_id: deployment.id, project_ref: deployment.project_ref, success: false, error: (error instanceof Error ? error.message : String(error)) });
    }
  }
  return { message: "Webhook processed", repo: repoName, branch, commit: commitSha, source, deployments: results };
}
