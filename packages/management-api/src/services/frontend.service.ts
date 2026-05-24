/**
 * Frontend Service — Core deployment lifecycle with blue-green switching
 * 
 * Delegates to:
 * - FrontendDomainService — custom domains, deploy tokens, env vars, git config
 * - FrontendRecordService — deployment records (history/audit trail)
 *
 * This file handles: CRUD, build, Kong routing, process management
 *
 * Deployment flow (blue-green):
 *   build → start process → wait for /healthz readiness → switch Kong route → done
 *   If readiness fails: stop process, do NOT switch route, report failure
 */
import { $ } from "bun";
import { readdir } from "node:fs/promises";
import { logger } from "../utils/logger";
import { config } from "../config";
import type {
  FrontendDeployment,
  FrontendDeploymentConfig,
  FrontendBuildResult,
  FrontendDnsRecord,
} from "../types/frontend";
import {
  FRAMEWORK_DEFAULTS,
} from "../types/frontend";
import { FrontendDomainService } from "./frontend-domain.service";
import { FrontendRecordService } from "./frontend-record.service";

const FRONTEND_BASE_DIR = "/var/supacloud/frontends";
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_INTERVAL_MS = 500;
const UNSAFE_COMMAND_PATTERN = /[\n\r;&|`$<>]/;
const SAFE_GIT_SSH_PATTERN = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+\.git$/;

function assertSafeBuildCommand(command: string): void {
  if (process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS !== "true") return;
  if (command.length > 200 || UNSAFE_COMMAND_PATTERN.test(command)) {
    throw new Error("Build command contains unsupported shell syntax");
  }
}

function assertSafeGitUrl(gitUrl: string): void {
  if (SAFE_GIT_SSH_PATTERN.test(gitUrl)) return;
  let parsed: URL;
  try {
    parsed = new URL(gitUrl);
  } catch {
    throw new Error("Invalid git URL");
  }
  if (!["https:", "http:", "ssh:"].includes(parsed.protocol)) {
    throw new Error("Unsupported git URL protocol");
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") {
    throw new Error("Git URL host is not allowed");
  }
  if (/^(169\.254\.169\.254|metadata\.google\.internal)$/i.test(host)) {
    throw new Error("Git URL metadata service targets are not allowed");
  }
  if (process.env.SUPACLOUD_RESTRICT_GIT_PRIVATE_NETWORKS === "true" && /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)) {
    throw new Error("Git URL private network targets are not allowed");
  }
}

function assertSafeGitBranch(branch: string): void {
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(branch) || branch.includes("..") || branch.startsWith("-")) {
    throw new Error("Invalid git branch");
  }
}

export class FrontendService {
  private baseDir: string;
  private domainService: FrontendDomainService;
  private recordService: FrontendRecordService;

  constructor(baseDir: string = FRONTEND_BASE_DIR) {
    this.baseDir = baseDir;
    this.domainService = new FrontendDomainService(
      baseDir,
      this.getDeployment.bind(this),
      this.configureKongRoute.bind(this),
    );
    this.recordService = new FrontendRecordService(baseDir);
  }

  private joinPath(...parts: string[]): string {
    return parts.join("/").replace(/\/+/g, "/");
  }

  private normalizePath(path: string): string {
    return path.replace(/\/+$/, "");
  }

  private generateId(): string {
    return crypto.randomUUID().substring(0, 8);
  }

  // ── Readiness Gate ──────────────────────────────────────────────

  /**
   * Poll /healthz on the frontend process until it responds 200 or timeout.
   * Returns true if ready, false if timed out.
   */
  private async waitForReadiness(port: number, timeoutMs: number = READINESS_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${port}/healthz`;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          logger.info(`[FrontendService] Readiness confirmed on port ${port}`);
          return true;
        }
      } catch {
        // Process not up yet, retry
      }
      await Bun.sleep(READINESS_INTERVAL_MS);
    }

    logger.error(`[FrontendService] Readiness check timed out on port ${port} after ${timeoutMs}ms`);
    return false;
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  async listDeployments(projectRef: string): Promise<FrontendDeployment[]> {
    const deploymentsDir = this.joinPath(this.baseDir, projectRef);
    const deployments: FrontendDeployment[] = [];

    try {
      const dirs = await readdir(deploymentsDir, { withFileTypes: true });
      
      for (const entry of dirs) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
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

    // Do NOT route traffic yet — route is configured after build + readiness
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
        await this.stopProcess(projectRef, deploymentId);
        await this.removeKongRoute(deployment);
      }
      await $`rm -rf ${deploymentDir}`.quiet();
      return true;
    } catch (err: unknown) {
      logger.warn("[FrontendService] Failed to delete deployment", { error: err });
      return false;
    }
  }

  async listDnsRecords(projectRef: string, deploymentId: string): Promise<FrontendDnsRecord[] | null> {
    const deployment = await this.getDeployment(projectRef, deploymentId);
    if (!deployment) return null;

    const records: FrontendDnsRecord[] = [];
    const apexValue = config.dockerHostIp || config.baseDomain;
    const temporaryHost = deployment.domain || `${deployment.id}.${deployment.project_ref}.app`;

    records.push({
      id: `${deployment.id}-temporary-domain`,
      deployment_id: deployment.id,
      project_ref: deployment.project_ref,
      hostname: temporaryHost,
      type: "A",
      name: temporaryHost,
      value: apexValue,
      status: "managed",
      source: "temporary_domain",
    });

    for (const hostname of deployment.custom_domains) {
      records.push({
        id: `${deployment.id}-${hostname.replace(/[^a-zA-Z0-9-]/g, "-")}`,
        deployment_id: deployment.id,
        project_ref: deployment.project_ref,
        hostname,
        type: "CNAME",
        name: hostname,
        value: temporaryHost,
        status: "expected",
        source: "custom_domain",
      });
    }

    return records;
  }

  // ── Build Pipeline (blue-green) ────────────────────────────────

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
      const sameSource = this.normalizePath(sourcePath) === this.normalizePath(sourceDir);
      if (!sameSource) {
        await $`rm -rf ${sourceDir}`.quiet();
        await $`mkdir -p ${sourceDir}`.quiet();
        await $`cp -r ${sourcePath}/. ${sourceDir}`.quiet();
      }
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
      assertSafeGitUrl(gitUrl);
      assertSafeGitBranch(branch);
      await this.domainService.setGitConfig(projectRef, deploymentId, gitUrl, branch);
      await this.updateDeployment(projectRef, deploymentId, {
        status: "building",
      } as Partial<FrontendDeployment>);

      await $`rm -rf ${sourceDir}`.quiet();

      buildLog += `$ git clone --branch ${branch} ${gitUrl}\n`;
      const cloneResult = await $`git clone --branch ${branch} --depth 1 ${gitUrl} ${sourceDir}`
        .env({
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "echo",
        })
        .quiet();
      buildLog += cloneResult.stdout.toString();
      buildLog += cloneResult.stderr.toString();
      buildLog += "\n";

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

  /**
   * Blue-green build: build → start process → readiness gate → switch Kong route
   * If readiness fails, stop process and do NOT switch route.
   */
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
        assertSafeBuildCommand(deployment.install_command);
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
        assertSafeBuildCommand(deployment.build_command);
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

      // Blue-green: start process FIRST, but do NOT route traffic yet
      const port = await this.startProcess(projectRef, deploymentId, deployment, buildDir, defaults.is_ssr);

      // Readiness gate: wait for /healthz before switching Kong route
      const ready = await this.waitForReadiness(port);
      if (!ready) {
        // Rollback: stop the process, leave Kong pointing at old state (or nothing)
        logger.error(`[FrontendService] Readiness failed for ${projectRef}/${deploymentId}, stopping process`);
        await this.stopProcess(projectRef, deploymentId);
        throw new Error(`Frontend process failed readiness check on port ${port} within ${READINESS_TIMEOUT_MS}ms`);
      }

      // Process is healthy — NOW switch Kong route
      await this.configureKongRoute(deployment, buildDir, defaults.is_ssr);

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

  // ── Kong (Web Server) Config ─────────────────────────────────────

  async configureKongRoute(deployment: FrontendDeployment, buildDir: string, isSSR: boolean): Promise<void> {
    const port = 30000 + parseInt(deployment.id, 16) % 10000;
    
    const hosts = [deployment.domain, ...deployment.custom_domains];
    const serviceName = `svc-frontend-${deployment.project_ref}-${deployment.id}`;
    const routeName = `route-frontend-${deployment.project_ref}-${deployment.id}`;

    const { gatewayService } = await import("./gateway.service");
    await gatewayService.addCorsOriginsForHosts(deployment.project_ref, hosts);

    await gatewayService['kongRequest'](`/services/${serviceName}`, 'PUT', {
        name: serviceName,
        url: `http://127.0.0.1:${port}`,
        connect_timeout: 5000,
        read_timeout: 60000,
        write_timeout: 60000
    });

    await gatewayService['kongRequest'](`/routes/${routeName}`, 'PUT', {
        name: routeName,
        service: { name: serviceName },
        paths: ["/"],
        hosts: hosts.length > 0 ? hosts : undefined,
        strip_path: false,
        preserve_host: true
    });
  }

  private async removeKongRoute(deployment: FrontendDeployment): Promise<void> {
    const serviceName = `svc-frontend-${deployment.project_ref}-${deployment.id}`;
    const routeName = `route-frontend-${deployment.project_ref}-${deployment.id}`;
    
    const { gatewayService } = await import("./gateway.service");

    try {
        await gatewayService['kongRequest'](`/routes/${routeName}`, 'DELETE');
        await gatewayService['kongRequest'](`/services/${serviceName}`, 'DELETE');
    } catch (e: unknown) { logger.debug("suppressed error removing route", { error: String(e) }); }
  }


  // ── Process Management (static vs SSR) ──────────────────────────

  /**
   * Start the frontend process (static or SSR) and return the port.
   * Static: supacloud static-serve (binary-backed, /healthz built-in)
   * SSR: bun run buildDir/index.js (user must expose /healthz or rely on process start)
   */
  private async startProcess(
    projectRef: string,
    deploymentId: string,
    deployment: FrontendDeployment,
    buildDir: string,
    isSSR: boolean
  ): Promise<number> {
    const port = 30000 + parseInt(deploymentId, 16) % 10000;
    const serviceName = `supacloud-frontend-${projectRef}-${deploymentId}`;

    const envFile = this.joinPath(this.baseDir, projectRef, deploymentId, ".env");
    const envContent = Object.entries(deployment.env_vars)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    await Bun.write(envFile, envContent);

    const bunPath = config.bunPath;
    let systemdUnit: string;

    if (isSSR) {
      // SSR: user framework handles HTTP; rely on process startup for readiness
      systemdUnit = `[Unit]
Description=SupaCloud Frontend SSR: ${deployment.name} (${projectRef}/${deploymentId})
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${buildDir}
Environment="PORT=${port}"
Environment="NODE_ENV=production"
EnvironmentFile=-/etc/supabase/management-api.env
EnvironmentFile=${envFile}
ExecStart=${bunPath} run ${buildDir}/index.js
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;
    } else {
      // Static: binary-backed static-serve with built-in /healthz
      systemdUnit = `[Unit]
Description=SupaCloud Frontend Static: ${deployment.name} (${projectRef}/${deploymentId})
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${buildDir}
Environment="PORT=${port}"
Environment="NODE_ENV=production"
EnvironmentFile=-/etc/supabase/management-api.env
EnvironmentFile=${envFile}
ExecStart=${config.supacloudBinaryPath} static-serve ${buildDir} ${port} --workers=auto
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;
    }

    const servicePath = `/etc/systemd/system/${serviceName}.service`;
    await Bun.write(servicePath, systemdUnit);

    await $`systemctl daemon-reload`.quiet();
    await $`systemctl enable ${serviceName}`.quiet();
    await $`systemctl restart ${serviceName}`.quiet();

    return port;
  }

  private async stopProcess(projectRef: string, deploymentId: string): Promise<void> {
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
