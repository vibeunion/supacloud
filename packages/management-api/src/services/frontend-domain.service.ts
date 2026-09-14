/**
 * Frontend Domain & Token Service
 * Handles: custom domains, deploy tokens, env vars, git config
 *
 * Extracted from frontend.service.ts to reduce file size.
 */
import type {
  DeployToken,
  FrontendDeployment,
} from "../types/frontend";
import type { FrontendDeploymentLock } from "./frontend-deployment-lock";
import { decryptSecretIfNeeded, encryptSecretIfNeeded } from "../utils/secret-crypto";
import { timingSafeEqual } from "node:crypto";
import { parseFrontendTokenMetadata } from "../utils/frontend-token-record";
import { requireFrontendEnvironmentRevision } from "../utils/frontend-environment-revision";
import { assertSafeGitBranch, assertSafeGitUrl, sameGitTarget } from "../utils/frontend-git";
import {
  MASKED_FRONTEND_VALUE,
  normalizeFrontendCustomDomain,
  normalizeFrontendEnvVars,
} from "../utils/frontend-security";

interface FrontendDomainServiceOptions {
  deploymentLock: FrontendDeploymentLock;
  getDeployment: (projectRef: string, deploymentId: string) => Promise<FrontendDeployment | null>;
  writeDeployment: (deployment: FrontendDeployment) => Promise<void>;
  commitHostMutation: (
    previous: FrontendDeployment,
    updated: FrontendDeployment,
  ) => Promise<void>;
}

export interface FrontendTokenCreateReceipt {
  operation: "create_token";
  project_ref: string;
  deployment_id: string;
  name: string;
  id: string;
  token: string;
}

function newDeployToken(name: string): DeployToken & { token: string } {
  return {
    id: crypto.randomUUID().substring(0, 8),
    name,
    token: `supa_deploy_${crypto.randomUUID().replace(/-/g, "")}`,
    created_at: new Date().toISOString(),
  };
}

function readToken(candidate: DeployToken): string | null {
  if (candidate.token_encrypted) return decryptSecretIfNeeded(candidate.token_encrypted);
  return candidate.token || null;
}

function safeTokenEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.length === actualBytes.length
    && timingSafeEqual(expectedBytes, actualBytes);
}

