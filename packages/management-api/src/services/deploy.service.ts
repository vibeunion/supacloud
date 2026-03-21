import { $ } from "bun";
import path from "path";
import { logger } from "../utils/logger";
import { sql } from "../db";

export interface StaticDeployConfig {
  name: string;
  source: string;
  target: string;
  url?: string;
}

export interface SSRDeployConfig {
  name: string;
  source: string;
  target: string;
  service: string;
  url?: string;
  env?: Record<string, string>;
}

export interface DeployConfig {
  app: string;
  tenant: string;
  static?: StaticDeployConfig[];
  ssr?: SSRDeployConfig[];
  hooks?: {
    pre_deploy?: string;
    post_deploy?: string;
    on_failure?: string;
  };
  retention?: {
    keep_versions?: number;
    auto_cleanup?: boolean;
  };
}

export interface HooksConfig {
  pre_deploy?: string;
  post_deploy?: string;
  on_failure?: string;
}

export interface RetentionConfig {
  keep_versions?: number;
  auto_cleanup?: boolean;
}

export interface DeployRequest {
  app: string;
  tenant: string;
  artifact: string;
  config: DeployConfig;
}

export interface DeployResult {
  success: boolean;
  deploymentId: string;
  versions: {
    current: string;
    previous: string | null;
  };
  urls: string[];
  rollbackCommand: string;
  logs: string[];
}

export interface DeploymentHistory {
  id: string;
  appId: string;
  tenant: string;
  version: string;
  status: "success" | "failed" | "rolled_back";
  deployedAt: Date;
  triggeredBy: string;
  config: DeployConfig;
}

const DEPLOY_BASE_DIR = "/var/supacloud/deployments";

class DeployServiceClass {
  private initialized = false;

