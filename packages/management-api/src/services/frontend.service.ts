/**
 * Frontend Service — Core deployment lifecycle
 * 
 * Delegates to:
 * - FrontendDomainService — custom domains, deploy tokens, env vars, git config
 * - FrontendRecordService — deployment records (history/audit trail)
 *
 * This file handles: CRUD, build, Angie config, SSR process management
 */
import { $ } from "bun";
import { logger } from "../utils/logger";
import { config } from "../config";
import type {
  FrontendDeployment,
  FrontendDeploymentConfig,
  FrontendBuildResult,
  DeploymentRecord,
} from "../types/frontend";
import {
  FRAMEWORK_DEFAULTS,
} from "../types/frontend";
import { FrontendDomainService } from "./frontend-domain.service";
import { FrontendRecordService } from "./frontend-record.service";

const FRONTEND_BASE_DIR = "/var/supacloud/frontends";
const ANGIE_SITES_DIR = "/etc/angie/http.d";

class FrontendService {
  private baseDir: string;
  private domainService: FrontendDomainService;
  private recordService: FrontendRecordService;

  constructor(baseDir: string = FRONTEND_BASE_DIR) {
    this.baseDir = baseDir;
    this.domainService = new FrontendDomainService(
      baseDir,
      this.getDeployment.bind(this),
      this.configureAngie.bind(this),
    );
    this.recordService = new FrontendRecordService(baseDir);
  }

  private joinPath(...parts: string[]): string {
    return parts.join("/").replace(/\/+/g, "/");
  }

  private generateId(): string {
    return crypto.randomUUID().substring(0, 8);
  }

  // ── CRUD ──────────────────────────────────────────────────────────

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
          const cfg = await Bun.file(configPath).json();
          deployments.push(cfg);
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

  async createDeployment(projectRef: string, deploymentConfig: FrontendDeploymentConfig): Promise<FrontendDeployment> {
    const deploymentId = this.generateId();
    const defaults = FRAMEWORK_DEFAULTS[deploymentConfig.framework];
    const domain = deploymentConfig.domain || `${deploymentId}.${projectRef}.app`;

    const deployment: FrontendDeployment = {
      id: deploymentId,
      project_ref: projectRef,
      name: deploymentConfig.name,
      framework: deploymentConfig.framework,
      domain,
      custom_domains: deploymentConfig.custom_domains || [],
      build_command: deploymentConfig.build_command || defaults.build_command,
      output_dir: deploymentConfig.output_dir || defaults.output_dir,
      install_command: deploymentConfig.install_command || defaults.install_command,
      node_version: deploymentConfig.node_version || defaults.node_version,
      env_vars: deploymentConfig.env_vars || {},
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
      logger.warn("[FrontendService] Failed to delete deployment", { error: err });
      return false;
    }
  }

  // ── Build Pipeline ────────────────────────────────────────────────

  async deployFromSource(
    projectRef: string,
    deploymentId: string,
    sourcePath: string
  ): Promise<FrontendBuildResult> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) {
      return { success: false, deployment_id: deploymentId, url: "", build_log: "", error: "Deployment not found" };
    }

    const deploymentDir = this.joinPath(this.baseDir, projectRef, deploymentId);
    const sourceDir = this.joinPath(deploymentDir, "source");

    try {
      await $`cp -r ${sourcePath}/. ${sourceDir}`.quiet();
      return await this.buildDeployment(projectRef, deploymentId, sourceDir);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.updateDeployment(projectRef, deploymentId, {
        status: "failed",
        build_log: `Error copying source: ${errorMsg}`,
      } as Partial<FrontendDeployment>);

      return { success: false, deployment_id: deploymentId, url: "", build_log: `Error: ${errorMsg}`, error: errorMsg };
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
      return { success: false, deployment_id: deploymentId, url: "", build_log: "", error: "Deployment not found" };
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
      return { success: false, deployment_id: deploymentId, url: "", build_log: "", error: "Deployment not found" };
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
          .env({ ...process.env, ...deployment.env_vars, NODE_VERSION: deployment.node_version })
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
          .env({ ...process.env, ...deployment.env_vars, NODE_VERSION: deployment.node_version })
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

      return { success: true, deployment_id: deploymentId, url: deployment.deployment_url, build_log: buildLog };
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

  // ── Angie (Web Server) Config ─────────────────────────────────────

  async configureAngie(deployment: FrontendDeployment, buildDir: string, isSSR: boolean): Promise<void> {
    const port = 30000 + parseInt(deployment.id, 16) % 10000;
    
    let angieConfig: string;
    
    if (isSSR) {
      angieConfig = `# SSR Frontend: ${deployment.name}
server {
    listen 80;
    listen 443 ssl;
    server_name ${deployment.domain} ${deployment.custom_domains.join(" ")};

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

  // ── SSR Process Management ────────────────────────────────────────

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

    const bunPath = config.bunPath;
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

  // ── Misc ──────────────────────────────────────────────────────────

  async getBuildLog(projectRef: string, deploymentId: string): Promise<string> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    return deployment?.build_log || "";
  }

  // ── Delegated to domain service ───────────────────────────────────

  setEnvVars = (...args: Parameters<FrontendDomainService["setEnvVars"]>) => this.domainService.setEnvVars(...args);
  addCustomDomain = (...args: Parameters<FrontendDomainService["addCustomDomain"]>) => this.domainService.addCustomDomain(...args);
  removeCustomDomain = (...args: Parameters<FrontendDomainService["removeCustomDomain"]>) => this.domainService.removeCustomDomain(...args);
  createDeployToken = (...args: Parameters<FrontendDomainService["createDeployToken"]>) => this.domainService.createDeployToken(...args);
  listDeployTokens = (...args: Parameters<FrontendDomainService["listDeployTokens"]>) => this.domainService.listDeployTokens(...args);
  deleteDeployToken = (...args: Parameters<FrontendDomainService["deleteDeployToken"]>) => this.domainService.deleteDeployToken(...args);
  verifyDeployToken = (...args: Parameters<FrontendDomainService["verifyDeployToken"]>) => this.domainService.verifyDeployToken(...args);
  setGitConfig = (...args: Parameters<FrontendDomainService["setGitConfig"]>) => this.domainService.setGitConfig(...args);

  // ── Delegated to record service ───────────────────────────────────

  createDeploymentRecord = (...args: Parameters<FrontendRecordService["createDeploymentRecord"]>) => this.recordService.createDeploymentRecord(...args);
  updateDeploymentRecord = (...args: Parameters<FrontendRecordService["updateDeploymentRecord"]>) => this.recordService.updateDeploymentRecord(...args);
  listDeploymentRecords = (...args: Parameters<FrontendRecordService["listDeploymentRecords"]>) => this.recordService.listDeploymentRecords(...args);
  getDeploymentRecord = (...args: Parameters<FrontendRecordService["getDeploymentRecord"]>) => this.recordService.getDeploymentRecord(...args);
}

export const frontendService = new FrontendService();
