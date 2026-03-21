import { $ } from "bun";
import { logger } from "../utils/logger";
import type {
  FrontendDeployment,
  FrontendDeploymentConfig,
  FrontendFramework,
  FrontendBuildResult,
  DeploymentRecord,
} from "../types/frontend";
import {
  FRAMEWORK_DEFAULTS,
} from "../types/frontend";

const FRONTEND_BASE_DIR = "/var/supacloud/frontends";
const ANGIE_SITES_DIR = "/etc/angie/http.d";

class FrontendService {
  private baseDir: string;

  constructor(baseDir: string = FRONTEND_BASE_DIR) {
    this.baseDir = baseDir;
  }

  private joinPath(...parts: string[]): string {
    return parts.join("/").replace(/\/+/g, "/");
  }

  private generateId(): string {
    return crypto.randomUUID().substring(0, 8);
  }

  async listDeployments(projectRef: string): Promise<FrontendDeployment[]> {
    const deploymentsDir = this.joinPath(this.baseDir, projectRef);
    const deployments: FrontendDeployment[] = [];

    try {
      const dir = Bun.file(deploymentsDir);
      if (!(await dir.exists())) return [];

      const dirs = (await $`ls ${deploymentsDir}`.quiet()).text().trim().split("\n").filter(Boolean);
      
      for (const name of dirs) {
        const configPath = this.joinPath(deploymentsDir, name, "deployment.json");
        try {
          const config = await Bun.file(configPath).json();
          deployments.push(config);
        } catch (err: unknown) {
          logger.warn("[FrontendService] Failed to read deployment config", { error: err });
          continue;
        }
      }
    } catch (err: unknown) {
      logger.warn("[FrontendService] Failed to list deployment directories", { error: err });
      return [];
    }

    return deployments;
  }

  async getDeployment(projectRef: string, deploymentId: string): Promise<FrontendDeployment | null> {
    const configPath = this.joinPath(this.baseDir, projectRef, deploymentId, "deployment.json");
    try {
      return await Bun.file(configPath).json();
    } catch (err: unknown) {
      logger.warn("[FrontendService] Failed to read deployment JSON", { error: err });
      return null;
    }
  }

  async createDeployment(projectRef: string, config: FrontendDeploymentConfig): Promise<FrontendDeployment> {
    const deploymentId = this.generateId();
    const defaults = FRAMEWORK_DEFAULTS[config.framework];
    const domain = config.domain || `${deploymentId}.${projectRef}.app`;

    const deployment: FrontendDeployment = {
      id: deploymentId,
      project_ref: projectRef,
      name: config.name,
      framework: config.framework,
      domain,
      custom_domains: config.custom_domains || [],
      build_command: config.build_command || defaults.build_command,
      output_dir: config.output_dir || defaults.output_dir,
      install_command: config.install_command || defaults.install_command,
      node_version: config.node_version || defaults.node_version,
      env_vars: config.env_vars || {},
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deployment_url: `https://${domain}`,
    };

    const deploymentDir = this.joinPath(this.baseDir, projectRef, deploymentId);
    await $`mkdir -p ${deploymentDir}/source ${deploymentDir}/build`.quiet();

    await Bun.write(
      this.joinPath(deploymentDir, "deployment.json"),
      JSON.stringify(deployment, null, 2)
    );

    return deployment;
  }