  async initialize(): Promise<void> {
    try {
      await $`mkdir -p ${DEPLOY_BASE_DIR}`;
      // Ensure deployment_history table exists
      await sql`
        CREATE TABLE IF NOT EXISTS deployment_history (
          id TEXT PRIMARY KEY,
          app TEXT NOT NULL,
          tenant TEXT NOT NULL,
          version TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'success',
          deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          triggered_by TEXT NOT NULL DEFAULT 'api',
          config JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      this.initialized = true;
    } catch (error: unknown) {
      logger.error("Failed to initialize deploy service", { error });
    }
  }

  private async addHistory(entry: DeploymentHistory): Promise<void> {
    await sql`
      INSERT INTO deployment_history (id, app, tenant, version, status, deployed_at, triggered_by, config)
      VALUES (${entry.id}, ${entry.appId}, ${entry.tenant}, ${entry.version}, ${entry.status}, ${entry.deployedAt}, ${entry.triggeredBy}, ${JSON.stringify(entry.config)})
    `;
  }

  private rowToHistory(r: Record<string, unknown>): DeploymentHistory {
    return {
      id: r.id as string,
      appId: r.app as string,
      tenant: r.tenant as string,
      version: r.version as string,
      status: r.status as "success" | "failed" | "rolled_back",
      deployedAt: new Date(r.deployed_at as string),
      triggeredBy: r.triggered_by as string,
      config: r.config as DeployConfig,
    };
  }

  async deploy(request: DeployRequest, triggeredBy: string = "api"): Promise<DeployResult> {
    const deploymentId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const logs: string[] = [];
    const startTime = Date.now();

    const log = (message: string) => {
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] ${message}`;
      logs.push(logLine);
      logger.info(`[Deploy:${deploymentId}] ${message}`);
    };

    try {
      log(`Starting deployment for app: ${request.app}, tenant: ${request.tenant}`);

      const artifactBuffer = Buffer.from(request.artifact, "base64");
      const tempDir = `/tmp/deploy_${deploymentId}`;
      const artifactPath = `${tempDir}/artifact.tar.xz`;

      await $`mkdir -p ${tempDir}`;
      await Bun.write(artifactPath, artifactBuffer);
      log("Artifact saved to temp directory");

      await $`tar -xf ${artifactPath} -C ${tempDir}`;
      log("Artifact extracted");

      if (request.config.hooks?.pre_deploy) {
        log(`Running pre_deploy hook: ${request.config.hooks.pre_deploy}`);
        await this.executeHook(request.config.hooks.pre_deploy, tempDir);
      }

      const versions: { current: string; previous: string | null } = {
        current: "",
        previous: null,
      };
      const urls: string[] = [];

      if (request.config.static) {
        for (const staticConfig of request.config.static) {
          const result = await this.deployStatic(staticConfig, tempDir, log);
          if (!versions.current) versions.current = result.version;
          if (result.previousVersion) versions.previous = result.previousVersion;
          if (staticConfig.url) urls.push(staticConfig.url);
        }
      }

      if (request.config.ssr) {
        for (const ssrConfig of request.config.ssr) {
          const result = await this.deploySSR(ssrConfig, tempDir, log);
          if (!versions.current) versions.current = result.version;
          if (result.previousVersion) versions.previous = result.previousVersion;
          if (ssrConfig.url) urls.push(ssrConfig.url);
        }
      }

      if (request.config.hooks?.post_deploy) {
        log(`Running post_deploy hook: ${request.config.hooks.post_deploy}`);
        await this.executeHook(request.config.hooks.post_deploy, tempDir);
      }

      const keepVersions = request.config.retention?.keep_versions ?? 5;
      await this.cleanup(request.app, keepVersions, log);

      await $`rm -rf ${tempDir}`;

      const deployment: DeploymentHistory = {
        id: deploymentId,
        appId: request.app,
        tenant: request.tenant,
        version: versions.current,
        status: "success",
        deployedAt: new Date(),
        triggeredBy,
        config: request.config,
      };
      await this.addHistory(deployment);

      const duration = Date.now() - startTime;
      log(`Deployment completed successfully in ${duration}ms`);

      return {
        success: true,
        deploymentId,
        versions,
        urls,
        rollbackCommand: `supacloud rollback --app ${request.app} --version ${versions.previous}`,
        logs,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`Deployment failed: ${errorMessage}`);

      if (request.config.hooks?.on_failure) {
        log(`Running on_failure hook: ${request.config.hooks.on_failure}`);
        try {
          await this.executeHook(request.config.hooks.on_failure, "");
        } catch (hookError: unknown) {
          log(`Hook failed: ${hookError}`);
        }
      }

      const deployment: DeploymentHistory = {
        id: deploymentId,
        appId: request.app,
        tenant: request.tenant,
        version: "",
        status: "failed",
        deployedAt: new Date(),
        triggeredBy,
        config: request.config,
      };
      await this.addHistory(deployment);

      return {
        success: false,
        deploymentId,
        versions: { current: "", previous: null },
        urls: [],
        rollbackCommand: "",
        logs,
      };
    }
  }

  private async deployStatic(
    config: StaticDeployConfig,
    tempDir: string,
    log: (msg: string) => void
  ): Promise<{ version: string; previousVersion: string | null }> {
    const timestamp = this.getTimestamp();
    const version = timestamp;
    const targetBase = path.dirname(config.target);
    const appName = path.basename(config.target);
    const newDir = `${targetBase}/${appName}_${version}`;
    const symlinkPath = config.target;

    log(`Deploying static app: ${config.name}`);
    log(`Target: ${config.target}`);
    log(`New version directory: ${newDir}`);

    const sourceDir = path.join(tempDir, config.source);
    await $`mkdir -p ${newDir}`;

    const stdout = await $`ls -la "${sourceDir}"`.text();
    log(`Source contents: ${stdout}`);

    await $`cp -r "${sourceDir}/"* "${newDir}/"`;
    log(`Files copied to ${newDir}`);

    let previousVersion: string | null = null;
    try {
      const linkTarget = await $`readlink -f ${symlinkPath}`.text();
      const match = linkTarget.trim().match(new RegExp(`${appName}_(.+)$`));
      if (match) {
        previousVersion = match[1];
        log(`Previous version: ${previousVersion}`);
      }
    } catch (err: unknown) {
      logger.warn("[] trim failed silently", { error: err });
      log("No previous version found");
    }

    await $`ln -sfn "${newDir}" "${symlinkPath}"`;
    log(`Symlink updated: ${symlinkPath} -> ${newDir}`);

    return { version, previousVersion };
  }

