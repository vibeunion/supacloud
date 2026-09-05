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

function newDeployToken(name: string): DeployToken {
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

function sameGitTarget(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    if (b.username || b.password) return false;
    a.username = "";
    a.password = "";
    b.username = "";
    b.password = "";
    return a.toString() === b.toString();
  } catch {
    return left === right;
  }
}

export class FrontendDomainService {
  constructor(private readonly options: FrontendDomainServiceOptions) {}

  async setEnvVars(
    projectRef: string,
    deploymentId: string,
    envVars: Record<string, string>,
  ): Promise<FrontendDeployment | null> {
    return this.options.deploymentLock(projectRef, deploymentId, async () => {
      const deployment = await this.options.getDeployment(projectRef, deploymentId);
      if (!deployment) return null;
      const nextEnvVars = { ...deployment.env_vars };
      for (const [name, value] of Object.entries(envVars)) {
        if (value === MASKED_FRONTEND_VALUE && Object.prototype.hasOwnProperty.call(nextEnvVars, name)) {
          continue;
        }
        nextEnvVars[name] = value;
      }
      const updated = {
        ...deployment,
        env_vars: normalizeFrontendEnvVars(nextEnvVars),
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
  ): Promise<{ id: string; token: string } | null> {
    return this.options.deploymentLock(projectRef, deploymentId, async () => {
      const deployment = await this.options.getDeployment(projectRef, deploymentId);
      if (!deployment) return null;
      const deployToken = newDeployToken(name);
      const token = readToken(deployToken)!;
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
      return { id: deployToken.id, token };
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
    const deployment = await this.options.getDeployment(projectRef, deploymentId);
    if (!deployment) return [];
    return (deployment.deploy_tokens || []).map((deployToken) => ({
      id: deployToken.id,
      name: deployToken.name,
      created_at: deployToken.created_at,
      last_used_at: deployToken.last_used_at,
    }));
  }

  async deleteDeployToken(
    projectRef: string,
    deploymentId: string,
    tokenId: string,
  ): Promise<boolean> {
    return this.options.deploymentLock(projectRef, deploymentId, async () => {
      const deployment = await this.options.getDeployment(projectRef, deploymentId);
      if (!deployment) return false;
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
    return this.options.deploymentLock(projectRef, deploymentId, async () => {
      const deployment = await this.options.getDeployment(projectRef, deploymentId);
      if (!deployment) return false;
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
    return this.options.deploymentLock(projectRef, deploymentId, async () => {
      const deployment = await this.options.getDeployment(projectRef, deploymentId);
      if (!deployment) return null;
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