  async updateDeployment(
    projectRef: string,
    deploymentId: string,
    updates: Partial<FrontendDeploymentConfig>
  ): Promise<FrontendDeployment | null> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) return null;

    const updated = {
      ...deployment,
      ...updates,
      updated_at: new Date().toISOString(),
    };

    await Bun.write(
      this.joinPath(this.baseDir, projectRef, deploymentId, "deployment.json"),
      JSON.stringify(updated, null, 2)
    );

    return updated;
  }

  async deleteDeployment(projectRef: string, deploymentId: string): Promise<boolean> {
    const deploymentDir = this.joinPath(this.baseDir, projectRef, deploymentId);

    try {
      const deployment = await this.getDeployment(projectRef, deploymentId);
      if (deployment) {
        const defaults = FRAMEWORK_DEFAULTS[deployment.framework];
        if (defaults.is_ssr) {
          await this.stopSSRProcess(projectRef, deploymentId);
        }
        await this.removeAngieConfig(deployment);
      }
      await $`rm -rf ${deploymentDir}`.quiet();
      return true;
    } catch (err: unknown) {
      logger.warn("[FrontendService] Failed to remove Angie config for deployment", { error: err });
      return false;
    }
  }

  async deployFromSource(
    projectRef: string,
    deploymentId: string,
    sourcePath: string
  ): Promise<FrontendBuildResult> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) {
      return {
        success: false,
        deployment_id: deploymentId,
        url: "",
        build_log: "",
        error: "Deployment not found",
      };
    }

    const deploymentDir = this.joinPath(this.baseDir, projectRef, deploymentId);
    const sourceDir = this.joinPath(deploymentDir, "source");

    try {
      // Copy source to deployment directory, then delegate to shared build pipeline
      await $`cp -r ${sourcePath}/. ${sourceDir}`.quiet();
      return await this.buildDeployment(projectRef, deploymentId, sourceDir);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.updateDeployment(projectRef, deploymentId, {
        status: "failed",
        build_log: `Error copying source: ${errorMsg}`,
      } as Partial<FrontendDeployment>);

      return {
        success: false,
        deployment_id: deploymentId,
        url: "",
        build_log: `Error: ${errorMsg}`,
        error: errorMsg,
      };
    }
  }

  async deployFromGit(
    projectRef: string,
    deploymentId: string,
    gitUrl: string,
    branch: string = "main"
  ): Promise<FrontendBuildResult> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) {
      return {
        success: false,
        deployment_id: deploymentId,
        url: "",
        build_log: "",
        error: "Deployment not found",
      };
    }

    const deploymentDir = this.joinPath(this.baseDir, projectRef, deploymentId);
    const sourceDir = this.joinPath(deploymentDir, "source");
    let buildLog = "";

    try {
      await $`rm -rf ${sourceDir}`.quiet();

      buildLog += `$ git clone --branch ${branch} ${gitUrl}\n`;
      const cloneResult = await $`git clone --branch ${branch} --depth 1 ${gitUrl} ${sourceDir}`.quiet();
      buildLog += cloneResult.stdout.toString() + "\n";

      if (cloneResult.exitCode !== 0) {
        throw new Error(`Git clone failed: ${cloneResult.stderr.toString()}`);
      }

      return await this.buildDeployment(projectRef, deploymentId, sourceDir);
    } catch (error: unknown) {
      buildLog += `\nError: ${error instanceof Error ? error.message : String(error)}\n`;
      await this.updateDeployment(projectRef, deploymentId, {
        status: "failed",
        build_log: buildLog,
      } as Partial<FrontendDeployment>);

      return {
        success: false,
        deployment_id: deploymentId,
        url: "",
        build_log: buildLog,
        error: (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  private async buildDeployment(
    projectRef: string,
    deploymentId: string,
    sourceDir: string
  ): Promise<FrontendBuildResult> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) {
      return {
        success: false,
        deployment_id: deploymentId,
        url: "",
        build_log: "",
        error: "Deployment not found",
      };
    }

    const deploymentDir = this.joinPath(this.baseDir, projectRef, deploymentId);
    const buildDir = this.joinPath(deploymentDir, "build");
    let buildLog = "";

    await this.updateDeployment(projectRef, deploymentId, { status: "building" } as Partial<FrontendDeployment>);

    try {
      if (deployment.install_command) {
        buildLog += `$ ${deployment.install_command}\n`;
        const installResult = await $`${deployment.install_command}`
          .cwd(sourceDir)
          .env({
            ...process.env,
            ...deployment.env_vars,
            NODE_VERSION: deployment.node_version,
          })
          .quiet();
        buildLog += installResult.stdout.toString() + "\n";
        if (installResult.exitCode !== 0) {
          throw new Error(`Install failed: ${installResult.stderr.toString()}`);
        }
      }

      if (deployment.build_command) {
        buildLog += `$ ${deployment.build_command}\n`;
        const buildResult = await $`${deployment.build_command}`
          .cwd(sourceDir)
          .env({
            ...process.env,
            ...deployment.env_vars,
            NODE_VERSION: deployment.node_version,
          })
          .quiet();
        buildLog += buildResult.stdout.toString() + "\n";
        if (buildResult.exitCode !== 0) {
          throw new Error(`Build failed: ${buildResult.stderr.toString()}`);
        }
      }

      const defaults = FRAMEWORK_DEFAULTS[deployment.framework];
      const outputDir = this.joinPath(sourceDir, deployment.output_dir);
      await $`rm -rf ${buildDir} && cp -r ${outputDir} ${buildDir}`.quiet();

      if (defaults.is_ssr) {
        await this.startSSRProcess(projectRef, deploymentId, deployment, buildDir);
      }
      await this.configureAngie(deployment, buildDir, defaults.is_ssr);

      await this.updateDeployment(projectRef, deploymentId, {
        status: "success",
        last_deployed_at: new Date().toISOString(),
        build_log: buildLog,
      } as Partial<FrontendDeployment>);

      return {
        success: true,
        deployment_id: deploymentId,
        url: deployment.deployment_url,
        build_log: buildLog,
      };
    } catch (error: unknown) {
      buildLog += `\nError: ${error instanceof Error ? error.message : String(error)}\n`;
      await this.updateDeployment(projectRef, deploymentId, {
        status: "failed",
        build_log: buildLog,
      } as Partial<FrontendDeployment>);

      return {
        success: false,
        deployment_id: deploymentId,
        url: "",
        build_log: buildLog,
        error: (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  private async configureAngie(deployment: FrontendDeployment, buildDir: string, isSSR: boolean): Promise<void> {
    const port = 30000 + parseInt(deployment.id, 16) % 10000;
    
    let angieConfig: string;
    
    if (isSSR) {
      angieConfig = `# SSR Frontend: ${deployment.name}
server {
    listen 80;
    listen 443 ssl;
    server_name ${deployment.domain} ${deployment.custom_domains.join(" ")};

    # ACME automatic certificate (ECC/ECDSA P-256)
    acme le;
    ssl_certificate     $acme_cert_le;
    ssl_certificate_key $acme_cert_key_le;

    location /.well-known/acme-challenge/ {
        root /var/lib/angie/acme;
    }

    if ($scheme = http) {
        return 301 https://$host$request_uri;
    }

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
    } else {
      angieConfig = `# Static Frontend: ${deployment.name}
server {
    listen 80;
    listen 443 ssl;
    server_name ${deployment.domain} ${deployment.custom_domains.join(" ")};

    # ACME automatic certificate (ECC/ECDSA P-256)
    acme le;
    ssl_certificate     $acme_cert_le;
    ssl_certificate_key $acme_cert_key_le;

    location /.well-known/acme-challenge/ {
        root /var/lib/angie/acme;
    }

    if ($scheme = http) {
        return 301 https://$host$request_uri;
    }

    root ${buildDir};
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript;
}
`;
    }

    const configPath = this.joinPath(ANGIE_SITES_DIR, `frontend-${deployment.project_ref}-${deployment.id}.conf`);
    await Bun.write(configPath, angieConfig);

    await $`angie -s reload`.nothrow().quiet();
  }

  private async removeAngieConfig(deployment: FrontendDeployment): Promise<void> {
    const configPath = this.joinPath(ANGIE_SITES_DIR, `frontend-${deployment.project_ref}-${deployment.id}.conf`);

    try {
      await $`rm -f ${configPath}`.quiet();
      await $`angie -s reload`.nothrow().quiet();
    } catch (e: unknown) { logger.debug("[services/frontend.service] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }
  }

  private async startSSRProcess(
    projectRef: string,
    deploymentId: string,
    deployment: FrontendDeployment,
    buildDir: string
  ): Promise<void> {
    const port = 30000 + parseInt(deploymentId, 16) % 10000;
    const serviceName = `supacloud-frontend-${projectRef}-${deploymentId}`;

    const envFile = this.joinPath(this.baseDir, projectRef, deploymentId, ".env");
    const envContent = Object.entries(deployment.env_vars)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    await Bun.write(envFile, envContent);

    const bunPath = process.env.BUN_PATH || "/usr/local/bin/bun";
    const systemdService = `[Unit]
Description=SupaCloud Frontend: ${deployment.name} (${projectRef}/${deploymentId})
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${buildDir}
Environment="PORT=${port}"
Environment="NODE_ENV=production"
EnvironmentFile=${envFile}
ExecStart=${bunPath} run ${buildDir}/index.js
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;

    const servicePath = `/etc/systemd/system/${serviceName}.service`;
    await Bun.write(servicePath, systemdService);

    await $`systemctl daemon-reload`.quiet();
    await $`systemctl enable ${serviceName}`.quiet();
    await $`systemctl restart ${serviceName}`.quiet();
  }

  private async stopSSRProcess(projectRef: string, deploymentId: string): Promise<void> {
    const serviceName = `supacloud-frontend-${projectRef}-${deploymentId}`;
    
    await $`systemctl stop ${serviceName}`.nothrow().quiet();
    await $`systemctl disable ${serviceName}`.nothrow().quiet();
    await $`rm -f /etc/systemd/system/${serviceName}.service`.quiet();
    await $`systemctl daemon-reload`.quiet();
  }

  async getBuildLog(projectRef: string, deploymentId: string): Promise<string> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    return deployment?.build_log || "";
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
    await this.configureAngie(updated, buildDir, defaults.is_ssr);

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
    await this.configureAngie(updated, buildDir, defaults.is_ssr);

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

  async createDeploymentRecord(
    projectRef: string,
    deploymentId: string,
    record: Partial<DeploymentRecord>
  ): Promise<string> {
    const recordId = crypto.randomUUID().substring(0, 8);
    const recordPath = this.joinPath(
      this.baseDir,
      projectRef,
      deploymentId,
      "records",
      `${recordId}.json`
    );

    await $`mkdir -p ${this.joinPath(this.baseDir, projectRef, deploymentId, "records")}`.quiet();

    const fullRecord = {
      id: recordId,
      deployment_id: deploymentId,
      project_ref: projectRef,
      status: record.status || "pending",
      commit_sha: record.commit_sha,
      commit_message: record.commit_message,
      branch: record.branch,
      triggered_by: record.triggered_by || "manual",
      build_log: record.build_log,
      started_at: new Date().toISOString(),
    };

    await Bun.write(recordPath, JSON.stringify(fullRecord, null, 2));

    return recordId;
  }

  async updateDeploymentRecord(
    projectRef: string,
    deploymentId: string,
    recordId: string,
    updates: Partial<DeploymentRecord>
  ): Promise<void> {
    const recordPath = this.joinPath(
      this.baseDir,
      projectRef,
      deploymentId,
      "records",
      `${recordId}.json`
    );

    try {
      const record = await Bun.file(recordPath).json();
      const updated = {
        ...record,
        ...updates,
        finished_at: updates.status === "success" || updates.status === "failed" 
          ? new Date().toISOString() 
          : undefined,
        duration: updates.status === "success" || updates.status === "failed"
          ? Date.now() - new Date(record.started_at).getTime()
          : undefined,
      };

      await Bun.write(recordPath, JSON.stringify(updated, null, 2));
    } catch (e: unknown) { logger.debug("[services/frontend.service] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }
  }

  async listDeploymentRecords(
    projectRef: string,
    deploymentId: string
  ): Promise<DeploymentRecord[]> {
    const recordsDir = this.joinPath(this.baseDir, projectRef, deploymentId, "records");
    const records: DeploymentRecord[] = [];

    try {
      const result = await $`ls ${recordsDir}`.quiet();
      const files = result.text().trim().split("\n").filter(Boolean);

      for (const file of files) {
        try {
          const record = await Bun.file(this.joinPath(recordsDir, file)).json();
          records.push(record);
        } catch (err: unknown) {
          logger.warn("[FrontendService] Failed to read version deployment.json", { error: err });
          continue;
        }
      }

      return records.sort((a, b) => 
        new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
      );
    } catch (err: unknown) {
      logger.warn("[FrontendService] Failed to list version directories", { error: err });
      return [];
    }
  }

  async getDeploymentRecord(
    projectRef: string,
    deploymentId: string,
    recordId: string
  ): Promise<DeploymentRecord | null> {
    const recordPath = this.joinPath(
      this.baseDir,
      projectRef,
      deploymentId,
      "records",
      `${recordId}.json`
    );

    try {
      return await Bun.file(recordPath).json();
    } catch (err: unknown) {
      logger.warn("[FrontendService] Failed to read deployment record file", { error: err });
      return null;
    }
  }
}

export const frontendService = new FrontendService();