  private async deploySSR(
    config: SSRDeployConfig,
    tempDir: string,
    log: (msg: string) => void
  ): Promise<{ version: string; previousVersion: string | null }> {
    const timestamp = this.getTimestamp();
    const version = timestamp;
    const targetBase = path.dirname(config.target);
    const appName = path.basename(config.target);
    const newDir = `${targetBase}/${appName}_${version}`;
    const symlinkPath = config.target;

    log(`Deploying SSR app: ${config.name}`);
    log(`Target: ${config.target}`);
    log(`Service: ${config.service}`);
    log(`New version directory: ${newDir}`);

    const sourceDir = path.join(tempDir, config.source);
    await $`mkdir -p ${newDir}`;

    await $`cp -r "${sourceDir}/"* "${newDir}/"`;
    log(`Files copied to ${newDir}`);

    let previousVersion: string | null = null;
    try {
      const linkTarget = await $`readlink -f ${symlinkPath}`.text();
      const match = linkTarget.trim().match(new RegExp(`${appName}_(.+)$`));
      if (match) {
        previousVersion = match[1];
        log(`Previous version: ${previousVersion}`);
      }
    } catch (err: unknown) {
      logger.warn("[] trim failed silently", { error: err });
      log("No previous version found");
    }

    await $`ln -sfn "${newDir}" "${symlinkPath}"`;
    log(`Symlink updated: ${symlinkPath} -> ${newDir}`);

    if (config.env) {
      const envFile = path.join(newDir, ".env");
      const envContent = Object.entries(config.env)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
      await Bun.write(envFile, envContent);
      log(`Environment file written to ${envFile}`);
    }

    log(`Restarting service: ${config.service}`);
    await $`systemctl restart ${config.service}`;
    log(`Service ${config.service} restarted`);

    return { version, previousVersion };
  }

  private async executeHook(command: string, cwd: string): Promise<void> {
    await $`cd ${cwd} && ${command}`;
  }

  private getTimestamp(): string {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  }