function isTokenId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export class FrontendDomainService {
  constructor(private readonly options: FrontendDomainServiceOptions) {}

  async setEnvVars(
    projectRef: string,
    deploymentId: string,
    envVars: Record<string, string>,
    mode: "merge" | "replace" = "merge",
    expectedRevision?: string,
  ): Promise<FrontendDeployment | null> {
    if (!isTokenId(projectRef) || !isTokenId(deploymentId) || envVars === undefined
      || (mode !== "merge" && mode !== "replace")
      || mode === "replace" && expectedRevision === undefined) {
      throw new Error("Invalid frontend environment update");
    }
    const captured = normalizeFrontendEnvVars(envVars);
    return this.options.deploymentLock(projectRef, deploymentId, async () => {
      const deployment = await this.options.getDeployment(projectRef, deploymentId);
      if (!deployment) return null;
      if (deployment.project_ref !== projectRef || deployment.id !== deploymentId) {
        throw new Error("Invalid deployment identity");
      }
      if (expectedRevision !== undefined) requireFrontendEnvironmentRevision(deployment, expectedRevision);
      const existing = new Map(Object.entries(deployment.env_vars));
      const nextEnvVars = mode === "merge" ? new Map(existing) : new Map<string, string>();
      for (const [name, value] of Object.entries(captured)) {
        if (value === MASKED_FRONTEND_VALUE) {
          const previous = existing.get(name);
          if (previous !== undefined) {
            nextEnvVars.set(name, previous);
            continue;
          }
          if (mode === "replace") throw new Error("Cannot preserve a missing environment variable");
        }
        nextEnvVars.set(name, value);
      }
      const updated = {
        ...deployment,
        env_vars: normalizeFrontendEnvVars(Object.fromEntries(nextEnvVars)),
        updated_at: new Date().toISOString(),
      };
      await this.options.writeDeployment(updated);
      return updated;
    });
  }

  async addCustomDomain(
    projectRef: string,
    deploymentId: string,
    domain: string,
  ): Promise<FrontendDeployment | null> {
    return this.mutateCustomDomains(projectRef, deploymentId, (deployment) => {
      const normalized = normalizeFrontendCustomDomain(domain);
      if (deployment.custom_domains.includes(normalized)) return null;
      return [...deployment.custom_domains, normalized];
    });
  }

  async removeCustomDomain(
    projectRef: string,
    deploymentId: string,
    domain: string,
  ): Promise<FrontendDeployment | null> {
    return this.mutateCustomDomains(projectRef, deploymentId, (deployment) => {
      const normalized = normalizeFrontendCustomDomain(domain);
      if (!deployment.custom_domains.includes(normalized)) return null;
      return deployment.custom_domains.filter((candidate) => candidate !== normalized);
    });
  }

  private async mutateCustomDomains(
    projectRef: string,
    deploymentId: string,
    customDomains: (deployment: FrontendDeployment) => string[] | null,
  ): Promise<FrontendDeployment | null> {
    return this.options.deploymentLock(projectRef, deploymentId, async () => {
      const deployment = await this.options.getDeployment(projectRef, deploymentId);
      if (!deployment) return null;
      const domains = customDomains(deployment);
      if (!domains) return deployment;
      const updated = {
        ...deployment,
        custom_domains: domains,
        updated_at: new Date().toISOString(),
      };
      await this.options.commitHostMutation(deployment, updated);
      return updated;
    });
  }

  async createDeployToken(
    projectRef: string,
    deploymentId: string,
    name: string,
  ): Promise<FrontendTokenCreateReceipt | null> {
    const safeId = /^[A-Za-z0-9_-]{1,128}$/;
    if (typeof projectRef !== "string" || !safeId.test(projectRef)
      || typeof deploymentId !== "string" || !safeId.test(deploymentId)
      || typeof name !== "string" || !name.trim() || name.length > 1024
      || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error("Invalid deployment token creation input");
    }
    return this.options.deploymentLock(projectRef, deploymentId, async () => {
      const deployment = await this.options.getDeployment(projectRef, deploymentId);
      if (!deployment) return null;
      if (deployment.project_ref !== projectRef || deployment.id !== deploymentId) {
        throw new Error("Invalid deployment identity");
      }
      parseFrontendTokenMetadata(deployment, projectRef, deploymentId);
      if ((deployment.deploy_tokens?.length ?? 0) >= 5000) {
        throw new Error("Deployment token count exceeds the limit");
      }
      const deployToken = newDeployToken(name);
      if (deployment.deploy_tokens?.some(existing => existing.id === deployToken.id)) {
        throw new Error("Deployment token ID collision");
      }
      const token = deployToken.token;
      await this.options.writeDeployment({
        ...deployment,
        deploy_tokens: [
          ...(deployment.deploy_tokens || []),
          {
            id: deployToken.id,
            name: deployToken.name,
            token_encrypted: encryptSecretIfNeeded(token),
            created_at: deployToken.created_at,
          },
        ],
        updated_at: new Date().toISOString(),
      });
      return {
        operation: "create_token", project_ref: projectRef, deployment_id: deploymentId,
        name: deployToken.name, id: deployToken.id, token,
      };
    });
  }

  async getDeployTokenSecrets(
    projectRef: string,
    deploymentId: string,
  ): Promise<string[]> {
    const deployment = await this.options.getDeployment(projectRef, deploymentId);
    if (!deployment) return [];
    return (deployment.deploy_tokens || [])
      .map(readToken)
      .filter((token): token is string => Boolean(token));
  }

  async listDeployTokens(
    projectRef: string,
    deploymentId: string,
  ): Promise<{ id: string; name: string; created_at: string; last_used_at?: string }[]> {
    const safeId = /^[A-Za-z0-9_-]{1,128}$/;
    if (typeof projectRef !== "string" || !safeId.test(projectRef)
      || typeof deploymentId !== "string" || !safeId.test(deploymentId)) {
      throw new Error("Invalid deployment identity");
    }
    const deployment: unknown = await this.options.getDeployment(projectRef, deploymentId);
    if (deployment === null) return [];
    return parseFrontendTokenMetadata(deployment, projectRef, deploymentId);
  }

  async deleteDeployToken(
    projectRef: string,
    deploymentId: string,
    tokenId: string,
  ): Promise<boolean> {
    if (!isTokenId(projectRef) || !isTokenId(deploymentId) || !isTokenId(tokenId)) {
      throw new Error("Invalid deployment token deletion input");
    }
    return this.options.deploymentLock(projectRef, deploymentId, async () => {
      const deployment = await this.options.getDeployment(projectRef, deploymentId);
      if (!deployment) return false;
      parseFrontendTokenMetadata(deployment, projectRef, deploymentId);
      if (!deployment.deploy_tokens?.some((token) => token.id === tokenId)) return false;
      await this.options.writeDeployment({
        ...deployment,
        deploy_tokens: (deployment.deploy_tokens || []).filter((deployToken) => deployToken.id !== tokenId),
        updated_at: new Date().toISOString(),
      });
      return true;
    });
  }

  async verifyDeployToken(
    projectRef: string,
    deploymentId: string,
    token: string,
  ): Promise<boolean> {
    if (!isTokenId(projectRef) || !isTokenId(deploymentId)) {
      throw new Error("Invalid deployment token verification input");
    }
    if (typeof token !== "string" || token.length === 0 || token.length > 4096 || /[\u0000-\u0020\u007f]/.test(token)) {
      return false;
    }
    return this.options.deploymentLock(projectRef, deploymentId, async () => {
      const deployment = await this.options.getDeployment(projectRef, deploymentId);
      if (!deployment) return false;
      parseFrontendTokenMetadata(deployment, projectRef, deploymentId);
      const foundToken = (deployment.deploy_tokens || []).find((candidate) => {
        const candidateToken = readToken(candidate);
        return candidateToken ? safeTokenEqual(candidateToken, token) : false;
      });
      if (!foundToken) return false;
      const lastUsedAt = new Date().toISOString();
      await this.options.writeDeployment({
        ...deployment,
        deploy_tokens: (deployment.deploy_tokens || []).map((candidate) => (
          candidate.id === foundToken.id ? { ...candidate, last_used_at: lastUsedAt } : candidate
        )),
        updated_at: lastUsedAt,
      });
      return true;
    });
  }

  async setGitConfig(
    projectRef: string,
    deploymentId: string,
    gitUrl: string,
    branch: string,
  ): Promise<FrontendDeployment | null> {
    if (!isTokenId(projectRef) || !isTokenId(deploymentId)
      || typeof gitUrl !== "string" || gitUrl.length > 16_384
      || (gitUrl !== "" && !gitUrl.trim()) || /[\u0000-\u001f\u007f]/.test(gitUrl)
      || typeof branch !== "string" || !branch.trim() || branch.length > 16_384
      || /[\u0000-\u001f\u007f]/.test(branch)) {
      throw new Error("Invalid frontend Git configuration");
    }
    try {
      if (gitUrl !== "") assertSafeGitUrl(gitUrl);
      assertSafeGitBranch(branch);
    } catch {
      throw new Error("Invalid frontend Git configuration");
    }
    return this.options.deploymentLock(projectRef, deploymentId, async () => {
      const deployment = await this.options.getDeployment(projectRef, deploymentId);
      if (!deployment) return null;
      if (deployment.project_ref !== projectRef || deployment.id !== deploymentId) {
        throw new Error("Invalid deployment identity");
      }
      const updated = {
        ...deployment,
        git_url: deployment.git_url && sameGitTarget(deployment.git_url, gitUrl)
          ? deployment.git_url
          : gitUrl,
        git_branch: branch,
        updated_at: new Date().toISOString(),
      };
      await this.options.writeDeployment(updated);
      return updated;
    });
  }
}
