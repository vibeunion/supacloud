/**
 * Frontend Domain & Token Service
 * Handles: custom domains, deploy tokens, env vars, git config
 * 
 * Extracted from frontend.service.ts to reduce file size.
 */
import { $ } from "bun";
import { logger } from "../utils/logger";
import type {
  FrontendDeployment,
  FrontendDeploymentConfig,
} from "../types/frontend";
import {
  FRAMEWORK_DEFAULTS,
} from "../types/frontend";

export class FrontendDomainService {
  constructor(
    private baseDir: string,
    private getDeployment: (projectRef: string, deploymentId: string) => Promise<FrontendDeployment | null>,
    private configureGatewayRoute: (deployment: FrontendDeployment, buildDir: string, isSSR: boolean) => Promise<void>,
  ) {}

  private joinPath(...parts: string[]): string {
    return parts.join("/").replace(/\/+/g, "/");
  }

  async setEnvVars(
    projectRef: string,
    deploymentId: string,
    envVars: Record<string, string>
  ): Promise<FrontendDeployment | null> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) return null;

    const updated = {
      ...deployment,
      env_vars: { ...deployment.env_vars, ...envVars },
      updated_at: new Date().toISOString(),
    };

    await Bun.write(
      this.joinPath(this.baseDir, projectRef, deploymentId, "deployment.json"),
      JSON.stringify(updated, null, 2)
    );

    return updated;
  }

  async addCustomDomain(
    projectRef: string,
    deploymentId: string,
    domain: string
  ): Promise<FrontendDeployment | null> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) return null;

    if (deployment.custom_domains.includes(domain)) {
      return deployment;
    }

    const updated = {
      ...deployment,
      custom_domains: [...deployment.custom_domains, domain],
      updated_at: new Date().toISOString(),
    };

    await Bun.write(
      this.joinPath(this.baseDir, projectRef, deploymentId, "deployment.json"),
      JSON.stringify(updated, null, 2)
    );

    const buildDir = this.joinPath(this.baseDir, projectRef, deploymentId, "build");
    const defaults = FRAMEWORK_DEFAULTS[deployment.framework];
    await this.configureGatewayRoute(updated, buildDir, defaults.is_ssr);

    return updated;
  }

  async removeCustomDomain(
    projectRef: string,
    deploymentId: string,
    domain: string
  ): Promise<FrontendDeployment | null> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) return null;

    const updated = {
      ...deployment,
      custom_domains: deployment.custom_domains.filter((d) => d !== domain),
      updated_at: new Date().toISOString(),
    };

    await Bun.write(
      this.joinPath(this.baseDir, projectRef, deploymentId, "deployment.json"),
      JSON.stringify(updated, null, 2)
    );

    const buildDir = this.joinPath(this.baseDir, projectRef, deploymentId, "build");
    const defaults = FRAMEWORK_DEFAULTS[deployment.framework];
    await this.configureGatewayRoute(updated, buildDir, defaults.is_ssr);

    return updated;
  }

  async createDeployToken(
    projectRef: string,
    deploymentId: string,
    name: string
  ): Promise<{ id: string; token: string } | null> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) return null;

    const tokenId = crypto.randomUUID().substring(0, 8);
    const token = `supa_deploy_${crypto.randomUUID().replace(/-/g, "")}`;

    const deployToken = {
      id: tokenId,
      name,
      token,
      created_at: new Date().toISOString(),
    };

    const updated = {
      ...deployment,
      deploy_tokens: [...(deployment.deploy_tokens || []), deployToken],
      updated_at: new Date().toISOString(),
    };

    await Bun.write(
      this.joinPath(this.baseDir, projectRef, deploymentId, "deployment.json"),
      JSON.stringify(updated, null, 2)
    );

    return { id: tokenId, token };
  }

  async listDeployTokens(projectRef: string, deploymentId: string): Promise<{ id: string; name: string; created_at: string; last_used_at?: string }[]> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) return [];

    return (deployment.deploy_tokens || []).map((t) => ({
      id: t.id,
      name: t.name,
      created_at: t.created_at,
      last_used_at: t.last_used_at,
    }));
  }

  async deleteDeployToken(projectRef: string, deploymentId: string, tokenId: string): Promise<boolean> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) return false;

    const updated = {
      ...deployment,
      deploy_tokens: (deployment.deploy_tokens || []).filter((t) => t.id !== tokenId),
      updated_at: new Date().toISOString(),
    };

    await Bun.write(
      this.joinPath(this.baseDir, projectRef, deploymentId, "deployment.json"),
      JSON.stringify(updated, null, 2)
    );

    return true;
  }

  async verifyDeployToken(projectRef: string, deploymentId: string, token: string): Promise<boolean> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) return false;

    const foundToken = (deployment.deploy_tokens || []).find((t) => t.token === token);
    if (!foundToken) return false;

    foundToken.last_used_at = new Date().toISOString();
    await Bun.write(
      this.joinPath(this.baseDir, projectRef, deploymentId, "deployment.json"),
      JSON.stringify(deployment, null, 2)
    );

    return true;
  }

  async setGitConfig(
    projectRef: string,
    deploymentId: string,
    gitUrl: string,
    branch: string
  ): Promise<FrontendDeployment | null> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) return null;

    const updated = {
      ...deployment,
      git_url: gitUrl,
      git_branch: branch,
      updated_at: new Date().toISOString(),
    };

    await Bun.write(
      this.joinPath(this.baseDir, projectRef, deploymentId, "deployment.json"),
      JSON.stringify(updated, null, 2)
    );

    return updated;
  }
}