  async rollback(app: string, version?: string): Promise<DeployResult> {
    const deploymentId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const logs: string[] = [];

    const log = (message: string) => {
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] ${message}`;
      logs.push(logLine);
      logger.info(`[Rollback:${deploymentId}] ${message}`);
    };

    try {
      log(`Starting rollback for app: ${app}`);

      const appRows = await sql`
        SELECT id, app, tenant, version, status, deployed_at, triggered_by, config
        FROM deployment_history
        WHERE app = ${app} AND status = 'success'
        ORDER BY deployed_at DESC
      `;
      const appDeployments = appRows.map((r: Record<string, unknown>) => this.rowToHistory(r));

      if (appDeployments.length === 0) {
        throw new Error(`No successful deployments found for app: ${app}`);
      }

      let targetDeployment: DeploymentHistory | undefined;

      if (version) {
        targetDeployment = appDeployments.find((d: DeploymentHistory) => d.version === version);
        if (!targetDeployment) {
          throw new Error(`Version ${version} not found for app: ${app}`);
        }
      } else {
        targetDeployment = appDeployments[1];
        if (!targetDeployment) {
          throw new Error("No previous version available for rollback");
        }
      }

      log(`Rolling back to version: ${targetDeployment.version}`);

      const config = targetDeployment.config;

      if (config.static) {
        for (const staticConfig of config.static) {
          const targetBase = path.dirname(staticConfig.target);
          const appName = path.basename(staticConfig.target);
          const versionDir = `${targetBase}/${appName}_${targetDeployment.version}`;

          await $`ln -sfn "${versionDir}" "${staticConfig.target}"`;
          log(`Symlink updated: ${staticConfig.target} -> ${versionDir}`);
        }
      }

      if (config.ssr) {
        for (const ssrConfig of config.ssr) {
          const targetBase = path.dirname(ssrConfig.target);
          const appName = path.basename(ssrConfig.target);
          const versionDir = `${targetBase}/${appName}_${targetDeployment.version}`;

          await $`ln -sfn "${versionDir}" "${ssrConfig.target}"`;
          log(`Symlink updated: ${ssrConfig.target} -> ${versionDir}`);

          await $`systemctl restart ${ssrConfig.service}`;
          log(`Service ${ssrConfig.service} restarted`);
        }
      }

      const rollbackDeployment: DeploymentHistory = {
        id: deploymentId,
        appId: app,
        tenant: targetDeployment.tenant,
        version: targetDeployment.version,
        status: "rolled_back",
        deployedAt: new Date(),
        triggeredBy: "rollback",
        config: targetDeployment.config,
      };
      await this.addHistory(rollbackDeployment);

      return {
        success: true,
        deploymentId,
        versions: {
          current: targetDeployment.version,
          previous: null,
        },
        urls: [],
        rollbackCommand: "",
        logs,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`Rollback failed: ${errorMessage}`);

      return {
        success: false,
        deploymentId,
        versions: { current: "", previous: null },
        urls: [],
        rollbackCommand: "",
        logs,
      };
    }
  }

  async getHistory(app?: string, limit: number = 20): Promise<DeploymentHistory[]> {
    const rows = app
      ? await sql`SELECT id, app, tenant, version, status, deployed_at, triggered_by, config FROM deployment_history WHERE app = ${app} ORDER BY deployed_at DESC LIMIT ${limit}`
      : await sql`SELECT id, app, tenant, version, status, deployed_at, triggered_by, config FROM deployment_history ORDER BY deployed_at DESC LIMIT ${limit}`;
    return rows.map((r: Record<string, unknown>) => this.rowToHistory(r));
  }

  async getVersions(app: string): Promise<{ version: string; deployedAt: Date; status: string }[]> {
    const rows = await sql`
      SELECT version, deployed_at, status FROM deployment_history
      WHERE app = ${app} AND status = 'success'
      ORDER BY deployed_at DESC
    `;
    return rows.map((r: Record<string, unknown>) => ({
      version: r.version as string,
      deployedAt: new Date(r.deployed_at as string),
      status: r.status as string,
    }));
  }

  private async cleanup(app: string, keepVersions: number, log: (msg: string) => void): Promise<void> {
    log(`Cleaning up old versions, keeping ${keepVersions} versions`);

    const versions = await this.getVersions(app);
    const versionsToRemove = versions.slice(keepVersions);

    for (const v of versionsToRemove) {
      const [depRow] = await sql`SELECT id, app, tenant, version, status, deployed_at, triggered_by, config FROM deployment_history WHERE app = ${app} AND version = ${v.version} LIMIT 1`;
      const deployment = depRow ? this.rowToHistory(depRow as Record<string, unknown>) : undefined;
      if (!deployment) continue;

      if (deployment.config.static) {
        for (const staticConfig of deployment.config.static) {
          const targetBase = path.dirname(staticConfig.target);
          const appName = path.basename(staticConfig.target);
          const versionDir = `${targetBase}/${appName}_${v.version}`;

          try {
            await $`rm -rf ${versionDir}`;
            log(`Removed old version directory: ${versionDir}`);
          } catch (error: unknown) {
            log(`Failed to remove ${versionDir}: ${error}`);
          }
        }
      }

      if (deployment.config.ssr) {
        for (const ssrConfig of deployment.config.ssr) {
          const targetBase = path.dirname(ssrConfig.target);
          const appName = path.basename(ssrConfig.target);
          const versionDir = `${targetBase}/${appName}_${v.version}`;

          try {
            await $`rm -rf ${versionDir}`;
            log(`Removed old version directory: ${versionDir}`);
          } catch (error: unknown) {
            log(`Failed to remove ${versionDir}: ${error}`);
          }
        }
      }
    }
  }
}

export const deployService = new DeployServiceClass();
export { DeployServiceClass };
