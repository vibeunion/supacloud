import { Elysia, t } from "elysia";
import { frontendService } from "../services/frontend.service";

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

  return signature === expectedSignature;
}

export const webhookRoutes = new Elysia({ prefix: "/v1/webhooks" })
  .post(
    "/github",
    async ({ body, headers, set }) => {
      const event = headers[WEBHOOK_EVENT_HEADER] || headers["x-github-event"];
      const signature = headers[WEBHOOK_SECRET_HEADER] || headers["x-hub-signature-256"];

      if (event !== "push") {
        return { message: "Event ignored", event };
      }

      const payload = body as GitHubPushEvent;
      const branch = payload.ref.replace("refs/heads/", "");
      const commitSha = payload.after;
      const commitMessage = payload.commits?.[0]?.message || "";
      const repoFullName = payload.repository.full_name;
      const gitUrl = payload.repository.clone_url;

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
        } catch (error: any) {
          results.push({
            deployment_id: deployment.id,
            project_ref: deployment.project_ref,
            success: false,
            error: error.message,
          });
        }
      }

      return {
        message: "Webhook processed",
        repo: repoFullName,
        branch,
        commit: commitSha,
        deployments: results,
      };
    },
    {
      body: t.Any(),
    }
  )

  // ─── GitLab Webhook ───
  .post(
    "/gitlab",
    async ({ body, headers, set }) => {
      const event = headers["x-gitlab-event"] || "";
      if (event !== "Push Hook") {
        return { message: "Event ignored", event };
      }
      const payload = body as any;
      const branch = (payload.ref || "").replace("refs/heads/", "");
      const gitUrl = payload.project?.git_http_url || payload.repository?.git_http_url || "";
      const commitSha = payload.checkout_sha || payload.after || "";
      const commitMessage = payload.commits?.[0]?.message || "";
      const repoName = payload.project?.path_with_namespace || "";

      return await triggerDeployForGit(gitUrl, branch, commitSha, commitMessage, repoName, "gitlab");
    },
    { body: t.Any() }
  )

  // ─── Gitee Webhook ───
  .post(
    "/gitee",
    async ({ body, headers, set }) => {
      const event = headers["x-gitee-event"] || (body as any)?.hook_name;
      if (event !== "push_hooks" && event !== "Push Hook") {
        return { message: "Event ignored", event };
      }
      const payload = body as any;
      const branch = (payload.ref || "").replace("refs/heads/", "");
      const gitUrl = payload.repository?.clone_url || payload.repository?.git_http_url || "";
      const commitSha = payload.after || payload.head_commit?.id || "";
      const commitMessage = payload.head_commit?.message || payload.commits?.[0]?.message || "";
      const repoName = payload.repository?.full_name || payload.repository?.path_with_namespace || "";

      return await triggerDeployForGit(gitUrl, branch, commitSha, commitMessage, repoName, "gitee");
    },
    { body: t.Any() }
  )

  // ─── GitCode (CSDN) Webhook ───
  .post(
    "/gitcode",
    async ({ body, headers, set }) => {
      const event = headers["x-gitcode-event"] || headers["x-gitlab-event"] || "";
      // GitCode uses GitLab-compatible webhook format
      if (event !== "Push Hook" && event !== "push") {
        return { message: "Event ignored", event };
      }
      const payload = body as any;
      const branch = (payload.ref || "").replace("refs/heads/", "");
      const gitUrl = payload.project?.git_http_url || payload.repository?.clone_url || "";
      const commitSha = payload.checkout_sha || payload.after || "";
      const commitMessage = payload.commits?.[0]?.message || "";
      const repoName = payload.project?.path_with_namespace || payload.repository?.full_name || "";

      return await triggerDeployForGit(gitUrl, branch, commitSha, commitMessage, repoName, "gitcode");
    },
    { body: t.Any() }
  )

  .post(
    "/deploy",
    async ({ body, headers, set }) => {
      const authHeader = headers["authorization"] || headers["Authorization"];

      if (!authHeader?.startsWith("Bearer ")) {
        set.status = 401;
        return { error: "Missing or invalid authorization header" };
      }

      const token = authHeader.replace("Bearer ", "");
      const { deployment_id, project_ref, git_url, branch, commit_sha, commit_message } = body;

      const isValid = await frontendService.verifyDeployToken(project_ref, deployment_id, token);
      if (!isValid) {
        set.status = 403;
        return { error: "Invalid deploy token" };
      }

      const deployment = await frontendService.getDeployment(project_ref, deployment_id);
      if (!deployment) {
        set.status = 404;
        return { error: "Deployment not found" };
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
    }
  )

  .post(
    "/callback",
    async ({ body, headers, set }) => {
      const authHeader = headers["authorization"] || headers["Authorization"];

      if (!authHeader?.startsWith("Bearer ")) {
        set.status = 401;
        return { error: "Missing or invalid authorization header" };
      }

      const token = authHeader.replace("Bearer ", "");
      const { deployment_id, project_ref, record_id, status, build_log } = body;

      const isValid = await frontendService.verifyDeployToken(project_ref, deployment_id, token);
      if (!isValid) {
        set.status = 403;
        return { error: "Invalid deploy token" };
      }

      await frontendService.updateDeploymentRecord(
        project_ref,
        deployment_id,
        record_id,
        {
          status,
          build_log,
        }
      );

      return { message: "Callback received", record_id, status };
    },
    {
      body: t.Object({
        deployment_id: t.String(),
        project_ref: t.String(),
        record_id: t.String(),
        status: t.Enum({ pending: "pending", building: "building", success: "success", failed: "failed" }),
        build_log: t.Optional(t.String()),
      }),
    }
  );

async function findDeploymentsByGitUrl(gitUrl: string, branch: string): Promise<Array<{ id: string; project_ref: string; git_url?: string; git_branch?: string }>> {
  const deployments: Array<{ id: string; project_ref: string; git_url?: string; git_branch?: string }> = [];

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
                deployments.push({
                  id: deploymentId,
                  project_ref: projectRef,
                  git_url: config.git_url,
                  git_branch: config.git_branch,
                });
              }
            }
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }

  return deployments;
}

export { findDeploymentsByGitUrl };

/** Shared helper: trigger deploy for all matching projects by git URL */
async function triggerDeployForGit(
  gitUrl: string, branch: string, commitSha: string,
  commitMessage: string, repoName: string, source: string
) {
  const deployments = await findDeploymentsByGitUrl(gitUrl, branch);
  if (deployments.length === 0) {
    return { message: "No matching deployments found", repo: repoName, branch, source };
  }
  const results = [];
  for (const deployment of deployments) {
    try {
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
    } catch (error: any) {
      results.push({ deployment_id: deployment.id, project_ref: deployment.project_ref, success: false, error: error.message });
    }
  }
  return { message: "Webhook processed", repo: repoName, branch, commit: commitSha, source, deployments: results };
}
