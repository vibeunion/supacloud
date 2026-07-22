/**
 * Frontend Service — Core deployment lifecycle with blue-green switching
 * 
 * Delegates to:
 * - FrontendDomainService — custom domains, deploy tokens, env vars, git config
 * - FrontendRecordService — deployment records (history/audit trail)
 *
 * This file handles: CRUD, build, gateway routing, process management
 *
 * Deployment flow:
 *   static on Caddy: build -> precompress -> switch file_server route
 *   SSR: build -> start process -> readiness -> switch proxy route
 */
import { $ } from "bun";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
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
import {
  assertSystemdValue,
  prepareSvelteKitRuntime,
  renderSvelteKitSystemdUnit,
} from "./frontend-runtime";
import { installManagedSystemdUnit, removeManagedSystemdUnit } from "./systemd-unit-broker";
import { tenantRuntimeService } from "./tenant-runtime.service";

const FRONTEND_BASE_DIR = "/var/supacloud/frontends";
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_INTERVAL_MS = 500;
const UNSAFE_COMMAND_PATTERN = /[\n\r;&|`$<>]/;
const SAFE_GIT_SSH_PATTERN = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+\.git$/;
const STATIC_PRECOMPRESS_MIN_BYTES = 1024;
const STATIC_PRECOMPRESS_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
  ".xml",
]);
const STATIC_IMAGE_OPTIMIZE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

function normalizeHealthCheckPath(value: string | undefined): string {
  const path = value?.trim() || "/";
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) {
    throw new Error("Health check path must be an absolute path on the frontend origin");
  }
  const url = new URL(path, "http://127.0.0.1");
  if (url.origin !== "http://127.0.0.1") {
    throw new Error("Health check path must stay on the frontend origin");
  }
  return `${url.pathname}${url.search}`;
}

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
      this.configureGatewayRoute.bind(this),
    );
    this.recordService = new FrontendRecordService(baseDir);
  }

  private joinPath(...parts: string[]): string {
    return parts.join("/").replace(/\/+/g, "/");
  }

  private normalizePath(path: string): string {
    return path.replace(/\/+$/, "");
  }

  private getExtension(path: string): string {
    const basename = path.split("/").pop() || "";
    const dot = basename.lastIndexOf(".");
    return dot >= 0 ? basename.slice(dot).toLowerCase() : "";
  }

  private shouldPrecompressStaticFile(path: string, size: number): boolean {
    if (size < STATIC_PRECOMPRESS_MIN_BYTES) return false;
    if (path.endsWith(".br") || path.endsWith(".gz") || path.endsWith(".zst") || path.endsWith(".avif") || path.endsWith(".webp")) return false;
    return STATIC_PRECOMPRESS_EXTENSIONS.has(this.getExtension(path));
  }

  private shouldOptimizeStaticImage(path: string, size: number): boolean {
    if (size < STATIC_PRECOMPRESS_MIN_BYTES) return false;
    if (path.endsWith(".avif") || path.endsWith(".webp")) return false;
    return STATIC_IMAGE_OPTIMIZE_EXTENSIONS.has(this.getExtension(path));
  }

  private generateId(): string {
    return crypto.randomUUID().substring(0, 8);
  }

  // ── Readiness Gate ──────────────────────────────────────────────

  /**
   * Poll the configured path until the frontend process returns a non-5xx response.
   * Returns true if ready, false if timed out.
   */
  private async waitForReadiness(
    port: number,
    healthCheckPath: string,
    timeoutMs: number = READINESS_TIMEOUT_MS,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${port}${normalizeHealthCheckPath(healthCheckPath)}`;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.status < 500) {
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

  async reconcileGatewayRoutes(projectRef?: string): Promise<{ total: number; configured: number; skipped: number; errors: string[] }> {
    const errors: string[] = [];
    let total = 0;
    let configured = 0;
    let skipped = 0;

    let projectRefs: string[] = [];
    if (projectRef) {
      projectRefs = [projectRef];
    } else {
      try {
        const entries = await readdir(this.baseDir, { withFileTypes: true });
        projectRefs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch (error: unknown) {
        const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
        if (code === "ENOENT") {
          return { total, configured, skipped, errors };
        }
        return {
          total,
          configured,
          skipped,
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
    }

    for (const ref of projectRefs) {
      const deployments = await this.listDeployments(ref);
      for (const deployment of deployments) {
        total++;
        if (deployment.status !== "success") {
          skipped++;
          continue;
        }

        const buildDir = this.joinPath(this.baseDir, ref, deployment.id, "build");
        const buildStat = await stat(buildDir).catch(() => null);
        if (!buildStat?.isDirectory()) {
          skipped++;
          continue;
        }

        const defaults = FRAMEWORK_DEFAULTS[deployment.framework];
        try {
          await this.configureGatewayRoute(deployment, buildDir, defaults.is_ssr);
          configured++;
        } catch (error: unknown) {
          errors.push(`${ref}/${deployment.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return { total, configured, skipped, errors };
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
      health_check_path: normalizeHealthCheckPath(
        deploymentConfig.health_check_path || defaults.health_check_path,
      ),
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

    const definedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    ) as Partial<FrontendDeploymentConfig>;
    const normalizedUpdates = definedUpdates.health_check_path === undefined
      ? definedUpdates
      : {
          ...definedUpdates,
          health_check_path: normalizeHealthCheckPath(definedUpdates.health_check_path),
        };
    const updated = {
      ...deployment,
      ...normalizedUpdates,
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
        await this.removeGatewayRoute(deployment);
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
   * Blue-green build: build → start process → readiness gate → switch gateway route
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
      if (deployment.framework === "sveltekit") {
        await prepareSvelteKitRuntime(sourceDir, buildDir);
      }
      if (!defaults.is_ssr) {
        await this.precompressStaticAssets(buildDir);
      }

      if (defaults.is_ssr) {
        // Blue-green: start process FIRST, but do NOT route traffic yet
        const port = await this.startProcess(projectRef, deploymentId, deployment, buildDir, defaults.is_ssr);

        const ready = await this.waitForReadiness(port, deployment.health_check_path || defaults.health_check_path);
        if (!ready) {
          // Rollback: stop the process, leave the gateway pointing at old state (or nothing)
          logger.error(`[FrontendService] Readiness failed for ${projectRef}/${deploymentId}, stopping process`);
          await this.stopProcess(projectRef, deploymentId);
          throw new Error(`Frontend process failed readiness check on port ${port} within ${READINESS_TIMEOUT_MS}ms`);
        }
      }

      // Static Caddy routes serve buildDir directly; process-backed routes proxy after readiness.
      await this.configureGatewayRoute(deployment, buildDir, defaults.is_ssr);

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

  // ── Gateway (Web Server) Config ───────────────────────────────────

  async configureGatewayRoute(deployment: FrontendDeployment, buildDir: string, isSSR: boolean): Promise<void> {
    const port = 30000 + parseInt(deployment.id, 16) % 10000;
    const hosts = [deployment.domain, ...deployment.custom_domains];

    const { gatewayService } = await import("./gateway.service");
    await gatewayService.configureFrontendRoute({
      projectRef: deployment.project_ref,
      deploymentId: deployment.id,
      hosts,
      port: isSSR ? port : undefined,
      root: isSSR ? undefined : buildDir,
      mode: isSSR ? "proxy" : "static",
    });
  }

  private async removeGatewayRoute(deployment: FrontendDeployment): Promise<void> {
    const { gatewayService } = await import("./gateway.service");

    try {
        await gatewayService.removeFrontendRoute(deployment.project_ref, deployment.id);
    } catch (e: unknown) { logger.debug("suppressed error removing route", { error: String(e) }); }
  }


  // ── Process Management (SSR only) ───────────────────────────────

  /**
   * Start the frontend process and return the port.
   * SvelteKit SSR uses the official adapter-node entrypoint. Other legacy SSR
   * framework profiles keep their existing Bun launch behavior.
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
    const runtimeUser = await tenantRuntimeService.ensureTenantRuntimeUser(projectRef);
    const description = assertSystemdValue(`${deployment.name} (${projectRef}/${deploymentId})`, "Description");

    const envFile = this.joinPath(this.baseDir, projectRef, deploymentId, ".env");
    const envContent = Object.entries(deployment.env_vars)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    await Bun.write(envFile, envContent);
    await $`chown ${runtimeUser}:${runtimeUser} ${envFile}`.quiet();
    await $`chmod 600 ${envFile}`.quiet();

    if (!isSSR) {
      throw new Error("Static frontend deployments are served directly by Caddy");
    }

    const systemdUnit = deployment.framework === "sveltekit"
      ? renderSvelteKitSystemdUnit({
          serviceName,
          runtimeUser,
          description,
          buildDir,
          envFile,
          port,
        })
      : `[Unit]
Description=SupaCloud Frontend SSR: ${description}
After=network.target

[Service]
Type=simple
User=${runtimeUser}
Group=${runtimeUser}
WorkingDirectory=${buildDir}
NoNewPrivileges=true
Environment="PORT=${port}"
Environment="NODE_ENV=production"
EnvironmentFile=-/etc/supabase/management-api.env
EnvironmentFile=${envFile}
ExecStart=${config.bunPath} run ${buildDir}/index.js
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;

    await installManagedSystemdUnit(`${serviceName}.service`, systemdUnit);

    await $`systemctl daemon-reload`.quiet();
    await $`systemctl enable ${serviceName}`.quiet();
    await $`systemctl restart ${serviceName}`.quiet();

    return port;
  }

  private async stopProcess(projectRef: string, deploymentId: string): Promise<void> {
    const serviceName = `supacloud-frontend-${projectRef}-${deploymentId}`;
    
    await $`systemctl stop ${serviceName}`.nothrow().quiet();
    await $`systemctl disable ${serviceName}`.nothrow().quiet();
    await removeManagedSystemdUnit(`${serviceName}.service`);
  }

  private async precompressStaticAssets(root: string): Promise<void> {
    const availableCommands = new Map<string, string | null>();
    const resolveCommand = async (command: string): Promise<string | null> => {
      if (availableCommands.has(command)) return availableCommands.get(command) || null;
      const result = await $`which ${command}`.nothrow().quiet();
      const resolved = result.exitCode === 0 ? result.stdout.toString().trim().split("\n")[0] || null : null;
      availableCommands.set(command, resolved);
      return resolved;
    };

    const compressFile = async (filePath: string) => {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || !this.shouldPrecompressStaticFile(filePath, fileStat.size)) return;

      const input = await readFile(filePath);
      await writeFile(`${filePath}.gz`, gzipSync(input, { level: 9 }));
      await writeFile(`${filePath}.br`, brotliCompressSync(input, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        },
      }));

      const zstdPath = await resolveCommand("zstd");
      if (zstdPath) {
        const result = await $`${zstdPath} -q -f -19 -o ${filePath}.zst -- ${filePath}`.nothrow().quiet();
        if (result.exitCode !== 0) {
          logger.warn("[FrontendService] Failed to generate zstd sidecar", { path: filePath, stderr: result.stderr.toString() });
        }
      }
    };

    const optimizeImage = async (filePath: string) => {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || !this.shouldOptimizeStaticImage(filePath, fileStat.size)) return;

      const cwebpPath = await resolveCommand("cwebp");
      if (cwebpPath) {
        const result = await $`${cwebpPath} -quiet -q 82 ${filePath} -o ${filePath}.webp`.nothrow().quiet();
        if (result.exitCode !== 0) {
          logger.warn("[FrontendService] Failed to generate webp sidecar", { path: filePath, stderr: result.stderr.toString() });
        }
      }

      const avifencPath = await resolveCommand("avifenc");
      if (avifencPath) {
        const result = await $`${avifencPath} --quiet --min 28 --max 38 --speed 6 ${filePath} ${filePath}.avif`.nothrow().quiet();
        if (result.exitCode !== 0) {
          logger.warn("[FrontendService] Failed to generate avif sidecar", { path: filePath, stderr: result.stderr.toString() });
        }
      }
    };

    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = this.joinPath(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          await optimizeImage(fullPath);
          await compressFile(fullPath);
        }
      }
    };

    try {
      await walk(root);
    } catch (error: unknown) {
      logger.warn("[FrontendService] Failed to precompress static assets", { error });
    }
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
